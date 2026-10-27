import { describe, expect, test } from "bun:test";

import { HerdrAcpProvisioner, parseHerdrNewSessionMeta } from "./provision.ts";

function runtime(input: { workspaces: unknown[]; agents?: unknown[]; shellPanes?: unknown[] }) {
  const calls: Array<{ method: string; args: unknown }> = [];
  return {
    calls,
    registry: {
      get: () => ({
        name: "default",
        engine: {
          current: () => ({
            bridge: "connected" as const,
            workspaces: input.workspaces,
            agents: input.agents ?? [],
            shellPanes: input.shellPanes ?? [],
          }),
        },
        herdr: {
          createTab: async (...args: unknown[]) => {
            calls.push({ method: "tab", args });
            return { paneId: "p-new", workspaceId: "w-existing", tabId: "t-new", cwd: "/repo" };
          },
          createWorkspace: async (...args: unknown[]) => {
            calls.push({ method: "workspace", args });
            return { paneId: "p-new", workspaceId: "w-new", workspaceLabel: "repo", tabId: "t-new", cwd: "/repo" };
          },
          startAgent: async (...args: unknown[]) => {
            calls.push({ method: "start", args });
            return {
              paneId: "p-new", workspaceId: "w-existing", tabId: "t-new", cwd: "/repo",
              agent: "pi", status: "idle", focused: false, interactiveReady: true, launchPending: false,
              agentSession: { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/home/u/.pi/agent/sessions/x.jsonl" },
            };
          },
        },
      }),
    },
  };
}

describe("HerdrAcpProvisioner", () => {
  test("requires an explicit supported agent in herdr.dev metadata", () => {
    expect(parseHerdrNewSessionMeta(undefined)).toBeNull();
    expect(parseHerdrNewSessionMeta({ "herdr.dev": { agent: { kind: "not-real" } } })).toBeNull();
    expect(parseHerdrNewSessionMeta({ "herdr.dev": { agent: { kind: "pi", args: ["--model", "x"] } } })).toEqual({
      kind: "pi",
      args: ["--model", "x"],
    });
  });

  test("reuses an exact-root workspace by creating a fresh tab then starts the selected agent", async () => {
    const fake = runtime({
      workspaces: [{ workspaceId: "w-existing", worktree: { checkoutPath: "/repo" }, focused: true }],
    });
    const provisioner = new HerdrAcpProvisioner(fake.registry as never);
    const session = await provisioner.create({ cwd: "/repo", agent: { kind: "pi", args: ["--model", "x"] } });
    expect(fake.calls).toEqual([
      { method: "tab", args: ["w-existing", { cwd: "/repo" }] },
      { method: "start", args: [{ paneId: "p-new", kind: "pi", name: "pi", args: ["--model", "x"] }] },
    ]);
    expect(session).toMatchObject({ cwd: "/repo", agent: "pi", paneId: "p-new", hasNativeSession: true });
  });

  test("creates a workspace when no exact root matches and rejects relative cwd", async () => {
    const fake = runtime({ workspaces: [{ workspaceId: "w-parent", worktree: { checkoutPath: "/" }, focused: true }] });
    const provisioner = new HerdrAcpProvisioner(fake.registry as never);
    await expect(provisioner.create({ cwd: "relative", agent: { kind: "pi", args: [] } })).rejects.toThrow("absolute");
    await provisioner.create({ cwd: "/repo", agent: { kind: "pi", args: [] } });
    expect(fake.calls[0]).toEqual({ method: "workspace", args: [{ cwd: "/repo" }] });
  });
});
