import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  checkAccess,
  closeScopePaneIds,
  CreateDeduplicator,
  deviceAuth,
  decodeWorkspaceId,
  paneReadResponse,
  parseCreateTabBody,
  parseCreateWorktreeBody,
  parseCreateWorkspaceBody,
  parseInputBody,
  parseKeysBody,
  parseLiveWatchMessage,
  parseLiveScrollMessage,
  parseRenameTabBody,
  parseReplyBody,
  parseRemoveWorktreeBody,
  parseSubmitBody,
  PaneMutationQueue,
  ReplyDeduplicator,
  replyWasSubmitted,
  mutationFailureResponse,
  makePaneAnsiViewportAdaptive,
  sendReplySteps,
  startServer,
  closeHttpStreams,
  workspaceRootSource,
  type ReplySender,
} from "./server.ts";
import type { Config } from "./config.ts";
import { HerdrRequestError, type PaneRead } from "./herdr-client.ts";
import { LifecycleError, type ConversationService } from "./agents/conversations.ts";
import type { TranscriptService } from "./agents/transcripts.ts";
import { HerdrEventHub } from "./http-events.ts";

const sockets: string[] = [];
afterEach(async () => { await Promise.all(sockets.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function req(headers: Record<string, string>): Request { return new Request("http://localhost/", { headers: { host: "localhost", ...headers } }); }
async function cfg(overrides: Partial<Config> = {}): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "relay-route-")); sockets.push(dir);
  return { socketPath: "/tmp/herdr.sock", relaySocketPath: join(dir, "relay.sock"), stateDir: dir, pollMs: 1500, pollIdleMs: 12000,
    readLines: 200, submitKeys: ["Enter"], allowedOrigins: [], multiSession: true, ...overrides };
}
function client(server: Awaited<ReturnType<typeof startServer>>) {
  return (url: string, init: RequestInit = {}) => fetch(url, { ...init, unix: server.url.pathname, headers: { "x-herdr-client": "herdr-mobile-v1", ...init.headers as Record<string, string> } });
}

describe("closeScopePaneIds", () => {
  const snapshot = {
    agents: [
      { paneId: "agent-a", tabId: "tab-a", workspaceId: "space-a" },
      { paneId: "agent-b", tabId: "tab-b", workspaceId: "space-a" },
    ],
    shellPanes: [{ paneId: "shell-c", tabId: "tab-c", workspaceId: "space-b" }],
  } as Pick<import("./types.ts").SnapshotResponse, "agents" | "shellPanes">;

  test("selects every pane in a tab", () => {
    expect(closeScopePaneIds(snapshot, { tabId: "tab-a" })).toEqual(["agent-a"]);
  });

  test("selects every agent and shell pane in a space", () => {
    expect(closeScopePaneIds(snapshot, { workspaceId: "space-a" })).toEqual([
      "agent-a",
      "agent-b",
    ]);
  });
});

describe("workspaceRootSource", () => {
  test("keeps every pane CWD so root resolution can reject ambiguous repositories", () => {
    const engine = {
      current: () => ({
        workspaces: [{ workspaceId: "space-a" }],
        agents: [
          {
            workspaceId: "space-a",
            cwd: "/repos/expected",
            focused: false,
          },
          {
            workspaceId: "space-a",
            cwd: "/repos/unrelated",
            focused: true,
          },
        ],
        shellPanes: [],
      }),
    } as unknown as Parameters<typeof workspaceRootSource>[0];

    expect(workspaceRootSource(engine, "space-a")).toEqual({
      worktreeRoot: undefined,
      paneCwds: ["/repos/expected", "/repos/unrelated"],
    });
  });

  test("scopes inspection to a selected pane in a multi-repository workspace", () => {
    const engine = {
      current: () => ({
        workspaces: [{ workspaceId: "space-a" }],
        agents: [
          {
            paneId: "pane-app",
            workspaceId: "space-a",
            cwd: "/repos/app",
          },
          {
            paneId: "pane-relay",
            workspaceId: "space-a",
            cwd: "/repos/relay",
          },
        ],
        shellPanes: [],
      }),
    } as unknown as Parameters<typeof workspaceRootSource>[0];

    expect(workspaceRootSource(engine, "space-a", "pane-relay")).toEqual({
      worktreeRoot: undefined,
      paneCwds: ["/repos/relay"],
    });
    expect(workspaceRootSource(engine, "space-a", "pane-other")).toBeNull();
  });
});

