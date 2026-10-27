import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpBindingStore } from "./binding-store.ts";
import { acpSessionIdFor, LiveAcpSessionRegistry } from "./session-registry.ts";

const agent = {
  paneId: "w1:p1", workspaceLabel: "relay", cwd: "/opt/workspaces/relay", agent: "pi", status: "idle" as const,
  nativeSession: { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/home/user/.pi/agent/sessions/one.jsonl" },
};

function sessions(agents: unknown[]) {
  const runtime = { name: "default", engine: { current: () => ({ bridge: "connected" as const, agents }) } };
  return { all: () => [runtime], get: (name?: string) => name === "default" || name === undefined ? runtime : undefined };
}

describe("LiveAcpSessionRegistry", () => {
  test("derives an opaque stable id without embedding Herdr or transcript identifiers", () => {
    const id = acpSessionIdFor({
      herdrSession: "default",
      paneId: "w1:p1",
      agent: "pi",
      nativeSource: "herdr:pi",
      nativeValue: "/home/user/.pi/agent/sessions/private.jsonl",
    });
    expect(id).toMatch(/^herdr_[A-Za-z0-9_-]{32}$/);
    expect(id).not.toContain("w1");
    expect(id).not.toContain("private");
  });

  test("binds a Claude hook transcript without changing the opaque ACP ID", () => {
    const claude = {
      ...agent,
      agent: "claude",
      paneId: "w1:p2",
      nativeSession: { source: "herdr:claude", agent: "claude", kind: "id" as const, value: "native-claude-id" },
    };
    const registry = new LiveAcpSessionRegistry(sessions([claude]) as never);
    const id = registry.list()[0]!.id;
    expect(registry.bindTranscript(id, "/home/u/.claude/projects/test/transcript.jsonl")).toBe(true);
    expect(registry.find(id)).toMatchObject({ id, nativeSession: { kind: "path", value: "/home/u/.claude/projects/test/transcript.jsonl" } });
    expect(registry.binding(id)?.agent.nativeSession).toMatchObject({ kind: "path", value: "/home/u/.claude/projects/test/transcript.jsonl" });
  });

  test("restores a persisted Claude transcript binding only when its live native ID still matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-acp-registry-"));
    try {
      const claude = { ...agent, agent: "claude", paneId: "w1:p2", nativeSession: { source: "herdr:claude", agent: "claude", kind: "id" as const, value: "native-claude-id" } };
      const source = new LiveAcpSessionRegistry(sessions([claude]) as never, new AcpBindingStore(directory));
      const id = source.list()[0]!.id;
      expect(source.bindTranscript(id, "/home/u/.claude/projects/test/restored.jsonl")).toBe(true);
      const restored = new LiveAcpSessionRegistry(sessions([claude]) as never, new AcpBindingStore(directory));
      expect(restored.find(id)).toMatchObject({ nativeSession: { kind: "path", value: "/home/u/.claude/projects/test/restored.jsonl" } });

      const stale = new LiveAcpSessionRegistry(sessions([{ ...claude, nativeSession: { ...claude.nativeSession, value: "different-id" } }]) as never, new AcpBindingStore(directory));
      expect(stale.find(id)).toBeUndefined();
      expect(new AcpBindingStore(directory).values()).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("projects only connected Herdr agent panes", () => {
    const registry = {
      all: () => [
        {
          name: "default",
          engine: {
            current: () => ({
              bridge: "connected" as const,
              agents: [
                {
                  paneId: "w1:p1",
                  workspaceLabel: "relay",
                  cwd: "/opt/workspaces/relay",
                  agent: "pi",
                  status: "idle" as const,
                  nativeSession: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "path" as const,
                    value: "/home/user/.pi/agent/sessions/one.jsonl",
                  },
                },
              ],
            }),
          },
        },
        {
          name: "offline",
          engine: { current: () => ({ bridge: "disconnected" as const, agents: [] }) },
        },
      ],
    };
    const sessions = new LiveAcpSessionRegistry(registry as never).list();
    expect(sessions).toEqual([
      expect.objectContaining({
        cwd: "/opt/workspaces/relay",
        title: "pi · relay",
        agent: "pi",
        herdrSession: "default",
        paneId: "w1:p1",
        nativeStatus: "idle",
        hasNativeSession: true,
      }),
    ]);
  });
});
