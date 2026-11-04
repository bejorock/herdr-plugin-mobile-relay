import { isAbsolute } from "node:path";

const NATIVE_SESSION_DISCOVERY_TIMEOUT_MS = 5_000;
const NATIVE_SESSION_DISCOVERY_POLL_MS = 100;

import type { AgentInfo, HerdrClient } from "../herdr-client.ts";
import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { AgentView, WorkspaceView } from "../types.ts";
import { readSafeClaudeTranscript } from "./claude-transcript.ts";
import { readSafePiTranscript } from "./pi-transcript.ts";
import type { PersistedAcpBinding } from "./binding-store.ts";
import { acpSessionIdFor, LiveAcpSessionRegistry } from "./session-registry.ts";
import type { AcpSessionDescriptor } from "./types.ts";

export const SUPPORTED_ACP_AGENT_KINDS = new Set([
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode",
  "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli",
  "qwen", "letta", "maki", "muse",
]);

export interface NewAcpAgentRequest { cwd: string; agent: { kind: string; args: string[] }; }

/** Derive native continuation args only from the owner-only persisted resume handle. */
export function nativeResumeArgs(binding: Pick<PersistedAcpBinding, "agent" | "nativeValue" | "transcriptPath">): string[] {
  return binding.agent === "pi" ? ["--session", binding.transcriptPath] : ["--resume", binding.nativeValue];
}

