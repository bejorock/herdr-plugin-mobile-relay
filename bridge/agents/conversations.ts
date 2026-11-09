import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentInfo } from "../herdr-client.ts";
import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import { findClaudeTranscriptBySessionId, readSafeClaudeTranscript } from "./claude-transcript.ts";
import { readSafePiTranscript } from "./pi-transcript.ts";
import { executableEvidence } from "./launcher-discovery.ts";
import { PromptJournal, type PromptResult } from "./prompt-journal.ts";
import { HerdrRpcError } from "../wire.ts";

export class LifecycleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
type Kind = "pi" | "claude";
type Native = { source: string; kind: "id" | "path"; value: string };
interface Record {
  id: string; session: string; kind: Kind; cwd: string; requestId: string;
  native?: Native; paneId?: string; workspaceId?: string;
  /** Persisted before starting in this pane; ambiguous attempts must be reconciled, not repeated. */
  launchPaneId?: string;
  /** Reserving precedes creating terminal structure; interrupted allocation requires inspection. */
  phase: "allocating" | "launching" | "bound";
}
export interface Conversation {
  id: string; session: string; kind: Kind; cwd: string; paneId: string | null;
  status: "live" | "closed" | "unavailable" | "starting";
}
const ID = /^conversation_[0-9a-f-]{36}$/;
export const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
function validRecord(value: unknown): value is Record {
  if (!value || typeof value !== "object") return false;
  const r = value as Record;
  return typeof r.id === "string" && ID.test(r.id) && typeof r.session === "string" && r.session.length > 0 && r.session.length <= 128 &&
    (r.kind === "pi" || r.kind === "claude") && typeof r.cwd === "string" && isAbsolute(r.cwd) && r.cwd.length <= 4096 &&
    typeof r.requestId === "string" && REQUEST_ID.test(r.requestId) && ["allocating", "launching", "bound"].includes(r.phase) &&
    [r.paneId, r.workspaceId, r.launchPaneId].every((v) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 256)) &&
    (r.native === undefined || (typeof r.native.source === "string" && r.native.source.length > 0 && r.native.source.length <= 128 &&
      ["id", "path"].includes(r.native.kind) && typeof r.native.value === "string" && r.native.value.length > 0 && r.native.value.length <= 4096 &&
      (r.kind === "pi" ? r.native.kind === "path" && isAbsolute(r.native.value) : r.native.kind === "id" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.native.value)))) &&
    (r.phase !== "bound" || !!r.native);
}

/** Fail-closed private journal: write before memory commit; never acknowledge a swallowed save. */
export class ConversationStore {
  private records = new Map<string, Record>();
  readonly path: string;
  constructor(stateDir: string, private readonly capacity = 10_000) {
    this.path = join(stateDir, "conversations.json");
    if (!existsSync(this.path)) return;
    try {
      const info = lstatSync(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error();
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.conversations) || data.conversations.length > capacity || !data.conversations.every(validRecord)) throw new Error();
      const keys = new Set<string>();
      for (const r of data.conversations as Record[]) {
        const key = JSON.stringify([r.session, r.requestId]);
        if (this.records.has(r.id) || keys.has(key)) throw new Error();
        keys.add(key); this.records.set(r.id, r);
      }
    } catch { throw new LifecycleError(500, "persistence_failed", "Conversation store is invalid; operator intervention required"); }
  }
  get(id: string): Record | undefined { const r = this.records.get(id); return r ? structuredClone(r) : undefined; }
  byNative(session: string, agent: string, native: Native): Record | undefined {
    const record = [...this.records.values()].find((r) => r.session === session && r.kind === agent && r.native?.source === native.source && r.native.kind === native.kind && r.native.value === native.value);
    return record ? structuredClone(record) : undefined;
  }
  byRequest(session: string, requestId: string): Record | undefined {
    const r = [...this.records.values()].find((r) => r.session === session && r.requestId === requestId);
    return r ? structuredClone(r) : undefined;
  }
  save(record: Record): void {
    if (!validRecord(record)) throw new LifecycleError(500, "persistence_failed", "Invalid private conversation record");
    if (!this.records.has(record.id) && this.records.size >= this.capacity) throw new LifecycleError(503, "capacity_exceeded", "Conversation store is full");
    const next = new Map(this.records); next.set(record.id, structuredClone(record));
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const text = JSON.stringify({ version: 1, conversations: [...next.values()] }) + "\n";
      if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Journal size limit");
      writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600); renameSync(tmp, this.path);
    } catch {
      try { unlinkSync(tmp); } catch {}
      throw new LifecycleError(500, "persistence_failed", "Could not persist conversation state");
    }
    this.records = next;
  }
}

