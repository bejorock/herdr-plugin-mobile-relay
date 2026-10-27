import { describe, expect, test } from "bun:test";

import { AcpWebSocketServer } from "./server.ts";
import type { AcpSessionDescriptor, AcpSessionProvider, AcpSocket } from "./types.ts";

class FakeSocket implements AcpSocket {
  sent: unknown[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }
}

const piSession: AcpSessionDescriptor = {
  id: "herdr_pi_1",
  cwd: "/opt/workspaces/relay",
  title: "pi · relay",
  agent: "pi",
  herdrSession: "default",
  paneId: "w1:p1",
  nativeStatus: "working",
  hasNativeSession: true,
};

function makeServer(
  sessions: AcpSessionDescriptor[] = [piSession],
  provisioner?: ConstructorParameters<typeof AcpWebSocketServer>[2],
  promptSender?: ConstructorParameters<typeof AcpWebSocketServer>[3],
  canceller?: ConstructorParameters<typeof AcpWebSocketServer>[4],
) {
  const provider: AcpSessionProvider = {
    list: () => sessions,
    find: (id) => sessions.find((session) => session.id === id),
  };
  return new AcpWebSocketServer(provider, "0.1.0-test", provisioner, promptSender, canceller);
}

function open(server: AcpWebSocketServer, canWrite = true) {
  const socket = new FakeSocket();
  server.open(socket, { user: null, device: null, canRead: true, canWrite });
  return socket;
}