describe("decodeWorkspaceId", () => {
  test("turns malformed percent encodings into a controlled 400 inspection error", () => {
    expect(() => decodeWorkspaceId("bad%zz")).toThrow();
    try {
      decodeWorkspaceId("bad%zz");
    } catch (error) {
      expect(error).toMatchObject({ status: 400 });
    }
  });
});

describe("lean API surface", () => {
  test("documents only retained routes with resolvable OpenAPI references", async () => {
    const spec = await Bun.file(new URL("../docs/openapi.json", import.meta.url)).json();
    expect(spec.paths).toHaveProperty("/api/live");
    expect(spec.paths).not.toHaveProperty("/acp");
    function verify(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(verify); return; }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        let resolved: unknown = spec;
        for (const key of record.$ref.slice(2).split("/")) resolved = (resolved as Record<string, unknown>)?.[key];
        expect(resolved).toBeDefined();
      }
      Object.values(record).forEach(verify);
    }
    verify(spec);
  });
  test("keeps HTTP configuration and snapshots without removed application fields", async () => {
    const snapshot = { bridge: "connected", agents: [{ paneId: "p1", nativeSession: { value: "/private/transcript" } }], shellPanes: [], workspaces: [], tabs: [] };
    const server = await startServer({
      cfg: await cfg(), version: "2.0.0-test",
      registry: { get: () => ({ engine: { current: () => snapshot } }), list: () => [] } as never,
      audit: {} as never, liveUpdates: {} as never,
    });
    const fetch = client(server);
    try {
      const base = `http://localhost`;
      expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ build: "2.0.0-test" });
      const response = await (await fetch(`${base}/api/snapshot`)).json() as Record<string, unknown>;
      expect(response.bridge).toBe("connected");
      expect(response).not.toHaveProperty("notifications");
      expect(response).not.toHaveProperty("update");
      expect(JSON.stringify(response)).not.toContain("/private/transcript");
      for (const path of ["/", "/developer.html", "/acp", "/api/subscribe", "/api/push-test", "/api/notifications/prefs", "/api/notifications/snooze", "/api/update/check", "/api/directories", "/api/directories/validate", "/api/workspace/test/files", "/api/workspace/test/file", "/api/pane/test/upload"]) {
        for (const method of ["GET", "POST"]) {
          expect((await fetch(`${base}${path}`, { method })).status).toBe(404);
        }
      }
    } finally { await server.stop(true); }
  });
});

describe("HTTP transcript and event routes", () => {
  test("history and SSE share read gates, use scoped cursors and release connections", async () => {
    const calls: unknown[] = [];
    const page = { conversationId: "c1", kind: "pi", records: [{ id: "r1", role: "user", content: "hello" }], nextCursor: "opaque", hasMore: false };
    const transcripts = { page: async (id: string, opts: unknown) => { calls.push({ id, opts }); return page; } } as unknown as TranscriptService;
    const hub = new HerdrEventHub();
    const server = await startServer({ cfg: await cfg(), registry: {} as never, audit: {} as never, liveUpdates: {} as never,
      conversations: { runtime: () => ({ name: "work" }) } as never, transcripts, herdrEvents: hub });
    const fetch = client(server);
    try {
      const base = `http://localhost`;
      const history = await fetch(`${base}/api/conversations/c1/transcript?session=work&limit=2&cursor=before`);
      expect(history.status).toBe(200); expect(await history.json()).toEqual(page);
      expect(calls[0]).toEqual({ id: "c1", opts: { session: "work", limit: 2, cursor: "before" } });
      expect((await fetch(`${base}/api/conversations/c1/transcript?limit=bad`)).status).toBe(400);
      const abort = new AbortController();
      const response = await fetch(`${base}/api/conversations/c1/transcript/stream`, { headers: { "last-event-id": "previous" }, signal: abort.signal });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader(); const text = new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain("event: transcript.records"); expect(text).toContain("id: opaque");
      expect(calls[1]).toEqual({ id: "c1", opts: { session: undefined, limit: 100, cursor: "previous" } });
      abort.abort(); await reader.cancel().catch(() => {});
      const eventsAbort = new AbortController(); const events = await fetch(`${base}/api/events?session=work`, { signal: eventsAbort.signal });
      const eventReader = events.body!.getReader();
      expect(new TextDecoder().decode((await eventReader.read()).value)).toContain("resync.required");
      hub.event("work", "pane.created", { pane_id: "test-pane" });
      expect(new TextDecoder().decode((await eventReader.read()).value)).toContain("test-pane");
      eventsAbort.abort(); await eventReader.cancel().catch(() => {});
    } finally { closeHttpStreams(server); await server.stop(true); }
  });
});

