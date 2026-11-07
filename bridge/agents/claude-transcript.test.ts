import { describe, expect, test } from "bun:test";

import { findClaudeTranscriptBySessionId, parseClaudeTranscript, readSafeClaudeTranscript, redactRelayUploadPaths } from "./claude-transcript.ts";

describe("Claude transcript adapter", () => {
  test("preserves native messages and tool calls without protocol translation", () => {
    const entries = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "bash" }] } }),
      JSON.stringify({ type: "assistant", uuid: "side", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "hidden" }] } }),
    ].join("\n"));
    expect(entries).toHaveLength(3);
    expect(entries[1]?.message?.content).toEqual(expect.arrayContaining([{ type: "tool_use", id: "t", name: "bash" }]));
  });

  test("redacts server-private relay image paths from replayed content", () => {
    expect(redactRelayUploadPaths("Analyze /opt/state/uploads/pane-random.png now")).toBe("Analyze [private relay image] now");

  });

  test("finds exactly one safe transcript by Herdr-provided Claude UUID", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const root = "/home/u/.claude/projects";
    const path = `${root}/-repo/${id}.jsonl`;
    const fs = {
      realpath: async (value: string) => value,
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }),
      readFile: async () => "",
      readdir: async (value: string) => value === root
        ? [{ name: "-repo", isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }]
        : [{ name: `${id}.jsonl`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }],
    };
    await expect(findClaudeTranscriptBySessionId(id, { home: "/home/u", fs })).resolves.toBe(path);
    await expect(findClaudeTranscriptBySessionId("not-a-uuid", { home: "/home/u", fs })).rejects.toThrow("invalid");
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