async function request(server: AcpWebSocketServer, socket: FakeSocket, id: number, method: string, params?: unknown) {
  await server.message(socket, JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
}

async function initialize(server: AcpWebSocketServer, socket: FakeSocket) {
  await request(server, socket, 1, "initialize", { protocolVersion: 2, info: { name: "test-client", version: "1.0.0" }, capabilities: {} });
}

describe("AcpWebSocketServer", () => {
  test("requires initialize before any ACP session request", async () => {
    const server = makeServer();
    const socket = open(server);
    await request(server, socket, 1, "session/list", {});
    expect(socket.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "ACP connection must be initialized first" },
      },
    ]);
  });

  test("negotiates ACP v2 and declares the relay extension namespace", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    expect(socket.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 2,
        info: { name: "herdr-mobile-relay", version: "0.1.0-test" },
        capabilities: { session: { prompt: { image: true } }, _meta: { "herdr.dev": { transport: "websocket", phase: "experimental", sessionList: true, hooks: true } } },
      },
    });
  });

  test("requires ACP v2 client implementation metadata during initialize", async () => {
    const server = makeServer();
    const socket = open(server);
    await request(server, socket, 1, "initialize", { protocolVersion: 2, capabilities: {} });
    expect(socket.sent.at(-1)).toEqual({
      jsonrpc: "2.0", id: 1,
      error: { code: -32002, message: "Unsupported protocol version; expected 2" },
    });
  });

  test("creates a session only with explicit herdr.dev agent metadata and write access", async () => {
    const created = { ...piSession, id: "herdr_created", nativeStatus: "idle" as const };
    const provisioner = { create: async () => created } as unknown as ConstructorParameters<typeof AcpWebSocketServer>[2];
    const server = makeServer([piSession], provisioner);
    const socket = open(server);
    await initialize(server, socket);
    await request(server, socket, 2, "session/new", {
      cwd: "/opt/workspaces/new",
      _meta: { "herdr.dev": { agent: { kind: "pi", args: [] } } },
    });
    expect(socket.sent.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "herdr_created", update: { sessionUpdate: "state_update", state: "idle" } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "herdr_created", _meta: { "herdr.dev": { agent: "pi", nativeSessionBound: true } } },
      },
    ]);
  });

  test("delivers an ACP text prompt only through the configured proof-based sender", async () => {
    const sender = {
      send: async (input: { sessionId: string; text: string; images: unknown[] }) => {
        expect(input).toEqual({ sessionId: piSession.id, text: "hello Pi", images: [] });
        return { messageId: "pi:user:entry-1" };
      },
    } as unknown as ConstructorParameters<typeof AcpWebSocketServer>[3];
    const server = makeServer([piSession], undefined, sender);
    const socket = open(server);
    await initialize(server, socket);
    await request(server, socket, 2, "session/prompt", {
      sessionId: piSession.id,
      prompt: [{ type: "text", text: " hello Pi " }],
    });
    expect(socket.sent.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: piSession.id,
          update: { sessionUpdate: "user_message", messageId: "pi:user:entry-1", content: [{ type: "text", text: "hello Pi" }] },
        },
      },
      { jsonrpc: "2.0", id: 2, result: { messageId: "pi:user:entry-1" } },
    ]);
  });

  test("rejects malformed image-only prompts while retaining supported image capability", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    await request(server, socket, 2, "session/prompt", {
      sessionId: piSession.id,
      prompt: [{ type: "image", mimeType: "image/png", data: "not base64" }],
    });
    expect(socket.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "Prompt must contain non-empty text and up to four supported images" },
    });
  });

  test("forwards cancellation as a notification without falsely reporting native completion", async () => {
    const cancelled: string[] = [];
    const canceller = { cancel: async (sessionId: string) => void cancelled.push(sessionId) } as unknown as ConstructorParameters<typeof AcpWebSocketServer>[4];
    const server = makeServer([piSession], undefined, undefined, canceller);
    const socket = open(server);
    await initialize(server, socket);
    await server.message(socket, JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: piSession.id },
    }));
    expect(cancelled).toEqual([piSession.id]);
    expect(socket.sent).toHaveLength(1); // no invented idle update or notification response
  });

  test("closes ACP attachment without closing the Herdr pane", async () => {
    const cancelled: string[] = [];
    const canceller = { cancel: async (sessionId: string) => void cancelled.push(sessionId) } as unknown as ConstructorParameters<typeof AcpWebSocketServer>[4];
    const server = makeServer([piSession], undefined, undefined, canceller);
    const socket = open(server);
    await initialize(server, socket);
    await request(server, socket, 2, "session/close", { sessionId: piSession.id });
    expect(cancelled).toEqual([piSession.id]);
    expect(socket.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  test("forwards validated hook state as an ACP state update", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    server.publishState(piSession.id, "requires_action");
    expect(socket.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: piSession.id, update: { sessionUpdate: "state_update", state: "requires_action" } },
    });
  });

  test("forwards validated hook message deltas as ACP chunks", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    server.publishDelta(piSession.id, { messageId: "stream-1", channel: "assistant", delta: "Hello" });
    expect(socket.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: piSession.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "pi:assistant:stream-1",
          content: { type: "text", text: "Hello" },
        },
      },
    });
  });

  test("forwards validated hook tool status as an ACP tool update", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    server.publishTool(piSession.id, { toolCallId: "call-1", toolName: "bash", status: "in_progress" });
    expect(socket.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: piSession.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "pi:tool:call-1",
          title: "bash",
          kind: "other",
          status: "in_progress",
        },
      },
    });
  });

  test("brokers a hook permission request and resolves it from the first ACP response", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    const outcomes: unknown[] = [];
    server.requestInteraction(piSession.id, {
      interactionId: "permission-1",
      interactionKind: "permission",
      title: "Run tests?",
    }, (outcome) => outcomes.push(outcome));
    expect(socket.sent.at(-1)).toMatchObject({ id: "permission-1", method: "session/request_permission" });
    await server.message(socket, JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    }));
    await server.message(socket, JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: "cancelled" },
    }));
    expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
  });

  test("publishes a Claude plan before brokering its approval", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    server.requestInteraction(piSession.id, {
      interactionId: "plan-1",
      interactionKind: "permission",
      title: "Approve plan",
      plan: { planId: "claude:plan-1", content: "# Plan\n1. Do the work" },
    }, () => {});
    expect(socket.sent.slice(-2)).toEqual([
      {
        jsonrpc: "2.0", method: "session/update", params: {
          sessionId: piSession.id,
          update: { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "claude:plan-1", content: "# Plan\n1. Do the work" } },
        },
      },
      expect.objectContaining({ method: "session/request_permission", id: "plan-1" }),
    ]);
  });

  test("does not let a read-only ACP client resolve an interaction", async () => {
    const server = makeServer();
    const writer = open(server, true);
    const reader = open(server, false);
    await initialize(server, writer);
    await initialize(server, reader);
    const outcomes: unknown[] = [];
    server.requestInteraction(piSession.id, { interactionId: "authz", interactionKind: "permission", title: "Run?" }, (outcome) => outcomes.push(outcome));
    expect(writer.sent.at(-1)).toMatchObject({ id: "authz", method: "session/request_permission" });
    expect(reader.sent).toHaveLength(1); // initialize only
    await server.message(reader, JSON.stringify({ jsonrpc: "2.0", id: "authz", result: { outcome: { outcome: "selected", optionId: "allow_once" } } }));
    expect(outcomes).toEqual([]);
    await server.message(writer, JSON.stringify({ jsonrpc: "2.0", id: "authz", result: { outcome: { outcome: "selected", optionId: "allow_once" } } }));
    expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
  });

  test("keeps a pending interaction when one of two writable clients disconnects", async () => {
    const server = makeServer();
    const first = open(server);
    const second = open(server);
    await initialize(server, first);
    await initialize(server, second);
    const outcomes: unknown[] = [];
    server.requestInteraction(piSession.id, { interactionId: "disconnect", interactionKind: "permission", title: "Run?" }, (outcome) => outcomes.push(outcome));
    server.close(first);
    expect(outcomes).toEqual([]);
    await server.message(second, JSON.stringify({ jsonrpc: "2.0", id: "disconnect", result: { outcome: { outcome: "selected", optionId: "allow_once" } } }));
    expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
  });

  test("keeps a Claude-style elicitation pending after malformed client content", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    const outcomes: unknown[] = [];
    server.requestInteraction(piSession.id, {
      interactionId: "question-1",
      interactionKind: "elicitation",
      title: "Pick one",
      schema: { properties: { q1: { type: "string", enum: ["React"] } }, required: ["q1"] },
    }, (outcome) => outcomes.push(outcome));
    await server.message(socket, JSON.stringify({
      jsonrpc: "2.0", id: "question-1", result: { action: "accept", content: { q1: "Vue" } },
    }));
    expect(outcomes).toEqual([]);
    await server.message(socket, JSON.stringify({
      jsonrpc: "2.0", id: "question-1", result: { action: "accept", content: { q1: "React" } },
    }));
    expect(outcomes).toEqual([{ action: "accept", content: { q1: "React" } }]);
  });

  test("cancels pending local interactions when the relay stops", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    const outcomes: unknown[] = [];
    server.requestInteraction(piSession.id, { interactionId: "shutdown", interactionKind: "permission", title: "Stop?" }, (outcome) => outcomes.push(outcome));
    server.stop();
    expect(outcomes).toEqual([{ outcome: "cancelled", reason: "connection_closed" }]);
  });

  test("lists opaque sessions without leaking Herdr IDs or transcript paths", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    await request(server, socket, 2, "session/list", {});
    expect(socket.sent[1]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessions: [
          {
            sessionId: "herdr_pi_1",
            cwd: "/opt/workspaces/relay",
            title: "pi · relay",
            _meta: {
              "herdr.dev": { agent: "pi", nativeStatus: "working", nativeSessionBound: true },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(socket.sent[1])).not.toContain("w1:p1");
  });

  test("resumes a known session by synchronizing current state before the response", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    await request(server, socket, 2, "session/resume", {
      sessionId: piSession.id,
      cwd: piSession.cwd,
    });
    expect(socket.sent.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: piSession.id,
          update: { sessionUpdate: "state_update", state: "running" },
        },
      },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  test("rejects a mismatched cwd and an unsupported replay cursor", async () => {
    const server = makeServer();
    const socket = open(server);
    await initialize(server, socket);
    await request(server, socket, 2, "session/resume", { sessionId: piSession.id, cwd: "/wrong" });
    await request(server, socket, 3, "session/resume", {
      sessionId: piSession.id,
      cwd: piSession.cwd,
      replayFrom: { type: "cursor" },
    });
    expect(socket.sent.slice(1)).toEqual([
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "cwd does not match the session" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unsupported replay cursor" } },
    ]);
  });

  test("limits frame size and rejects batches in the initial WebSocket profile", async () => {
    const server = makeServer();
    const socket = open(server);
    await server.message(socket, "x".repeat(256 * 1024 + 1));
    expect(socket.closed).toEqual([{ code: 1009, reason: "ACP frame too large" }]);

    const next = open(server);
    await server.message(next, "[]");
    expect(next.sent).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch messages are not supported" } },
    ]);
  });
});
