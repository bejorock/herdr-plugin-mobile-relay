import { afterEach, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, closeAgentHooks, closeHttpStreams } from "../server.ts";
import { loadConfig } from "../config.ts";
import { ConversationService, ConversationStore } from "./conversations.ts";
import { HerdrEventHub } from "../http-events.ts";
import type { SessionRegistry } from "../sessions.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const sleep = () => Bun.sleep(20);
test("real Unix request -> HTTP pending/SSE -> HTTP response -> exact native callback (mocked Herdr)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-interaction-http-")); dirs.push(dir);
  const native = { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/private/native.jsonl" };
  const runtime = { name: "default", engine: { current: () => ({ bridge: "connected", agents: [{ paneId: "p1", agent: "pi", nativeSession: native }] }) },
    herdr: { getAgent: async () => ({ paneId: "p1", workspaceId: "w1", agent: "pi", cwd: "/repo", agentSession: native }) } };
  const registry = { get: () => runtime } as unknown as SessionRegistry;
  const conversations = new ConversationService(registry, new ConversationStore(dir), { cwd: async (path) => path, validate: async () => {}, pause: async () => {} });
  const server = await startServer({ cfg: { ...loadConfig(), relaySocketPath: join(dir, "relay.sock"), stateDir: dir },
    registry, conversations, herdrEvents: new HerdrEventHub(), enableHooks: true, audit: { record: () => {} } as never, liveUpdates: {} as never });
  let socket: Socket | undefined;
  try {
    const received: any[] = []; let buffer = "";
    for (let i = 0; i < 50; i++) { if (await Bun.file(join(dir, "agent-hook.sock")).exists()) break; await sleep(); }
    socket = connect(join(dir, "agent-hook.sock"));
    socket.on("data", (chunk) => { buffer += chunk.toString(); let at; while ((at = buffer.indexOf("\n")) >= 0) { received.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } });
    await new Promise<void>((resolve) => socket!.once("connect", resolve));
    socket.write(JSON.stringify({ version: 1, type: "hello", adapter: { kind: "pi", name: "test", version: "2" }, binding: { herdrSession: "default", paneId: "p1", agent: "pi", nativeSession: native } }) + "\n");
    for (let i = 0; !received.length && i < 50; i++) await sleep();
    expect(received[0].type).toBe("hello_ack");
    const base = "http://localhost";
    const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, unix: server.url.pathname, headers: { "x-herdr-client": "herdr-mobile-v1", ...init.headers as Record<string, string> } });
    const abort = new AbortController(); const events = await fetch(base + "/api/events", { signal: abort.signal }); const reader = events.body!.getReader(); await reader.read();
    socket.write(JSON.stringify({ version: 1, type: "event", eventId: "request:1", sequence: 1, event: { kind: "interaction.request", interactionId: "native-child-1", interactionKind: "permission", title: "Child request", executionId: "child-1", options: [{ optionId: "allow_once", name: "Allow" }] } }) + "\n");
    let pending: any;
    for (let i = 0; i < 50; i++) { const body = await (await fetch(base + "/api/interactions")).json() as any; pending = body.interactions[0]; if (pending) break; await sleep(); }
    expect(pending).toMatchObject({ executionId: "child-1", title: "Child request" });
    const event = new TextDecoder().decode((await reader.read()).value); expect(event).toContain("interaction.requested"); expect(event).not.toContain("/private/native");
    const post = (response: unknown, headers = {}) => fetch(base + `/api/interactions/${pending.id}/response`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ response }) });
    expect((await post({ optionId: "allow_once" }, { origin: "https://unapproved-browser.test" })).status).toBe(403);
    expect((await post({ optionId: "invented" })).status).toBe(400);
    expect((await post({ optionId: "allow_once" })).status).toBe(200);
    for (let i = 0; !received.some((v) => v.type === "command") && i < 50; i++) await sleep();
    expect(received.find((v) => v.type === "command").command).toEqual({ kind: "interaction.resolve", interactionId: "native-child-1", outcome: { optionId: "allow_once" } });
    expect((await post({ optionId: "allow_once" })).status).toBe(404);
    abort.abort(); await reader.cancel().catch(() => {});
  } finally { socket?.destroy(); closeHttpStreams(server); await closeAgentHooks(server); await server.stop(true); }
}, 15000);