export function parseHerdrNewSessionMeta(value: unknown): { kind: string; args: string[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const ext = root["herdr.dev"];
  if (typeof ext !== "object" || ext === null || Array.isArray(ext)) return null;
  const agent = (ext as Record<string, unknown>).agent;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return null;
  const record = agent as Record<string, unknown>;
  if (typeof record.kind !== "string" || !SUPPORTED_ACP_AGENT_KINDS.has(record.kind)) return null;
  if (record.args !== undefined && (!Array.isArray(record.args) || record.args.length > 32 || !record.args.every((arg) => typeof arg === "string" && arg.length <= 4096))) return null;
  return { kind: record.kind, args: (record.args as string[] | undefined) ?? [] };
}

function exactWorkspace(runtime: SessionRuntime, cwd: string): WorkspaceView | undefined {
  const snapshot = runtime.engine.current();
  const panes = [...snapshot.agents, ...snapshot.shellPanes];
  const candidates = snapshot.workspaces.filter((workspace) =>
    workspace.worktree?.checkoutPath === cwd || panes.some((pane) => pane.workspaceId === workspace.workspaceId && pane.cwd === cwd),
  );
  return candidates.find((workspace) => workspace.focused) ?? candidates[0];
}

function descriptor(input: {
  runtime: SessionRuntime;
  pane: { paneId: string; workspaceId: string; tabId: string; cwd: string };
  agent: { agent: string | null; status: AgentView["status"]; agentSession?: { source: string; agent: string; kind: "id" | "path"; value: string } };
}): AcpSessionDescriptor {
  const native = input.agent.agentSession;
  const agent = input.agent.agent ?? "unknown";
  return {
    id: acpSessionIdFor({ herdrSession: input.runtime.name, paneId: input.pane.paneId, agent, nativeSource: native?.source, nativeValue: native?.value }),
    cwd: input.pane.cwd, title: `${agent} · ${input.pane.cwd.split("/").filter(Boolean).at(-1) ?? "workspace"}`,
    agent, herdrSession: input.runtime.name, paneId: input.pane.paneId, nativeStatus: input.agent.status,
    hasNativeSession: native !== undefined, ...(native ? { nativeSession: native } : {}),
  };
}

/** Implements session/new and guarded native-conversation recovery for session/resume. */
export class HerdrAcpProvisioner {
  constructor(private readonly sessions: SessionRegistry, private readonly acpSessions?: LiveAcpSessionRegistry) {}

  async create(input: NewAcpAgentRequest): Promise<AcpSessionDescriptor> {
    if (!isAbsolute(input.cwd)) throw new Error("cwd must be absolute");
    const runtime = this.sessions.get();
    if (!runtime || runtime.engine.current().bridge !== "connected") throw new Error("primary Herdr session is unavailable");
    const match = exactWorkspace(runtime, input.cwd);
    const created = match ? await runtime.herdr.createTab(match.workspaceId, { cwd: input.cwd }) : await runtime.herdr.createWorkspace({ cwd: input.cwd });
    const ready = await this.startAndDiscover(runtime, created, input.agent.kind, input.agent.args);
    const agent = this.agentView(created, ready, input.agent.kind);
    return this.acpSessions?.remember(runtime, agent) ?? descriptor({ runtime, pane: created, agent: ready });
  }

  /**
   * Relaunch only a validated persisted native conversation. No client-supplied args participate in
   * this path: a failure is an error, never a fallback to a fresh conversation.
   */
  async recover(binding: PersistedAcpBinding): Promise<AcpSessionDescriptor> {
    if (!binding.workspaceId || !binding.cwd) throw new Error("Stored native conversation is no longer available");
    const runtime = this.sessions.get(binding.herdrSession);
    if (!runtime || runtime.engine.current().bridge !== "connected") {
      throw new Error("Cannot safely recover session while Herdr state is unavailable");
    }
    await this.validateStoredConversation(binding);
    const snapshot = runtime.engine.current();
    if (snapshot.agents.some((agent) => agent.paneId === binding.paneId)) {
      throw new Error("Stored session pane is still present; retry session/resume");
    }
    const workspace = snapshot.workspaces.find((candidate) => candidate.workspaceId === binding.workspaceId) ?? exactWorkspace(runtime, binding.cwd);
    const created = workspace
      ? await runtime.herdr.createTab(workspace.workspaceId, { cwd: binding.cwd })
      : await runtime.herdr.createWorkspace({ cwd: binding.cwd });
    const args = nativeResumeArgs(binding);
    let ready: AgentInfo;
    try {
      ready = await this.startAndDiscover(runtime, created, binding.agent, args);
    } catch (error) {
      throw new Error(`Could not resume the stored native conversation: ${error instanceof Error ? error.message : "unknown failure"}`);
    }
    if (!this.provesNativeResume(binding, ready)) {
      throw new Error("Could not resume the stored native conversation");
    }
    const adopted = this.acpSessions?.adoptRecovered(binding.id, runtime, this.agentView(created, ready, binding.agent));
    if (!adopted) throw new Error("Could not resume the stored native conversation");
    return adopted;
  }

  private async validateStoredConversation(binding: PersistedAcpBinding): Promise<void> {
    try {
      if (binding.agent === "pi") await readSafePiTranscript(binding.transcriptPath);
      else await readSafeClaudeTranscript(binding.transcriptPath);
    } catch {
      throw new Error("Stored native conversation is no longer available");
    }
  }

  private provesNativeResume(binding: PersistedAcpBinding, ready: AgentInfo): boolean {
    const native = ready.agentSession;
    if (!native || ready.agent !== binding.agent) return false;
    // Pi reports a session path; Claude reports the stable native UUID supplied to --resume.
    return binding.agent === "pi"
      ? native.kind === "path" && native.value === binding.transcriptPath
      : native.kind === "id" && native.value === binding.nativeValue;
  }

  private agentView(
    pane: { paneId: string; workspaceId: string; tabId: string; cwd: string; workspaceLabel?: string },
    ready: AgentInfo,
    fallbackAgent: string,
  ): AgentView {
    return {
      paneId: ready.paneId, workspaceId: ready.workspaceId, workspaceLabel: pane.workspaceLabel ?? pane.workspaceId,
      workspaceNumber: 0, tabId: ready.tabId, agent: ready.agent ?? fallbackAgent, status: ready.status,
      cwd: ready.cwd, focused: ready.focused, kind: "agent", ...(ready.agentSession ? { nativeSession: ready.agentSession } : {}),
    };
  }

  private async startAndDiscover(
    runtime: SessionRuntime,
    pane: { paneId: string; workspaceId: string; tabId: string; cwd: string },
    kind: string,
    args: string[],
  ): Promise<AgentInfo> {
    const started = await runtime.herdr.startAgent({ paneId: pane.paneId, kind, name: kind, args });
    if (!started.interactiveReady || !started.agent) throw new Error("Herdr did not confirm the requested agent is ready");
    return await this.waitForNativeSession(runtime.herdr, pane, started);
  }

  private async waitForNativeSession(herdr: HerdrClient, pane: { paneId: string }, started: AgentInfo): Promise<AgentInfo> {
    if (started.agentSession) return started;
    const deadline = Date.now() + NATIVE_SESSION_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, NATIVE_SESSION_DISCOVERY_POLL_MS));
      const current = await herdr.getAgent(pane.paneId);
      if (current.agentSession) return current;
    }
    throw new Error("Native agent session discovery timed out");
  }
}
