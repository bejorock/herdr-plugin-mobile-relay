import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationService, ConversationStore, LifecycleError, type NativeAccess } from "./conversations.ts";
import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { AgentInfo } from "../herdr-client.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))); });
const uuid = "123e4567-e89b-42d3-a456-426614174000";
async function harness(kind: "pi" | "claude" = "pi") {
  const dir = await mkdtemp(join(tmpdir(), "relay-http-")); dirs.push(dir);
  let starts = 0; let allocations = 0; let prompts = 0; let failStart = false; let wrongNative = false; let failNative = false;
  const agents = new Map<string, AgentInfo>();
  const native = kind === "pi" ? { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/home/u/.pi/agent/sessions/native.jsonl" }
    : { source: "herdr:claude", agent: "claude", kind: "id" as const, value: uuid };
  let connected = true;
  const runtime = { name: "default", engine: { current: () => ({ bridge: connected ? "connected" : "disconnected", agents: [], shellPanes: [], workspaces: [] }) }, herdr: {
    listIntegrations: async () => [{ target: "pi", command: "pi", available: true, state: "current" }, { target: "claude", command: "claude", available: false, state: "not_installed" }],
    createWorkspace: async ({ cwd }: { cwd: string }) => ({ paneId: `p${++allocations}`, workspaceId: "w1", tabId: "t1", cwd }),
    startAgent: async (input: { paneId: string; args: string[] }) => {
      starts++;
      const agent: AgentInfo = { paneId: input.paneId, workspaceId: "w1", tabId: "t1", agent: kind, status: "idle", cwd: "/repo", focused: false, interactiveReady: true, launchPending: false,
        agentSession: { ...native, value: wrongNative ? kind === "pi" ? "/other" : "223e4567-e89b-42d3-a456-426614174000" : native.value } };
      agents.set(input.paneId, agent);
      if (input.args.length) expect(input.args).toEqual(kind === "pi" ? ["--session", native.value] : ["--resume", native.value]);
      if (failStart) throw new Error("sensitive backend detail");
      return agent;
    },
    getAgent: async (id: string) => { const agent = agents.get(id); if (!agent) throw new Error("missing pane"); return agent; },
    listAgentBindings: async () => [...agents.values()].map((agent) => ({ ...agent, nativeSession: agent.agentSession })),
    promptAgent: async () => { prompts++; },
  } } as unknown as SessionRuntime;
  const registry = { get: (name?: string) => !name || name === "default" ? runtime : undefined } as SessionRegistry;
  const access: NativeAccess = { cwd: async (path) => path.replace(/\/$/, ""), validate: async () => { if (failNative) throw new LifecycleError(404, "native_session_missing", "Missing"); }, pause: async () => {} };
  const store = new ConversationStore(dir);
  const service = new ConversationService(registry, store, access);
  return { dir, agents, runtime, registry, store, service, access, get starts() { return starts; }, get allocations() { return allocations; }, get prompts() { return prompts; },
    setFailStart: (v: boolean) => { failStart = v; }, setWrongNative: (v: boolean) => { wrongNative = v; }, setMissing: () => { failNative = true; }, setConnected: (v: boolean) => { connected = v; } };
}
const input = (kind: "pi" | "claude") => ({ kind, cwd: "/repo", requestId: "create-1" });

describe("HTTP conversation lifecycle (mocked Herdr/native access)", () => {
  for (const kind of ["pi", "claude"] as const) {
    test(`${kind}: create is durable before any prompt; replayed create/live resume/restart reuse same native agent`, async () => {
      const h = await harness(kind);
      const created = await h.service.create(input(kind));
      expect(created).toMatchObject({ session: "default", kind, cwd: "/repo", status: "live" });
      expect(created.id).toMatch(/^conversation_/);
      expect(JSON.stringify(created)).not.toContain(kind === "pi" ? "native.jsonl" : uuid);
      expect((await stat(h.store.path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(h.store.path, "utf8")).conversations[0].native).toBeDefined();
      expect((await h.service.create(input(kind))).id).toBe(created.id);
      expect((await h.service.resume(created.id, "/repo/")).id).toBe(created.id);
      const restarted = new ConversationService(h.registry, new ConversationStore(h.dir), h.access);
      expect((await restarted.resume(created.id, "/repo")).id).toBe(created.id);
      expect(h.starts).toBe(1); expect(h.prompts).toBe(0);
    });
    test(`${kind}: pane closure followed by concurrent restores launches once and preserves public ID`, async () => {
      const h = await harness(kind); const created = await h.service.create(input(kind));
      h.agents.clear();
      expect((await h.service.get(created.id)).status).toBe("closed");
      const result = await Promise.all(Array.from({ length: 5 }, () => h.service.resume(created.id, "/repo")));
      expect(new Set(result.map((v) => v.paneId)).size).toBe(1);
      expect(result.every((v) => v.id === created.id && v.status === "live")).toBe(true);
      expect(h.starts).toBe(2); expect(h.prompts).toBe(0);
      await h.service.resume(created.id, "/repo"); expect(h.starts).toBe(2);
    });
    test(`${kind}: native binding moved to another pane is reused`, async () => {
      const h = await harness(kind); const created = await h.service.create(input(kind));
      const agent = [...h.agents.values()][0]!; h.agents.clear(); h.agents.set("p9", { ...agent, paneId: "p9" });
      expect(await h.service.resume(created.id, "/repo")).toMatchObject({ id: created.id, paneId: "p9" });
      expect(h.starts).toBe(1);
    });
    test(`${kind}: missing native data/cwd mismatch/runtime mismatch do not launch replacements`, async () => {
      const h = await harness(kind); const created = await h.service.create(input(kind)); h.agents.clear(); h.setMissing();
      await expect(h.service.resume(created.id, "/repo")).rejects.toMatchObject({ code: "native_session_missing" });
      await expect(h.service.resume(created.id, "/elsewhere")).rejects.toMatchObject({ code: "cwd_mismatch" });
      await expect(h.service.resume(created.id, "/repo", "other")).rejects.toMatchObject({ code: "runtime_mismatch" });
      expect(h.starts).toBe(1); expect(h.allocations).toBe(1);
    });
    test(`${kind}: lost initial acknowledgement without saved native identity fails closed after restart`, async () => {
      const h = await harness(kind); h.setFailStart(true);
      await expect(h.service.create(input(kind))).rejects.toMatchObject({ code: "create_failed" });
      const restarted = new ConversationService(h.registry, new ConversationStore(h.dir), h.access);
      await expect(restarted.create(input(kind))).rejects.toMatchObject({ code: "create_pending" });
      expect(h.starts).toBe(1); expect(h.allocations).toBe(1);
    });
    test(`${kind}: lost restore acknowledgement reuses live native continuation on retry`, async () => {
      const h = await harness(kind); const created = await h.service.create(input(kind)); h.agents.clear(); h.setFailStart(true);
      await expect(h.service.resume(created.id, "/repo")).rejects.toMatchObject({ code: "restore_failed" });
      const restarted = new ConversationService(h.registry, new ConversationStore(h.dir), h.access);
      expect((await restarted.resume(created.id, "/repo")).id).toBe(created.id);
      expect(h.starts).toBe(2);
    });
    test(`${kind}: identity mismatch fails closed and cannot duplicate an unresolved launch`, async () => {
      const h = await harness(kind); const created = await h.service.create(input(kind)); h.agents.clear(); h.setWrongNative(true);
      await expect(h.service.resume(created.id, "/repo")).rejects.toMatchObject({ code: "native_identity_mismatch" });
      await expect(h.service.resume(created.id, "/repo")).rejects.toMatchObject({ code: "restore_pending" });
      expect(h.starts).toBe(2);
    });
  }
  test("a matching pending native launch is not duplicated", async () => {
    const h = await harness(); const created = await h.service.create(input("pi"));
    const agent = [...h.agents.values()][0]!; agent.launchPending = true;
    await expect(h.service.resume(created.id, "/repo")).rejects.toMatchObject({ code: "restore_pending" }); expect(h.starts).toBe(1);
  });
  test("concurrent mismatched creation request IDs fail rather than returning the wrong conversation", async () => {
    const h = await harness();
    const first = h.service.create(input("pi"));
    const second = h.service.create({ ...input("pi"), cwd: "/different" });
    const results = await Promise.allSettled([first, second]);
    expect(results[0]?.status).toBe("fulfilled"); expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "request_id_conflict" } }); expect(h.starts).toBe(1);
  });
  test("discovery does not mistake installed hooks for executable evidence or invoke agents", async () => {
    const h = await harness();
    expect(await h.service.discover()).toEqual({ session: "default", agents: [
      { kind: "pi", availability: "unknown", version: null, reason: "launchability_unverified" },
      { kind: "claude", availability: "unavailable", version: null, reason: "executable_not_found" },
    ] });
    expect(h.starts).toBe(0); expect(h.prompts).toBe(0);
    await expect(h.service.discover("missing")).rejects.toMatchObject({ code: "runtime_unknown" });
    h.setConnected(false); await expect(h.service.discover()).rejects.toMatchObject({ code: "runtime_unavailable" });
  });
  test("discovery reports both/one/neither/unknown with no model activity", async () => {
    const h = await harness();
    for (const pi of [false, true]) for (const claude of [false, true]) {
      h.runtime.herdr.listIntegrations = async () => [{ target: "pi", command: "pi", available: pi, state: "not_installed" }, { target: "claude", command: "claude", available: claude, state: "not_installed" }];
      expect((await h.service.discover()).agents.map((agent) => agent.availability)).toEqual([pi ? "available" : "unavailable", claude ? "available" : "unavailable"]);
    }
    h.runtime.herdr.listIntegrations = async () => { throw new Error("timeout"); };
    await expect(h.service.discover()).rejects.toMatchObject({ code: "discovery_unavailable" });
    expect(h.starts).toBe(0); expect(h.prompts).toBe(0);
  });
  test("ambiguous live native agents fail without interrupting or launching anything", async () => {
    const h = await harness(); const created = await h.service.create(input("pi"));
    const agent = [...h.agents.values()][0]!; h.agents.set("p2", { ...agent, paneId: "p2" });
    await expect(h.service.resume(created.id, "/repo")).rejects.toMatchObject({ code: "native_session_ambiguous" });
    expect(h.starts).toBe(1);
  });
  test("unknown conversation and relative cwd fail before creating anything", async () => {
    const h = await harness();
    await expect(h.service.get("unknown")).rejects.toMatchObject({ code: "conversation_unknown" });
    await expect(h.service.create({ ...input("pi"), cwd: "relative" })).rejects.toMatchObject({ code: "invalid_cwd" }); expect(h.starts).toBe(0);
  });
  test("invalid or symlinked journals fail closed instead of discarding dedupe state", async () => {
    const h = await harness();
    await writeFile(h.store.path, "{}");
    expect(() => new ConversationStore(h.dir)).toThrow("Conversation store is invalid");
    await rm(h.store.path); await writeFile(join(h.dir, "elsewhere"), JSON.stringify({ version: 1, conversations: [] }));
    await symlink(join(h.dir, "elsewhere"), h.store.path);
    expect(() => new ConversationStore(h.dir)).toThrow("Conversation store is invalid");
  });
  test("journal failure is surfaced and does not mutate memory", async () => {
    const h = await harness(); await rm(h.dir, { recursive: true, force: true });
    await expect(h.service.create(input("pi"))).rejects.toMatchObject({ code: "persistence_failed" });
    expect(h.store.byRequest("default", "create-1")).toBeUndefined(); expect(h.starts).toBe(0);
  });
});