describe("HTTP attach/prompt routes", () => {
  test("routes explicit attachment and semantic prompts without accepting native handles", async () => {
    const calls: unknown[] = [];
    const conversation = { id: "conversation-test", session: "default", paneId: "p1" };
    const server = await startServer({ cfg: await cfg(), registry: {} as never, audit: { record: () => {} } as never, liveUpdates: {} as never,
      conversations: { attach: async (input: unknown) => { calls.push(input); return conversation; }, prompt: async (...args: unknown[]) => { calls.push(args); return { ok: true, delivered: true, completion: "unknown" }; } } as never });
    const fetch = client(server);
    try {
      const post = (path: string, body: unknown) => fetch("http://localhost" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post("/api/conversations/attach?session=work", { paneId: "p1", kind: "pi", cwd: "/repo" })).status).toBe(200);
      expect(calls[0]).toEqual({ paneId: "p1", kind: "pi", cwd: "/repo", session: "work" });
      const response = await post("/api/conversations/conversation-test/prompt?session=work", { text: "hello", requestId: "p1" });
      expect(await response.json()).toMatchObject({ ok: true, delivered: true, completion: "unknown" });
      expect(calls[1]).toEqual(["conversation-test", "hello", "p1", "work"]);
      expect((await post("/api/conversations/attach", { paneId: "p1", kind: "pi", cwd: "/repo", nativeValue: "/secret" })).status).toBe(400);
      expect((await post("/api/conversations/conversation-test/prompt", { text: "hello", requestId: "p1", args: [] })).status).toBe(400);
    } finally { await server.stop(true); }
  });
});

describe("HTTP conversation routes", () => {
  test("uses HTTP lifecycle bodies, selected runtime, structured errors and no client native handles", async () => {
    const calls: unknown[] = [];
    const conversation = { id: "conversation-test", kind: "pi", session: "work", cwd: "/repo", paneId: "p1", status: "live" };
    const service = {
      discover: async (session: unknown) => { calls.push(session); return { session, agents: [] }; },
      create: async (input: unknown) => { calls.push(input); return conversation; },
      get: async (id: string, session: unknown) => { calls.push({ id, session }); if (id === "unknown") throw new LifecycleError(404, "conversation_unknown", "Unknown conversation"); return conversation; },
      resume: async (...args: unknown[]) => { calls.push(args); return conversation; },
    } as unknown as ConversationService;
    const server = await startServer({ cfg: await cfg(), registry: {} as never, audit: { record: () => {} } as never, liveUpdates: {} as never, conversations: service });
    const fetch = client(server);
    try {
      const base = `http://localhost`;
      expect((await fetch(`${base}/api/agent-kinds?session=work`)).status).toBe(200);
      const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const created = await post("/api/conversations?session=work", { kind: "pi", cwd: "/repo", requestId: "r1" });
      expect(created.status).toBe(201); expect(await created.json()).toEqual({ conversation });
      expect(calls[1]).toEqual({ kind: "pi", cwd: "/repo", requestId: "r1", session: "work" });
      expect((await post("/api/conversations/conversation-test/resume?session=work", { cwd: "/repo" })).status).toBe(200);
      expect(calls[2]).toEqual(["conversation-test", "/repo", "work"]);
      expect((await post("/api/conversations", { kind: "pi", cwd: "/repo", requestId: "r1", nativeValue: "/secret" })).status).toBe(400);
      const unknown = await fetch(`${base}/api/conversations/unknown`);
      expect(unknown.status).toBe(404); expect(await unknown.json()).toEqual({ error: { code: "conversation_unknown", message: "Unknown conversation" } });
      expect((await fetch(`${base}/api/conversations`, { method: "GET" })).status).toBe(405);
    } finally { await server.stop(true); }
  });

});

