import { describe, expect, test } from "bun:test";

import { tailPiTranscript } from "./tailer.ts";

describe("Pi transcript tailer", () => {
  test("emits a newly appended entry once without replaying existing history", async () => {
    let text = `${JSON.stringify({ type: "message", id: "old", message: { role: "user", content: "old" } })}\n`;
    let listener: (() => void) | undefined;
    const updates: unknown[] = [];
    const tail = await tailPiTranscript({
      path: "/safe.jsonl",
      sessionId: "s1",
      debounceMs: 1,
      onUpdate: (update) => updates.push(update),
      fs: {
        read: async () => text,
        watch: (_path, next) => {
          listener = next;
          return { close() {} };
        },
      },
    });
    text += `${JSON.stringify({ type: "message", id: "new", parentId: "old", message: { role: "assistant", content: [{ type: "text", text: "new response" }] } })}\n`;
    listener!();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(updates).toEqual([
      {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message", messageId: "pi:agent:new", content: [{ type: "text", text: "new response" }] },
      },
    ]);
    tail.close();
  });
});
