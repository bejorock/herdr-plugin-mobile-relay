import { describe, expect, test } from "bun:test";

import { PiAcpCanceller } from "./cancel.ts";

describe("PiAcpCanceller", () => {
  test("sends Escape only to a working or blocked Pi pane", async () => {
    const sent: unknown[] = [];
    const registry = {
      binding: () => ({
        agent: { agent: "pi", paneId: "p1", status: "working" },
        runtime: { herdr: { sendPaneKeys: async (...args: unknown[]) => void sent.push(args) } },
      }),
    };
    await new PiAcpCanceller(registry as never).cancel("s1");
    expect(sent).toEqual([["p1", ["Escape"]]]);
  });

  test("does not type a cancellation key into idle agents", async () => {
    const sent: unknown[] = [];
    const registry = {
      binding: () => ({
        agent: { agent: "pi", paneId: "p1", status: "idle" },
        runtime: { herdr: { sendPaneKeys: async (...args: unknown[]) => void sent.push(args) } },
      }),
    };
    await new PiAcpCanceller(registry as never).cancel("s1");
    expect(sent).toEqual([]);
  });
});
