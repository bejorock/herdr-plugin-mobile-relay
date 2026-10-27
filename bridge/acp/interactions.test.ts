import { describe, expect, test } from "bun:test";

import { AcpInteractionBroker } from "./interactions.ts";

class Socket {
  sent: unknown[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
}

describe("AcpInteractionBroker", () => {
  test("broadcasts a permission request and accepts only the first resolution", () => {
    const broker = new AcpInteractionBroker(60_000);
    const a = new Socket();
    const b = new Socket();
    const outcomes: unknown[] = [];
    broker.request({
      sockets: [a, b],
      sessionId: "s1",
      id: "interaction-1",
      kind: "permission",
      title: "Run tests?",
      resolveHook: (outcome) => outcomes.push(outcome),
    });
    expect(a.sent[0]).toMatchObject({ method: "session/request_permission", id: "interaction-1" });
    expect(b.sent[0]).toMatchObject({ method: "session/request_permission", id: "interaction-1" });
    expect(broker.resolve("interaction-1", { outcome: { outcome: "selected", optionId: "allow_once" } })).toBe(true);
    expect(broker.resolve("interaction-1", { outcome: "cancelled" })).toBe(false);
    expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
  });

  test("forwards a validated elicitation form schema", () => {
    const broker = new AcpInteractionBroker(60_000);
    const socket = new Socket();
    broker.request({
      sockets: [socket],
      sessionId: "s1",
      id: "form-1",
      kind: "elicitation",
      title: "Environment",
      schema: {
        properties: { environment: { type: "string", enum: ["staging", "production"] } },
        required: ["environment"],
      },
      resolveHook: () => {},
    });
    expect(socket.sent[0]).toMatchObject({
      method: "elicitation/create",
      params: { requestedSchema: { type: "object", required: ["environment"] } },
    });
  });

  test("does not consume an elicitation until an accepted response matches its schema", () => {
    const broker = new AcpInteractionBroker(60_000);
    const outcomes: unknown[] = [];
    broker.request({
      sockets: [new Socket()],
      sessionId: "s1",
      id: "question-1",
      kind: "elicitation",
      title: "Choices",
      schema: {
        properties: {
          q1: { type: "string", oneOf: [{ const: "React", title: "React" }] },
          q2: { type: "array", items: { type: "string", enum: ["red", "blue"] }, minItems: 1, maxItems: 2 },
        },
        required: ["q1", "q2"],
      },
      resolveHook: (outcome) => outcomes.push(outcome),
    });
    expect(broker.resolve("question-1", { action: "accept", content: { q1: "Vue", q2: ["red"] } })).toBe(false);
    expect(broker.resolve("question-1", { action: "accept", content: { q1: "React", q2: ["red", "blue"] } })).toBe(true);
    expect(outcomes).toEqual([{ action: "accept", content: { q1: "React", q2: ["red", "blue"] } }]);
  });

  test("forwards explicit elicitation decline and cancel outcomes", () => {
    const broker = new AcpInteractionBroker(60_000);
    const outcomes: unknown[] = [];
    for (const [id, action] of [["declined", "decline"], ["cancelled", "cancel"]] as const) {
      broker.request({ sockets: [new Socket()], sessionId: "s1", id, kind: "elicitation", title: "Choose", schema: { properties: { answer: { type: "string" } }, required: ["answer"] }, resolveHook: (outcome) => outcomes.push(outcome) });
      expect(broker.resolve(id, { action })).toBe(true);
    }
    expect(outcomes).toEqual([{ action: "decline" }, { action: "cancel" }]);
  });

  test("expires a pending interaction with a cancellation outcome", async () => {
    const broker = new AcpInteractionBroker(1);
    const outcomes: unknown[] = [];
    broker.request({ sockets: [new Socket()], sessionId: "s1", id: "timeout", kind: "permission", title: "Wait", resolveHook: (outcome) => outcomes.push(outcome) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outcomes).toEqual([{ outcome: "cancelled", reason: "timed_out" }]);
  });

  test("keeps a request alive while another authorised client remains connected", () => {
    const broker = new AcpInteractionBroker(60_000);
    const a = new Socket();
    const b = new Socket();
    const outcomes: unknown[] = [];
    broker.request({ sockets: [a, b], sessionId: "s1", id: "shared", kind: "permission", title: "Run?", resolveHook: (outcome) => outcomes.push(outcome) });
    broker.closeSocket(a);
    expect(outcomes).toEqual([]);
    broker.closeSocket(b);
    expect(outcomes).toEqual([{ outcome: "cancelled", reason: "all_clients_disconnected" }]);
  });

  test("cancels pending requests when the ACP connection closes", () => {
    const broker = new AcpInteractionBroker(60_000);
    const outcomes: unknown[] = [];
    broker.request({
      sockets: [new Socket()],
      sessionId: "s1",
      id: "pending",
      kind: "elicitation",
      title: "Choose",
      resolveHook: (outcome) => outcomes.push(outcome),
    });
    broker.close();
    expect(outcomes).toEqual([{ outcome: "cancelled", reason: "connection_closed" }]);
  });
});
