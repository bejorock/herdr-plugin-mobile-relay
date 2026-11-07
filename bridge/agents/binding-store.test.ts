import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBindingStore } from "./binding-store.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const binding = {
  id: "herdr_12345678901234567890123456789012",
  herdrSession: "default",
  paneId: "w1:p1",
  workspaceId: "w1",
  cwd: "/home/u/project",
  agent: "claude" as const,
  nativeSource: "herdr:claude",
  nativeKind: "id" as const,
  nativeValue: "native-id",
  transcriptPath: "/home/u/.claude/projects/test/session.jsonl",
};

describe("AgentBindingStore", () => {
  test("persists only validated private Claude binding metadata with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-agent-bindings-"));
    directories.push(directory);
    const store = new AgentBindingStore(directory);
    store.upsert(binding);
    expect(new AgentBindingStore(directory).values()).toEqual([binding]);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  test("retains legacy v1 Claude bindings for live rebinding but marks them unrecoverable by absent workspace data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-agent-bindings-"));
    directories.push(directory);
    const legacy = { ...binding };
    delete (legacy as { workspaceId?: string }).workspaceId;
    delete (legacy as { cwd?: string }).cwd;
    await writeFile(join(directory, "agent-bindings.json"), JSON.stringify({ version: 1, bindings: [legacy] }));
    expect(new AgentBindingStore(directory).values()).toEqual([legacy]);
  });

  test("fails closed on malformed persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-agent-bindings-"));
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "agent-bindings.json"), JSON.stringify({ version: 1, bindings: [{ id: "not-opaque" }] }));
    expect(new AgentBindingStore(directory).values()).toEqual([]);
  });
});
