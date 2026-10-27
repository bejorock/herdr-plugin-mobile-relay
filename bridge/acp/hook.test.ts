import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHookServer, parseHookEvent, resolveHookHello } from "./hook.ts";

const native = { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/home/u/.pi/agent/sessions/x.jsonl" };

function registry() {
  return {
    get: (name?: string) => name === "default"
      ? {
          name: "default",
          engine: {
            current: () => ({
              bridge: "connected" as const,
              agents: [{ paneId: "w1:p1", agent: "pi", nativeSession: native }],
            }),
          },
        }
      : undefined,
  };
}

describe("Agent hook protocol", () => {
  test("binds only when the local native session exactly matches Herdr state", () => {
    const hello = {
      version: 1,
      type: "hello",
      adapter: { kind: "pi", name: "relay", version: "1" },
      binding: { herdrSession: "default", paneId: "w1:p1", agent: "pi", nativeSession: native },
    };
    expect(resolveHookHello(registry() as never, hello)).toMatchObject({
      agent: "pi",
      herdrSession: "default",
      paneId: "w1:p1",
      acpSessionId: expect.stringMatching(/^herdr_/),
    });
    expect(resolveHookHello(registry() as never, {
      ...hello,
      binding: { ...hello.binding, nativeSession: { ...native, value: "/tmp/other.jsonl" } },
    })).toBeNull();
  });

  test("preserves a hook-reported Claude transcript path after exact native-ID binding", () => {
    const claudeNative = { source: "herdr:claude", agent: "claude", kind: "id" as const, value: "claude-native-id" };
    const claudeRegistry = {
      get: () => ({ name: "default", engine: { current: () => ({ bridge: "connected" as const, agents: [{ paneId: "w1:p2", agent: "claude", nativeSession: claudeNative }] }) } }),
    };
    expect(resolveHookHello(claudeRegistry as never, {
      version: 1, type: "hello", adapter: { kind: "claude", name: "relay", version: "1" },
      binding: { herdrSession: "default", paneId: "w1:p2", agent: "claude", nativeSession: claudeNative, transcriptPath: "/home/u/.claude/projects/a/session.jsonl" },
    })).toMatchObject({ agent: "claude", transcriptPath: "/home/u/.claude/projects/a/session.jsonl" });
  });

  test("accepts bounded first-party state hints and namespaced custom notifications", () => {
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "state-1",
      sequence: 1,
      event: { kind: "agent.state", state: "running" },
    })).toMatchObject({ event: { kind: "agent.state", state: "running" } });
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "state-2",
      sequence: 2,
      event: { kind: "agent.state", state: "made-up" },
    })).toBeNull();
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "tool-1",
      sequence: 3,
      event: { kind: "tool.update", toolCallId: "call-1", toolName: "bash", status: "in_progress" },
    })).toMatchObject({ event: { kind: "tool.update", toolCallId: "call-1" } });
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "delta-1",
      sequence: 4,
      event: { kind: "message.delta", messageId: "stream-1", channel: "assistant", delta: "hello" },
    })).toMatchObject({ event: { kind: "message.delta", delta: "hello" } });
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "form-1",
      sequence: 5,
      event: {
        kind: "interaction.request",
        interactionId: "form-1",
        interactionKind: "elicitation",
        title: "Environment",
        schema: { properties: { environment: { type: "string", enum: ["staging", "production"] } }, required: ["environment"] },
      },
    })).toMatchObject({ event: { kind: "interaction.request", schema: { required: ["environment"] } } });
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "ask-1",
      sequence: 6,
      event: {
        kind: "interaction.request",
        interactionId: "ask-1",
        interactionKind: "permission",
        title: "Run tests?",
        options: [{ optionId: "allow_once", name: "Allow once" }],
      },
    })).toMatchObject({ event: { kind: "interaction.request", interactionId: "ask-1" } });
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "evt-1",
      sequence: 1,
      event: { kind: "custom.notification", namespace: "example.dev", name: "preview_ready", payload: { ok: true } },
    })).toMatchObject({ eventId: "evt-1" });
    expect(parseHookEvent({
      version: 1,
      type: "event",
      eventId: "evt-1",
      sequence: 1,
      event: { kind: "custom.notification", namespace: "pi", name: "pretend_permission" },
    })).toBeNull();
  });

  test("accepts bounded multi-select elicitation schemas and rejects unsafe forms", () => {
    const valid = {
      version: 1,
      type: "event",
      eventId: "question-1",
      sequence: 1,
      event: {
        kind: "interaction.request",
        interactionId: "question-1",
        interactionKind: "elicitation",
        title: "Claude needs input",
        schema: {
          properties: {
            q1: { type: "string", oneOf: [{ const: "React", title: "React" }] },
            q2: { type: "array", items: { type: "string", oneOf: [{ const: "red", title: "Red" }] }, minItems: 1, maxItems: 2 },
          },
          required: ["q1", "q2"],
        },
      },
    };
    expect(parseHookEvent(valid)).toMatchObject({ event: { interactionKind: "elicitation" } });
    expect(parseHookEvent({ ...valid, event: { ...valid.event, schema: { properties: { q1: { type: "array", items: { type: "string", enum: ["x"] }, minItems: 3, maxItems: 2 } } } } })).toBeNull();
    expect(parseHookEvent({ ...valid, event: { ...valid.event, schema: { properties: { q1: { type: "string", oneOf: [{ const: "x", title: "X" }, { const: "x", title: "X again" }] } } } } })).toBeNull();
    expect(parseHookEvent({
      version: 1, type: "event", eventId: "plan-1", sequence: 2,
      event: { kind: "interaction.request", interactionId: "plan-1", interactionKind: "permission", title: "Approve plan", plan: { planId: "claude:plan-1", content: "# Plan\nDo the work" } },
    })).toMatchObject({ event: { plan: { planId: "claude:plan-1" } } });
    expect(parseHookEvent({
      version: 1, type: "event", eventId: "plan-2", sequence: 3,
      event: { kind: "interaction.request", interactionId: "plan-2", interactionKind: "permission", title: "Approve plan", plan: { planId: "bad id", content: "x" } },
    })).toBeNull();
  });

  test("keeps a verified hook connection alive after the handshake", async () => {
    const { createConnection } = await import("node:net");
    const dir = await mkdtemp(join(tmpdir(), "herdr-hook-live-"));
    const server = new AgentHookServer(dir, registry() as never, { publish: () => {} });
    try {
      await server.start();
      const socket = createConnection({ path: server.path });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => socket.write(`${JSON.stringify({
          version: 1, type: "hello", adapter: { kind: "pi", name: "relay", version: "1" },
          binding: { herdrSession: "default", paneId: "w1:p1", agent: "pi", nativeSession: native },
        })}\n`));
        socket.on("data", (chunk) => {
          if (!String(chunk).includes("hello_ack")) return;
          setTimeout(() => resolve(), 5_200);
        });
      });
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test("creates an owner-only socket and removes it on stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-hook-"));
    const server = new AgentHookServer(dir, registry() as never, { publish: () => {} });
    try {
      await server.start();
      const fs = await import("node:fs/promises");
      expect((await fs.stat(server.path)).mode & 0o777).toBe(0o600);
      await server.stop();
      await expect(fs.stat(server.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
