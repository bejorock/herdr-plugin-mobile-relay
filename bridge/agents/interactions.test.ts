import { describe, expect, test } from "bun:test";
import { InteractionBroker } from "./interactions.ts";

describe("native interaction broker", () => {
  test("retains requests independently of subscribers and accepts one valid answer", () => {
    const broker = new InteractionBroker();
    const answers: unknown[] = [];
    const input = { id: "i1", sessionId: "s1", kind: "permission" as const, title: "Run?", options: [{ optionId: "allow", name: "Allow" }], resolveHook: (answer: unknown) => answers.push(answer) };
    expect(broker.request(input)).toBe(true);
    expect(broker.request(input)).toBe(false);
    expect(broker.list()).toHaveLength(1);
    expect(broker.resolve("i1", { optionId: "invented" })).toBe(false);
    expect(broker.resolve("i1", { optionId: "allow" })).toBe(true);
    expect(broker.resolve("i1", { optionId: "allow" })).toBe(false);
    expect(answers).toEqual([{ optionId: "allow" }]);
    expect(broker.list()).toEqual([]);
  });
  test("validates question responses before consuming a pending request", () => {
    const broker = new InteractionBroker();
    broker.request({ id: "q1", sessionId: "s1", kind: "elicitation", title: "Choose", schema: { properties: { answer: { type: "string", enum: ["yes", "no"] } }, required: ["answer"] }, resolveHook: () => {} });
    expect(broker.resolve("q1", { action: "accept", content: { answer: "other" } })).toBe(false);
    expect(broker.resolve("q1", { action: "accept", content: { answer: "yes" } })).toBe(true);
  });
  test("expires or closes pending callbacks without approving them", async () => {
    const broker = new InteractionBroker(1);
    const answers: unknown[] = [];
    broker.request({ id: "i1", sessionId: "s1", kind: "permission", title: "Wait", resolveHook: (value) => answers.push(value) });
    await Bun.sleep(10);
    expect(answers).toEqual([{ outcome: "cancelled", reason: "timed_out" }]);
    broker.request({ id: "i2", sessionId: "s1", kind: "permission", title: "Wait", resolveHook: (value) => answers.push(value) });
    broker.close();
    expect(answers.at(-1)).toEqual({ outcome: "cancelled", reason: "connection_closed" });
  });
});
