import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAcpPromptSender } from "./prompt.ts";
import { MAX_IMAGE_UPLOAD_BYTES, savePrivateImageUpload } from "../uploads.ts";


describe("PiAcpPromptSender", () => {
  test("serializes prompts and refuses sessions without a supported native binding", async () => {
    const sender = new PiAcpPromptSender({ binding: () => undefined } as never, "/tmp/state");
    await expect(sender.send({ sessionId: "missing", text: "hello" })).rejects.toThrow("Session not found");
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