describe("owner socket request gate", () => {
  test("native clients may read, mutations require a non-simple client marker", async () => {
    const config = await cfg();
    expect(checkAccess(req({}), config)).toEqual({ ok: true });
    expect(checkAccess(req({}), config, "write").ok).toBe(false);
    expect(checkAccess(req({ "x-herdr-client": "herdr-mobile-v1" }), config, "write")).toEqual({ ok: true });
  });
  test("rejects arbitrary browser origins/Host/proxy claims and permits explicitly approved origins", async () => {
    const config = await cfg({ allowedOrigins: ["https://ade.test"] });
    expect(checkAccess(req({ origin: "https://evil.test" }), config).ok).toBe(false);
    expect(checkAccess(req({ host: "evil.test" }), config).ok).toBe(false);
    expect(checkAccess(req({ "tailscale-user-login": "owner@test" }), config).ok).toBe(false);
    expect(checkAccess(req({ origin: "https://ade.test" }), config, "write")).toEqual({ ok: true });
    expect(deviceAuth(req({ "x-device": "owner" }), config)).toEqual({ enforced: false, device: null, authorized: true });
  });
});

describe("sendReplySteps — two-step send & partial-failure clarity", () => {
  // A fake client that records calls and can be told to fail either step.
  class FakeClient implements ReplySender {
    readonly calls: string[] = [];
    constructor(private readonly failOn?: "text" | "keys") {}
    sendPaneText(_paneId: string, _text: string): Promise<void> {
      this.calls.push("text");
      return this.failOn === "text" ? Promise.reject(new Error("text rejected")) : Promise.resolve();
    }
    sendPaneKeys(_paneId: string, _keys: string[]): Promise<void> {
      this.calls.push("keys");
      return this.failOn === "keys" ? Promise.reject(new Error("keys rejected")) : Promise.resolve();
    }
  }

  const noSleep = async () => {};

  test("types then submits on the happy path", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text lands but submit fails → distinguishable error + textDelivered:true (don't resend)", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({
      ok: false,
      textDelivered: true,
      error: "typed into the pane but not submitted — check the pane before resending",
    });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text lands and the submit acknowledgement is lost → inspect, never offer Enter retry", async () => {
    const client: ReplySender = {
      sendPaneText: () => Promise.resolve(),
      sendPaneKeys: () => Promise.reject(
        new HerdrRequestError("connection closed", true),
      ),
    };

    await expect(
      sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep),
    ).resolves.toEqual({
      ok: false,
      textDelivered: true,
      deliveryAmbiguous: true,
      error: "typed into the pane, but submission could not be confirmed — inspect the pane before sending another key",
    });
  });

  test("text step fails → nothing delivered, surfaces Herdr's message (safe to resend)", async () => {
    const client = new FakeClient("text");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "text rejected" });
    expect(client.calls).toEqual(["text"]); // never reached the keys step
  });

  test("a post-write transport failure is ambiguous and must not invite a text resend", async () => {
    const client: ReplySender = {
      sendPaneText: () => Promise.reject(
        new HerdrRequestError("herdr pane.send_text: connection closed before reply", true),
      ),
      sendPaneKeys: () => Promise.resolve(),
    };

    await expect(
      sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep),
    ).resolves.toEqual({
      ok: false,
      textDelivered: true,
      deliveryAmbiguous: true,
      error: "reply delivery could not be confirmed — check the pane before resending",
    });
  });

  test("a pre-write transport failure remains safe to resend", async () => {
    const client: ReplySender = {
      sendPaneText: () => Promise.reject(
        new HerdrRequestError("herdr pane.send_text: connection failed", false),
      ),
      sendPaneKeys: () => Promise.resolve(),
    };

    await expect(
      sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep),
    ).resolves.toEqual({
      ok: false,
      textDelivered: false,
      error: "herdr pane.send_text: connection failed",
    });
  });

  test("submit-only (empty text) failure is a plain failure, not the partial-delivery message", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "keys rejected" });
    expect(client.calls).toEqual(["keys"]); // no text typed
  });

  test("no-submit reply just types the text", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", false, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text"]);
  });
});

