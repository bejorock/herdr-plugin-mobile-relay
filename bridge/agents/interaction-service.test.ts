import { describe, expect, test } from "bun:test";
import { InteractionService } from "./interaction-service.ts";
import type { ConversationService } from "./conversations.ts";
import type { HookBinding, HookEvent } from "./hook.ts";
import { HerdrEventHub, type SseWriter } from "../http-events.ts";
const binding: HookBinding = { agentBindingId: "private", ownerId: "socket1", connected: () => true, agent: "pi", herdrSession: "default", paneId: "p1", nativeSession: { source: "herdr:pi", agent: "pi", kind: "path", value: "/private/session.jsonl" } };
const event = (id: string): Extract<HookEvent["event"], { kind: "interaction.request" }> => ({ kind: "interaction.request", interactionId: id, interactionKind: "permission", title: "Run?", options: [{ optionId: "allow_once", name: "Allow" }, { optionId: "reject_once", name: "Deny" }], executionId: id });
function harness() {
  let stale = false;
  const conversations = { runtime: (name?: string) => { if (name && name !== "default") throw new Error("wrong runtime"); return { name: "default" }; }, attachNative: async () => ({ id: "conversation1" }), verifyNative: async () => { if (stale) throw new Error("changed"); } } as unknown as ConversationService;
  const events: unknown[] = []; const hub = new HerdrEventHub();
  const writer: SseWriter = { send: (event, data) => { events.push({ event, data }); return true; }, close: () => {}, onClose: () => {} };
  hub.subscribe("default", writer); events.length = 0;
  return { service: new InteractionService(conversations, hub), events, stale: () => { stale = true; } };
}
describe("native interaction HTTP service", () => {
  test("two forwarded child requests route unique answers to their own callbacks", async () => {
    const h = harness(); const a: unknown[] = [], b: unknown[] = [];
    await h.service.request(binding, event("workflow-child-a"), (outcome) => a.push(outcome));
    await h.service.request(binding, event("workflow-child-b"), (outcome) => b.push(outcome));
    const pending = h.service.list(); expect(pending.interactions).toHaveLength(2);
    expect(h.events).toHaveLength(2);
    const first = pending.interactions.find((i) => i.executionId === "workflow-child-a")!;
    const second = pending.interactions.find((i) => i.executionId === "workflow-child-b")!;
    await expect(h.service.respond(first.id, { optionId: "unknown" })).rejects.toMatchObject({ code: "invalid_response" });
    expect(h.service.list().interactions).toHaveLength(2);
    await h.service.respond(second.id, { optionId: "reject_once" }); await h.service.respond(first.id, { optionId: "allow_once" });
    expect(a).toEqual([{ optionId: "allow_once" }]); expect(b).toEqual([{ optionId: "reject_once" }]);
    await expect(h.service.respond(first.id, { optionId: "allow_once" })).rejects.toMatchObject({ code: "interaction_unknown" });
    expect(JSON.stringify(h.events)).not.toContain("/private/session");
    h.service.close();
  });
  test("native identity change and owner disconnect never approve requests", async () => {
    const h = harness(); const answers: unknown[] = [];
    await h.service.request(binding, event("one"), (v) => answers.push(v)); const id = h.service.list().interactions[0]!.id; h.stale();
    await expect(h.service.respond(id, { optionId: "allow_once" })).rejects.toMatchObject({ code: "interaction_stale" });
    expect(answers).toEqual([{ outcome: "cancelled", reason: "native_identity_changed" }]);
    const other = harness(); await other.service.request(binding, event("two"), (v) => answers.push(v)); other.service.closeOwner(binding);
    expect(other.service.list().interactions).toEqual([]); expect(answers.at(-1)).toEqual({ outcome: "cancelled", reason: "owner_disconnected" });
  });
  test("parent cancellation only resolves the matching native request", async () => {
    const h = harness(); const answers: unknown[] = [];
    await h.service.request(binding, event("one"), (v) => answers.push(v)); await h.service.request(binding, event("two"), () => {});
    h.service.cancelNative(binding, "one"); expect(h.service.list().interactions).toHaveLength(1);
    expect(answers).toEqual([{ outcome: "cancelled", reason: "owner_cancelled" }]); h.service.close();
  });
});
