import { describe, expect, test } from "bun:test";

import { activePiEntries, parsePiTranscript, piHistoryUpdates, piUserMessageIdForText, readSafePiTranscript } from "./pi-transcript.ts";

describe("Pi transcript adapter", () => {
  test("replays only the active branch as complete ACP messages and thoughts", () => {
    const entries = parsePiTranscript([
      JSON.stringify({ type: "session", id: "session" }),
      JSON.stringify({ type: "message", id: "user-1", parentId: null, message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "message", id: "old", parentId: "user-1", message: { role: "assistant", content: [{ type: "text", text: "old branch" }] } }),
      JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "current branch" }] } }),
      JSON.stringify({ type: "usage", id: "leaf", parentId: "assistant-1" }),
    ].join("\n"));

    expect(activePiEntries(entries).map((entry) => entry.id)).toEqual(["user-1", "assistant-1", "leaf"]);
    expect(piHistoryUpdates("acp-1", entries)).toEqual([
      {
        sessionId: "acp-1",
        update: { sessionUpdate: "user_message", messageId: "pi:user:user-1", content: [{ type: "text", text: "hello" }] },
      },
      {
        sessionId: "acp-1",
        update: { sessionUpdate: "agent_thought", messageId: "pi:thought:assistant-1", content: [{ type: "text", text: "reason" }] },
      },
      {
        sessionId: "acp-1",
        update: { sessionUpdate: "agent_message", messageId: "pi:agent:assistant-1", content: [{ type: "text", text: "current branch" }] },
      },
    ]);
  });

  test("finds a matching active-branch user message by exact content", () => {
    const entries = parsePiTranscript([
      JSON.stringify({ type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } }),
      JSON.stringify({ type: "message", id: "wanted", parentId: "old", message: { role: "user", content: [{ type: "text", text: "send this" }] } }),
    ].join("\n"));
    expect(piUserMessageIdForText(entries, "send this")).toBe("wanted");
    expect(piUserMessageIdForText(entries, "missing")).toBeUndefined();
  });

  test("ignores an incomplete final JSONL append", () => {
    const entries = parsePiTranscript(`${JSON.stringify({ type: "message", id: "one", message: { role: "user", content: "ok" } })}\n{"type":"message"`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("one");
  });

  test("rejects paths outside Pi session storage before reading", async () => {
    const calls: string[] = [];
    const fs = {
      realpath: async (path: string) => {
        calls.push(`realpath:${path}`);
        return path === "/home/u/.pi/agent/sessions" ? path : "/etc/passwd";
      },
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }),
      readFile: async () => "should not read",
    };
    await expect(readSafePiTranscript("/home/u/.pi/agent/sessions/x.jsonl", { home: "/home/u", fs })).rejects.toThrow(
      "outside the permitted session directory",
    );
    expect(calls).toHaveLength(2);
  });

  test("rejects symlinked and oversized transcript files", async () => {
    const baseFs = {
      realpath: async (path: string) => path,
      readFile: async () => "",
    };
    await expect(readSafePiTranscript("/home/u/.pi/agent/sessions/x.jsonl", {
      home: "/home/u",
      fs: { ...baseFs, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 1 }) },
    })).rejects.toThrow("regular non-symlink");
    await expect(readSafePiTranscript("/home/u/.pi/agent/sessions/x.jsonl", {
      home: "/home/u",
      fs: { ...baseFs, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 99 }) },
      maxBytes: 10,
    })).rejects.toThrow("replay size limit");
  });
});