describe("replyWasSubmitted", () => {
  test("distinguishes successful type-only replies from submitted replies", () => {
    expect(replyWasSubmitted(false, { ok: true, textDelivered: true })).toBe(false);
    expect(replyWasSubmitted(true, { ok: true, textDelivered: true })).toBe(true);
    expect(replyWasSubmitted(true, { ok: false, textDelivered: true, error: "failed" })).toBe(false);
  });
});

describe("mutationFailureResponse — post-write ambiguity", () => {
  test("marks a post-write transport failure as delivery-unconfirmed", () => {
    expect(mutationFailureResponse(
      new HerdrRequestError("connection closed", true),
      "terminal key",
    )).toEqual({
      ok: false,
      error: "terminal key delivery could not be confirmed — refresh and check state before retrying",
      deliveryAmbiguous: true,
    });
  });

  test("keeps a pre-write or definitive failure ordinary", () => {
    expect(mutationFailureResponse(new Error("rejected"), "tab creation")).toEqual({
      ok: false,
      error: "rejected",
    });
  });
});

describe("mutation request body parsing", () => {
  test("rejects non-object JSON and wrong reply field types", () => {
    expect(parseReplyBody(null)).toBeNull();
    expect(parseReplyBody([])).toBeNull();
    expect(parseReplyBody({ text: 42 })).toBeNull();
    expect(parseReplyBody({ submit: "yes" })).toBeNull();
    expect(parseReplyBody({ text: "hello", submit: false, requestId: "mobile:123" })).toEqual({
      text: "hello",
      submit: false,
      requestId: "mobile:123",
    });
    expect(parseReplyBody({ text: "hello", requestId: "" })).toBeNull();
    expect(parseReplyBody({ text: "hello", requestId: "contains spaces" })).toBeNull();
    expect(parseReplyBody({ text: "hello", requestId: "x".repeat(129) })).toBeNull();
  });

  test("requires a non-empty all-string key list", () => {
    expect(parseKeysBody(null)).toBeNull();
    expect(parseKeysBody({ keys: [] })).toBeNull();
    expect(parseKeysBody({ keys: ["Enter", 1] })).toBeNull();
    expect(parseKeysBody({ keys: ["C-c", "Enter"] })).toEqual(["C-c", "Enter"]);
  });

  test("accepts bounded raw terminal input including control bytes", () => {
    expect(parseInputBody({ data: "a\r\u0003" })).toBe("a\r\u0003");
    expect(parseInputBody({ data: "" })).toBeNull();
    expect(parseInputBody({ data: 1 })).toBeNull();
    expect(parseInputBody({ data: "x".repeat(65_537) })).toBeNull();
  });

  test("accepts one atomic text and submit-key mutation", () => {
    expect(parseSubmitBody({ data: "hello", key: "Enter" })).toEqual({
      data: "hello",
      key: "Enter",
    });
    expect(parseSubmitBody({ data: "", key: "Tab" })).toEqual({ data: "", key: "Tab" });
    expect(parseSubmitBody({ data: "hello", key: "Escape" })).toBeNull();
    expect(parseSubmitBody({ data: 1, key: "Enter" })).toBeNull();
    expect(parseSubmitBody({ data: "x".repeat(65_537), key: "Enter" })).toBeNull();
  });


  test("validates tab and workspace fields before trimming them", () => {
    expect(parseCreateTabBody(null)).toBeNull();
    expect(parseCreateTabBody({ workspaceId: 1 })).toBeNull();
    expect(parseCreateTabBody({ workspaceId: "  " })).toBeNull();
    expect(parseCreateTabBody({ workspaceId: " w1 ", label: "shell", requestId: "create-1" })).toEqual({
      workspaceId: "w1",
      label: "shell",
      requestId: "create-1",
    });
    expect(parseCreateTabBody({ workspaceId: "w1", requestId: "contains spaces" })).toBeNull();
    expect(parseCreateWorkspaceBody(null)).toBeNull();
    expect(parseCreateWorkspaceBody({ cwd: 7 })).toBeNull();
    expect(parseCreateWorkspaceBody({ cwd: "/tmp", label: false })).toBeNull();
    expect(parseCreateWorkspaceBody({ cwd: " /tmp ", label: "work", requestId: "create-2" })).toEqual({
      cwd: "/tmp",
      label: "work",
      requestId: "create-2",
    });
    expect(parseCreateWorkspaceBody({ cwd: "/tmp", requestId: "x".repeat(129) })).toBeNull();
    expect(parseRenameTabBody(null)).toBeNull();
    expect(parseRenameTabBody({ label: 3 })).toBeNull();
    expect(parseRenameTabBody({ label: "  " })).toBeNull();
    expect(parseRenameTabBody({ label: ` ${"x".repeat(129)} ` })).toBeNull();
    expect(parseRenameTabBody({ label: " Review " })).toEqual({ label: "Review" });
  });

  test("normalizes worktree create and remove requests", () => {
    expect(parseCreateWorktreeBody({
      workspaceId: " w1 ",
      branch: " feature/mobile ",
      base: " main ",
      label: " Mobile ",
      requestId: "worktree-1",
    })).toEqual({
      workspaceId: "w1",
      branch: "feature/mobile",
      base: "main",
      label: "Mobile",
      requestId: "worktree-1",
    });
    expect(parseCreateWorktreeBody({ workspaceId: "" })).toBeNull();
    expect(parseCreateWorktreeBody({ workspaceId: "w1", branch: 1 })).toBeNull();
    expect(parseRemoveWorktreeBody({ force: true, requestId: "remove-1" })).toEqual({
      force: true,
      requestId: "remove-1",
    });
    expect(parseRemoveWorktreeBody({ force: "yes" })).toBeNull();
  });
});

