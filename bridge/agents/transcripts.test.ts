import { describe, expect, test } from "bun:test";
import { TranscriptService, publicTranscriptContent } from "./transcripts.ts";
import type { ConversationService } from "./conversations.ts";
const native = "/home/u/.pi/agent/sessions/private.jsonl";
const piSession = { type: "session", id: "native-id", cwd: "/repo" };
const line = (entry: unknown) => JSON.stringify(entry) + "\n";
function harness(kind: "pi" | "claude" = "pi") {
  let time = 0; let text = ""; let reads = 0;
  const binding = { id: "conversation-one", kind, cwd: "/repo", native: { source: `herdr:${kind}`, kind: kind === "pi" ? "path" as const : "id" as const, value: kind === "pi" ? native : "123e4567-e89b-42d3-a456-426614174000" } };
  const conversations = { transcriptBinding: (id: string, session?: string) => { if (id !== binding.id || (session && session !== "default")) throw new Error("wrong binding"); return binding; } } as unknown as ConversationService;
  const service = new TranscriptService(conversations, { read: async () => { reads++; return text; } }, () => time);
  return { service, binding, set: (value: string) => { text = value; time += 1000; }, get reads() { return reads; } };
}
describe("native HTTP transcript history", () => {
  test("preserves Pi native tool calls/results on active branch, without config/session records", async () => {
    const h = harness();
    const tool = { type: "toolCall", id: "call-1", name: "ask_user_question", arguments: { question: "Choose?", options: ["a", "b"] } };
    h.set(line(piSession) + line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "Hello" } }) + line({ type: "message", id: "old", parentId: "u1", message: { role: "assistant", content: "abandoned" } }) + line({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [tool] } }) + line({ type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "call-1", toolName: "ask_user_question", content: [{ type: "text", text: "a" }] } }));
    const page = await h.service.page(h.binding.id);
    expect(page.records.map((r) => r.id)).toEqual(["u1", "a1", "r1"]);
    expect(page.records[1]?.content).toEqual([tool]); expect(page.records[2]?.toolCallId).toBe("call-1");
    expect(JSON.stringify(page)).not.toContain("native-id");
  });
  test("Claude excludes api-request blobs, sidechains, and wrong native sessions", async () => {
    const h = harness("claude"); const sessionId = h.binding.native.value;
    const msg = (type: string, uuid: string, extra = {}) => ({ type, uuid, sessionId, cwd: "/repo", message: { role: type === "assistant" ? "assistant" : "user", content: [{ type: "tool_use", id: "call1", name: "AskUserQuestion", input: { questions: [] } }] }, ...extra });
    h.set(line(msg("user", "u1")) + line(msg("api-request-blob", "internal")) + line(msg("assistant", "side", { isSidechain: true })) + line(msg("assistant", "other", { sessionId: "other" })) + line(msg("assistant", "a1")));
    const page = await h.service.page(h.binding.id);
    expect(page.records.map((r) => r.id)).toEqual(["u1", "a1"]);
    expect(page.records[1]?.content).toEqual([{ type: "tool_use", id: "call1", name: "AskUserQuestion", input: { questions: [] } }]);
  });
  test("ignores incomplete final JSONL append and exposes it only after newline", async () => {
    const h = harness(); const entry = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } };
    h.set(line(piSession) + JSON.stringify(entry)); expect((await h.service.page(h.binding.id)).records).toEqual([]);
    h.set(line(piSession) + line(entry)); expect((await h.service.page(h.binding.id)).records).toHaveLength(1);
  });
  test("append-safe paginated cursor resets on branch/truncation/prefix changes", async () => {
    const h = harness(); const u = line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } });
    const a = line({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } });
    h.set(line(piSession) + u); const first = await h.service.page(h.binding.id, { limit: 1 });
    h.set(line(piSession) + u + a); const second = await h.service.page(h.binding.id, { cursor: first.nextCursor });
    expect(second.records.map((r) => r.id)).toEqual(["a1"]);
    expect((await h.service.page(h.binding.id, { cursor: second.nextCursor })).records).toEqual([]);
    h.set(line(piSession) + u); await expect(h.service.page(h.binding.id, { cursor: second.nextCursor })).rejects.toMatchObject({ code: "transcript_reset" });
    h.set(line(piSession) + line({ type: "message", id: "new", parentId: null, message: { role: "user", content: "new branch" } }));
    await expect(h.service.page(h.binding.id, { cursor: first.nextCursor })).rejects.toMatchObject({ code: "transcript_reset" });
  });
  test("rejects malformed cursors, records, invalid identity, and excessive records", async () => {
    const h = harness(); h.set(line(piSession));
    await expect(h.service.page(h.binding.id, { cursor: "!" })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(h.service.page(h.binding.id, { limit: 201 })).rejects.toMatchObject({ code: "invalid_request" });
    h.set(line(piSession) + "bad-json\n"); await expect(h.service.page(h.binding.id)).rejects.toMatchObject({ code: "transcript_invalid" });
    h.set(line({ ...piSession, cwd: "/wrong" })); await expect(h.service.page(h.binding.id)).rejects.toMatchObject({ code: "native_identity_mismatch" });
    h.set(line(piSession) + line({ type: "message", id: "big", parentId: null, message: { role: "user", content: "x".repeat(600 * 1024) } }));
    await expect(h.service.page(h.binding.id)).rejects.toMatchObject({ code: "record_too_large" });
  });
  test("redacts native references, relay upload paths and known structured credentials", () => {
    expect(publicTranscriptContent({ text: `At ${native} /tmp/state/uploads/secret.png`, arguments: { api_key: "secret", env: { TOKEN: "secret" }, question: "safe" } }, native)).toEqual({ text: "At [private native reference] [private relay upload]", arguments: { api_key: "[redacted]", env: "[redacted]", question: "safe" } });
  });
  test("shares short-lived concurrent file reads", async () => {
    const h = harness(); h.set(line(piSession));
    await Promise.all(Array.from({ length: 4 }, () => h.service.page(h.binding.id)));
    expect(h.reads).toBe(1);
  });
});
