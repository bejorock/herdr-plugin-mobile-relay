import { describe, expect, test } from "bun:test";

import { claudeHistoryUpdates, parseClaudeTranscript, readSafeClaudeTranscript, redactRelayUploadPaths } from "./claude-transcript.ts";

describe("Claude transcript adapter", () => {
  test("replays non-sidechain user and assistant text messages", () => {
    const entries = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "bash" }] } }),
      JSON.stringify({ type: "assistant", uuid: "side", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "hidden" }] } }),
    ].join("\n"));
    expect(claudeHistoryUpdates("s1", entries)).toEqual([
      { sessionId: "s1", update: { sessionUpdate: "user_message", messageId: "claude:user:u1", content: [{ type: "text", text: "hello" }] } },
      { sessionId: "s1", update: { sessionUpdate: "agent_message", messageId: "claude:agent:a1", content: [{ type: "text", text: "hi" }] } },
    ]);
  });

  test("redacts server-private relay image paths from replayed content", () => {
    expect(redactRelayUploadPaths("Analyze /opt/state/uploads/pane-random.png now")).toBe("Analyze [private relay image] now");
    const entries = parseClaudeTranscript(JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "Analyze the image at: /opt/state/uploads/pane-random.png" } }));
    expect(JSON.stringify(claudeHistoryUpdates("s1", entries))).not.toContain("/opt/state/uploads");
  });

  test("rejects transcript paths outside Claude projects", async () => {
    const fs = {
      realpath: async (path: string) => path === "/home/u/.claude/projects" ? path : "/etc/passwd",
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }),
      readFile: async () => "no",
    };
    await expect(readSafeClaudeTranscript("/home/u/.claude/projects/x.jsonl", { home: "/home/u", fs })).rejects.toThrow("outside the permitted");
  });
});