describe("CreateDeduplicator", () => {
  test("replays a completed structural create and rejects id reuse with new input", async () => {
    const dedupe = new CreateDeduplicator();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return {
        ok: true as const,
        pane: { paneId: "p1", workspaceId: "w1", workspaceLabel: "work", tabId: "t1", cwd: "/tmp" },
      };
    };

    await expect(dedupe.run("default\ncreate-1", "tab\nw1", operation)).resolves.toMatchObject({ ok: true });
    await expect(dedupe.run("default\ncreate-1", "tab\nw1", operation)).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(1);
    await expect(
      dedupe.run("default\ncreate-1", "workspace\n/tmp", operation),
    ).resolves.toEqual({ ok: false, error: "requestId was already used with a different create" });
  });
});

describe("ReplyDeduplicator", () => {
  test("returns the cached response for a completed duplicate request", async () => {
    const dedupe = new ReplyDeduplicator();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return { ok: true as const };
    };

    await expect(dedupe.run("primary\np1\nrequest-1", "hello\ntrue", operation)).resolves.toEqual({ ok: true });
    await expect(dedupe.run("primary\np1\nrequest-1", "hello\ntrue", operation)).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("shares one in-flight operation across concurrent duplicates", async () => {
    const dedupe = new ReplyDeduplicator();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = async () => {
      calls += 1;
      await gate;
      return { ok: true as const };
    };

    const first = dedupe.run("primary\np1\nrequest-2", "hello\ntrue", operation);
    const second = dedupe.run("primary\np1\nrequest-2", "hello\ntrue", operation);
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(calls).toBe(1);
  });

  test("rejects request-id reuse with a different payload", async () => {
    const dedupe = new ReplyDeduplicator();
    await dedupe.run("primary\np1\nrequest-3", "hello\ntrue", async () => ({ ok: true }));
    await expect(
      dedupe.run("primary\np1\nrequest-3", "different\ntrue", async () => ({ ok: true })),
    ).resolves.toEqual({ ok: false, error: "requestId was already used with a different reply" });
  });
});

describe("PaneMutationQueue", () => {
  test("does not interleave two mutations for the same pane", async () => {
    const queue = new PaneMutationQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("default\np1", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    const second = queue.run("default\np1", async () => {
      events.push("second:start");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });
});

describe("paneReadResponse — pane read → REST body", () => {
  test("passes text, truncated, and the monotonic revision through", () => {
    const read: PaneRead = { pane_id: "w1:p1", text: "hello", truncated: true, revision: 42 };
    expect(paneReadResponse("w1:p1", read)).toEqual({
      paneId: "w1:p1",
      text: "hello",
      truncated: true,
      revision: 42,
    });
  });

  test("carries a zero revision unchanged (fresh pane) rather than dropping the field", () => {
    const read: PaneRead = { pane_id: "w2:p1", text: "", truncated: false, revision: 0 };
    expect(paneReadResponse("w2:p1", read)).toEqual({
      paneId: "w2:p1",
      text: "",
      truncated: false,
      revision: 0,
    });
  });
});

describe("makePaneAnsiViewportAdaptive", () => {
  test("replaces remote-width styled padding with erase-to-device-edge", () => {
    const background = "\u001b[48;2;52;52;52m";
    const reset = "\u001b[0m";
    expect(
      makePaneAnsiViewportAdaptive(
        `${background}          ${reset}\r\n${background}› prompt      ${reset}`,
      ),
    ).toBe(
      `${background}\u001b[K${reset}\r\n${background}› prompt\u001b[K${reset}`,
    );
  });

  test("preserves meaningful interior spaces and unstyled text", () => {
    expect(makePaneAnsiViewportAdaptive("one  two\r\nplain")).toBe("one  two\r\nplain");
  });
});

describe("parseLiveWatchMessage", () => {
  test("accepts a selected pane with device dimensions and supplies compatible defaults", () => {
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":"w1:p1"}'))
      .toEqual({ paneId: "w1:p1", cols: 120, rows: 40 });
    expect(parseLiveWatchMessage(
      '{"type":"watch_pane","paneId":"w1:p1","cols":177,"rows":57}',
    )).toEqual({ paneId: "w1:p1", cols: 177, rows: 57 });
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":null}'))
      .toEqual({ paneId: null, cols: 120, rows: 40 });
  });

  test("rejects malformed watches", () => {
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":3}')).toBeNull();
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":"p","minRevision":1}'))
      .toBeNull();
    expect(parseLiveWatchMessage(
      '{"type":"watch_pane","paneId":"p","cols":0,"rows":40}',
    )).toBeNull();
    expect(parseLiveWatchMessage(
      '{"type":"watch_pane","paneId":"p","cols":120,"rows":201}',
    )).toBeNull();
  });
});

describe("parseLiveScrollMessage", () => {
  test("accepts bounded scroll commands for the watched pane", () => {
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"down","lines":8}',
    )).toEqual({ paneId: "w1:p1", direction: "down", lines: 8 });
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"up","lines":1}',
    )).toEqual({ paneId: "w1:p1", direction: "up", lines: 1 });
  });

  test("rejects malformed or unbounded scroll commands", () => {
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"left","lines":8}',
    )).toBeNull();
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"down","lines":0}',
    )).toBeNull();
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"down","lines":201}',
    )).toBeNull();
  });
});