export interface NativeAccess {
  cwd(path: string): Promise<string>;
  validate(kind: Kind, native: Native, cwd: string): Promise<void>;
  pause(): Promise<void>;
}
export const nativeConversationAccess: NativeAccess = {
  async cwd(path) {
    try {
      const resolved = await realpath(path);
      if (!(await stat(resolved)).isDirectory()) throw new Error();
      await access(resolved, constants.X_OK);
      return resolved;
    } catch { throw new LifecycleError(400, "invalid_cwd", "cwd must be an accessible existing directory"); }
  },
  async validate(kind, native, cwd) {
    try {
      const text = kind === "pi" ? await readSafePiTranscript(native.value) : await readSafeClaudeTranscript(await findClaudeTranscriptBySessionId(native.value));
      // Safe location alone is insufficient: reject empty or mismatched native session data.
      const lines = text.split("\n").filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } });
      const matching = kind === "pi"
        ? lines.filter((entry) => entry?.type === "session" && typeof entry.id === "string")
        : lines.filter((entry) => entry?.sessionId === native.value);
      if (!matching.length || !matching.some((entry) => entry.cwd === cwd)) throw new Error();
    } catch { throw new LifecycleError(404, "native_session_missing", "Saved native conversation is missing or cannot be validated"); }
  },
  pause: () => Bun.sleep(100),
};

export class ConversationService {
  private readonly operations = new Map<string, Promise<unknown>>();
  private prompts?: PromptJournal;
  constructor(private readonly sessions: SessionRegistry, private readonly store: ConversationStore, private readonly nativeAccess = nativeConversationAccess, private readonly agentPath?: string[]) {}

