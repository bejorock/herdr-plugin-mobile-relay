import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAcpPromptSender, promptWhenAgentReady } from "./prompt.ts";
import { HerdrRpcError } from "../wire.ts";
import { MAX_IMAGE_UPLOAD_BYTES, savePrivateImageUpload } from "../uploads.ts";


describe("PiAcpPromptSender", () => {
  test("serializes prompts and refuses sessions without a supported native binding", async () => {
    const sender = new PiAcpPromptSender({ binding: () => undefined } as never, "/tmp/state");
    await expect(sender.send({ sessionId: "missing", text: "hello" })).rejects.toThrow("Session not found");
  });

  test("retries only Herdr's definitive agent_not_ready prompt rejection", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await promptWhenAgentReady({ promptAgent: async () => {
      attempts++;
      if (attempts === 1) throw new HerdrRpcError("agent.prompt", "agent_not_ready", "not ready");
    } }, "w1:p1", "hello", async (ms) => { delays.push(ms); });
    expect(attempts).toBe(2);
    expect(delays).toEqual([250]);
  });

  test("does not retry an ambiguous or other Herdr prompt error", async () => {
    let attempts = 0;
    await expect(promptWhenAgentReady({ promptAgent: async () => {
      attempts++;
      throw new HerdrRpcError("agent.prompt", "agent_prompt_failed", "unknown delivery state");
    } }, "w1:p1", "hello", async () => {})).rejects.toThrow("agent_prompt_failed");
    expect(attempts).toBe(1);
  });

  test("stores image bytes as a private server-named upload", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "herdr-acp-image-"));
    try {
      const path = await savePrivateImageUpload({
        stateDir,
        paneId: "w1:p1",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      });
      expect(path).toMatch(/uploads\/w1_p1-.*\.png$/);
      expect((await Bun.file(path).arrayBuffer()).byteLength).toBe(3);
      await expect(savePrivateImageUpload({
        stateDir,
        paneId: "p",
        mimeType: "image/bmp",
        bytes: new Uint8Array([1]),
      })).rejects.toThrow("unsupported image type");
      await expect(savePrivateImageUpload({
        stateDir,
        paneId: "p",
        mimeType: "image/png",
        bytes: new Uint8Array(MAX_IMAGE_UPLOAD_BYTES + 1),
      })).rejects.toThrow("image too large");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