  runtime(name?: string): SessionRuntime {
    const runtime = this.sessions.get(name);
    if (!runtime) throw new LifecycleError(404, "runtime_unknown", "Unknown Herdr runtime");
    if (runtime.engine.current().bridge !== "connected") throw new LifecycleError(503, "runtime_unavailable", "Herdr runtime is unavailable");
    return runtime;
  }
  async discover(name?: string) {
    const runtime = this.runtime(name);
    try {
      const entries = await runtime.herdr.listIntegrations();
      let running: Awaited<ReturnType<SessionRuntime["herdr"]["listAgentBindings"]>> = [];
      try { running = await runtime.herdr.listAgentBindings(); } catch {}
      const agents = await Promise.all((["pi", "claude"] as const).map(async (kind) => {
        const entry = entries.find((e) => e.target === kind);
        for (const pane of running.filter((pane) => pane.agent === kind && pane.nativeSession)) {
          try {
            const live = await runtime.herdr.getAgent(pane.paneId);
            if (live.agent === kind && live.agentSession?.value === pane.nativeSession?.value && live.agentSession?.kind === pane.nativeSession?.kind && live.agentSession?.source === pane.nativeSession?.source && live.interactiveReady && !live.launchPending) return { kind, availability: "available", version: null, reason: null };
          } catch {}
        }
        const inspected = this.agentPath ? await executableEvidence(kind, this.agentPath) : undefined;
        const availability = inspected ?? (entry?.available === true && entry.state === "not_installed" ? "available" : entry?.available === false ? "unavailable" : "unknown");
        return { kind, availability, version: null, reason: availability === "available" ? null : availability === "unavailable" ? "executable_not_found" : "launchability_unverified" };
      }));
      return { session: runtime.name, agents };
    } catch { throw new LifecycleError(503, "discovery_unavailable", "Herdr harness discovery is unavailable"); }
  }
  async create(input: { session?: string; kind: Kind; cwd: string; requestId: string }): Promise<Conversation> {
    const runtime = this.runtime(input.session);
    const cwd = await this.canonicalCwd(input.cwd);
    const key = `create:${JSON.stringify([runtime.name, input.requestId])}`;
    // Check signature before joining a concurrent operation, not after it commits.
    const prior = this.store.byRequest(runtime.name, input.requestId);
    if (prior && (prior.kind !== input.kind || prior.cwd !== cwd)) throw new LifecycleError(409, "request_id_conflict", "requestId was used with different creation parameters");
    return this.serial(key, async () => {
      let record = this.store.byRequest(runtime.name, input.requestId);
      if (record) {
        if (record.kind !== input.kind || record.cwd !== cwd) throw new LifecycleError(409, "request_id_conflict", "requestId was used with different creation parameters");
        if (record.native) return this.inspect(record);
        // With no saved native reference, an occupant in the old pane cannot prove it is the
        // original launch rather than a replacement. Fail closed; never adopt by pane ID alone.
        throw new LifecycleError(409, "create_pending", "An earlier creation requires inspection; it will not be launched again");
      }
      record = { id: `conversation_${randomUUID()}`, session: runtime.name, kind: input.kind, cwd, requestId: input.requestId, phase: "allocating" };
      this.store.save(record);
      return this.launch(runtime, record, false);
    }, false);
  }
  async get(id: string, session?: string): Promise<Conversation> {
    const record = this.record(id, session);
    return this.inspect(record);
  }
  async resume(id: string, cwd: string, session?: string): Promise<Conversation> {
    const initial = this.record(id, session);
    const canonical = await this.canonicalCwd(cwd);
    if (canonical !== initial.cwd) throw new LifecycleError(400, "cwd_mismatch", "cwd does not match the saved conversation");
    return this.serial(`conversation:${id}`, async () => {
      const record = this.record(id, session);
      const runtime = this.runtime(record.session);
      if (!record.native) throw new LifecycleError(409, "create_pending", "Native creation is unresolved");
      const live = await this.findLive(runtime, record);
      if (live) return this.attachBinding(record, live);
      if (record.phase !== "bound") throw new LifecycleError(409, "restore_pending", "A previous restoration is unresolved; inspect its pane before retrying");
      await this.nativeAccess.validate(record.kind, record.native, record.cwd);
      // Persist uncertainty BEFORE allocating a replacement. Crash/retry cannot launch twice.
      record.phase = "allocating"; record.launchPaneId = undefined; this.store.save(record);
      return this.launch(runtime, record, true);
    }, true);
  }
  async attach(input: { session?: string; paneId: string; kind: Kind; cwd: string }): Promise<Conversation> {
    const runtime = this.runtime(input.session);
    const cwd = await this.canonicalCwd(input.cwd);
    let agent: AgentInfo;
    try { agent = await runtime.herdr.getAgent(input.paneId); }
    catch { throw new LifecycleError(404, "agent_not_found", "Existing agent was not found"); }
    if (agent.agent !== input.kind || !agent.agentSession || agent.agentSession.agent !== input.kind) throw new LifecycleError(409, "native_identity_mismatch", "Existing agent does not match the requested harness or has no native session");
    if (!agent.interactiveReady || agent.launchPending) throw new LifecycleError(409, "agent_not_ready", "Existing agent is not ready for attachment");
    if (await this.canonicalCwd(agent.cwd) !== cwd) throw new LifecycleError(400, "cwd_mismatch", "cwd does not match the existing agent");
    return this.attachNative(runtime.name, input.paneId, input.kind, agent.agentSession);
  }
  async prompt(id: string, text: string, requestId: string, session?: string): Promise<PromptResult> {
    if (typeof text !== "string" || !text.trim() || text.includes("\0") || Buffer.byteLength(text) > 128 * 1024 || !REQUEST_ID.test(requestId)) throw new LifecycleError(400, "invalid_request", "Nonempty bounded prompt text and requestId are required");
    this.record(id, session);
    this.prompts ??= new PromptJournal(join(this.store.path, ".."));
    const journal = this.prompts; const hash = PromptJournal.hash(text);
    return this.serial(`conversation:${id}`, async () => {
      const prior = journal.prior(id, requestId, hash); if (prior) return prior;
      const record = this.record(id, session); const runtime = this.runtime(record.session);
      const live = await this.findLive(runtime, record);
      if (!live || !record.native) throw new LifecycleError(409, "conversation_closed", "Resume the saved conversation explicitly before prompting");
      journal.reserve(id, requestId, hash);
      try {
        await runtime.herdr.promptAgent(live.paneId, text);
        await this.verifyNative(record.session, live.paneId, record.kind, record.native);
      } catch (error) {
        const code = error instanceof HerdrRpcError ? error.code : undefined;
        if (code && ["agent_blocked", "agent_not_ready", "agent_not_found", "empty_agent_prompt"].includes(code)) {
          const failure = new LifecycleError(409, code, "Herdr rejected prompt before delivery; inspect current agent state");
          journal.failed(id, requestId, hash, failure); throw failure;
        }
        throw new LifecycleError(409, "prompt_delivery_unconfirmed", "Prompt may have been delivered; inspect transcript before any new request");
      }
      return journal.delivered(id, requestId, hash);
    }, false);
  }
  /** Bind a verified live hook to a durable conversation, without launching or prompting. */
  async attachNative(session: string, paneId: string, kind: string, native: Native): Promise<Conversation> {
    if (kind !== "pi" && kind !== "claude") throw new LifecycleError(400, "invalid_request", "Unsupported native harness");
    return this.serial(`attach:${JSON.stringify([session, kind, native.source, native.kind, native.value])}`, async () => {
    const runtime = this.runtime(session);
    let agent: AgentInfo;
    try { agent = await runtime.herdr.getAgent(paneId); }
    catch { throw new LifecycleError(409, "interaction_stale", "Native requester is no longer live"); }
    const actual = agent.agentSession;
    if (agent.agent !== kind || !actual || actual.agent !== kind || actual.source !== native.source || actual.kind !== native.kind || actual.value !== native.value) {
      throw new LifecycleError(409, "interaction_stale", "Native requester identity changed");
    }
    const cwd = await this.canonicalCwd(agent.cwd);
    let record = this.store.byNative(session, kind, native);
    if (record && record.cwd !== cwd) throw new LifecycleError(409, "interaction_stale", "Native requester cwd changed");
    if (!record) record = { id: `conversation_${randomUUID()}`, session, kind, cwd, native, requestId: `hook:${randomUUID()}`, phase: "bound" };
    return this.attachBinding(record, agent);
    }, false);
  }
  async verifyNative(session: string, paneId: string, kind: string, native: Native): Promise<void> {
    const runtime = this.runtime(session);
    let agent: AgentInfo;
    try { agent = await runtime.herdr.getAgent(paneId); }
    catch { throw new LifecycleError(409, "interaction_stale", "Native requester is no longer live"); }
    const actual = agent.agentSession;
    if (agent.agent !== kind || !actual || actual.source !== native.source || actual.kind !== native.kind || actual.value !== native.value) {
      throw new LifecycleError(409, "interaction_stale", "Native requester identity changed");
    }
  }
  /** Private adapter access only; never serialize this native handle to HTTP clients. */
  transcriptBinding(id: string, session?: string): { id: string; kind: Kind; cwd: string; native: Native } {
    const record = this.record(id, session);
    if (!record.native) throw new LifecycleError(409, "create_pending", "Native conversation identity is not established");
    return { id: record.id, kind: record.kind, cwd: record.cwd, native: record.native };
  }
  private record(id: string, session?: string): Record {
    const record = this.store.get(id);
    if (!record) throw new LifecycleError(404, "conversation_unknown", "Unknown conversation");
    if (session !== undefined && session !== record.session) throw new LifecycleError(400, "runtime_mismatch", "Conversation belongs to a different runtime");
    return record;
  }
  private async canonicalCwd(cwd: string) {
    if (typeof cwd !== "string" || cwd.length > 4096 || cwd.includes("\0") || !isAbsolute(cwd)) throw new LifecycleError(400, "invalid_cwd", "cwd must be absolute");
    return this.nativeAccess.cwd(cwd);
  }
  private async serial<T>(key: string, operation: () => Promise<T>, share: boolean): Promise<T> {
    const existing = this.operations.get(key);
    if (existing) {
      if (share) return await existing as T;
      await existing.catch(() => {});
      return this.serial(key, operation, share);
    }
    const promise = Promise.resolve().then(operation);
    this.operations.set(key, promise);
    try { return await promise; } finally { if (this.operations.get(key) === promise) this.operations.delete(key); }
  }
  private public(record: Record, status: Conversation["status"], paneId: string | null = null): Conversation {
    return { id: record.id, session: record.session, kind: record.kind, cwd: record.cwd, paneId, status };
  }
  private async inspect(record: Record): Promise<Conversation> {
    const runtime = this.sessions.get(record.session);
    if (!runtime || runtime.engine.current().bridge !== "connected") return this.public(record, "unavailable");
    if (!record.native) return this.public(record, "starting", record.launchPaneId ?? null);
    const live = await this.findLive(runtime, record);
    return live ? this.attachBinding(record, live) : this.public(record, record.phase === "bound" ? "closed" : "starting", record.launchPaneId ?? null);
  }
  private matches(record: Record, agent: { agent: string | null; nativeSession?: Native }): boolean {
    return !!record.native && agent.agent === record.kind && agent.nativeSession?.source === record.native.source &&
      agent.nativeSession.kind === record.native.kind && agent.nativeSession.value === record.native.value;
  }
  private async findLive(runtime: SessionRuntime, record: Record): Promise<{ paneId: string; workspaceId: string; cwd: string } | undefined> {
    let panes;
    try { panes = await runtime.herdr.listAgentBindings(); }
    catch { throw new LifecycleError(503, "runtime_unavailable", "Could not inspect live Herdr agents"); }
    const matches = panes.filter((pane) => this.matches(record, pane));
    if (matches.length > 1) throw new LifecycleError(409, "native_session_ambiguous", "Multiple panes report this native conversation");
    const pane = matches[0];
    if (!pane) return undefined;
    // Query readiness/current identity again: a stale session report in an exited pane is not live.
    let agent: AgentInfo;
    try { agent = await runtime.herdr.getAgent(pane.paneId); }
    catch { throw new LifecycleError(503, "runtime_unavailable", "Could not confirm live native identity"); }
    if (!this.matches(record, { agent: agent.agent, nativeSession: agent.agentSession })) return undefined;
    if (!agent.interactiveReady || agent.launchPending) throw new LifecycleError(409, "restore_pending", "Matching native agent is not ready; it will not be duplicated");
    if (await this.canonicalCwd(agent.cwd) !== record.cwd) throw new LifecycleError(409, "native_identity_mismatch", "Live conversation cwd differs from saved cwd");
    return { paneId: agent.paneId, workspaceId: agent.workspaceId, cwd: agent.cwd };
  }
  private attachBinding(record: Record, pane: { paneId: string; workspaceId: string }): Conversation {
    if (record.paneId !== pane.paneId || record.phase !== "bound") {
      record.paneId = pane.paneId; record.workspaceId = pane.workspaceId; record.phase = "bound"; record.launchPaneId = undefined;
      this.store.save(record);
    }
    return this.public(record, "live", pane.paneId);
  }
  private async accept(record: Record, agent: AgentInfo): Promise<Conversation> {
    const native = agent.agentSession;
    if (agent.agent !== record.kind || !native || native.agent !== record.kind ||
      (record.kind === "pi" ? native.kind !== "path" : native.kind !== "id") ||
      (record.native && !this.matches(record, { agent: agent.agent, nativeSession: native }))) {
      throw new LifecycleError(409, "native_identity_mismatch", "Agent did not confirm the requested native conversation");
    }
    if (await this.canonicalCwd(agent.cwd) !== record.cwd) throw new LifecycleError(409, "native_identity_mismatch", "Agent cwd differs from requested cwd");
    record.native = { source: native.source, kind: native.kind, value: native.value };
    return this.attachBinding(record, agent);
  }
  private async launch(runtime: SessionRuntime, record: Record, restore: boolean): Promise<Conversation> {
    try {
      const snap = runtime.engine.current();
      const pane = [...snap.agents, ...snap.shellPanes].find((pane) => pane.cwd === record.cwd);
      const created = pane ? await runtime.herdr.createTab(pane.workspaceId, { cwd: record.cwd }) : await runtime.herdr.createWorkspace({ cwd: record.cwd });
      record.launchPaneId = created.paneId; record.phase = "launching"; this.store.save(record);
      const args = restore && record.native ? record.kind === "pi" ? ["--session", record.native.value] : ["--resume", record.native.value] : [];
      let agent = await runtime.herdr.startAgent({ paneId: created.paneId, kind: record.kind, name: record.kind, args, timeoutMs: 30_000 });
      for (let attempt = 0; (!agent.interactiveReady || agent.launchPending || !agent.agentSession) && attempt < 50; attempt++) {
        await this.nativeAccess.pause(); agent = await runtime.herdr.getAgent(created.paneId);
      }
      if (agent.paneId !== created.paneId || !agent.interactiveReady || agent.launchPending || !agent.agentSession) throw new Error();
      return await this.accept(record, agent);
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      throw new LifecycleError(502, restore ? "restore_failed" : "create_failed", "Native launch could not be confirmed; retry reconciles the existing attempt");
    }
  }
}
