import { parsePiTranscript, piUserMessageIdForText, readSafePiTranscript } from "./pi-transcript.ts";
import { parseClaudeTranscript, claudeUserMessageIdForText, readSafeClaudeTranscript } from "./claude-transcript.ts";
import { LiveAcpSessionRegistry } from "./session-registry.ts";
import { MAX_IMAGE_UPLOAD_BYTES, savePrivateImageUpload } from "../uploads.ts";

const PROMPT_CONFIRM_TIMEOUT_MS = 8_000;
const PROMPT_CONFIRM_POLL_MS = 150;

export interface AcpPromptInput {
  sessionId: string;
  text: string;
  images?: Array<{ mimeType: string; bytes: Uint8Array }>;
}

/**
 * Serializes semantic prompts per ACP session and only confirms success once Pi's durable transcript
 * contains the exact submitted user message. Herdr acknowledgement alone is not enough: terminal
 * delivery can race with a blocked/changed native TUI.
 */
export class PiAcpPromptSender {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: LiveAcpSessionRegistry,
    private readonly stateDir: string,
  ) {}

  send(input: AcpPromptInput): Promise<{ messageId: string }> {
    const prior = this.tails.get(input.sessionId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(() => this.deliver(input));
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(input.sessionId, tail);
    void tail.finally(() => {
      if (this.tails.get(input.sessionId) === tail) this.tails.delete(input.sessionId);
    });
    return operation;
  }

  private async deliver(input: AcpPromptInput): Promise<{ messageId: string }> {
    const binding = this.sessions.binding(input.sessionId);
    if (!binding) throw new Error("Session not found");
    const native = binding.agent.nativeSession;
    if (!native || native.kind !== "path") {
      throw new Error("This session does not support safe ACP prompt delivery");
    }
    if (native.agent === "pi") return await this.deliverPi(binding, input, native.value);
    if (native.agent === "claude") return await this.deliverClaude(binding, input, native.value);
    throw new Error("This session does not support safe ACP prompt delivery");
  }

  private async deliverPi(binding: NonNullable<ReturnType<LiveAcpSessionRegistry["binding"]>>, input: AcpPromptInput, path: string): Promise<{ messageId: string }> {
    const imagePaths: string[] = [];
    for (const image of input.images ?? []) {
      imagePaths.push(await savePrivateImageUpload({ stateDir: this.stateDir, paneId: binding.agent.paneId, mimeType: image.mimeType, bytes: image.bytes }));
    }
    const nativeText = [input.text, ...imagePaths.map((imagePath) => `@${imagePath}`)].filter(Boolean).join("\n\n");
    const before = await readSafePiTranscript(path);
    const existingIds = new Set(parsePiTranscript(before).filter((entry) => entry.message?.role === "user" && typeof entry.id === "string").map((entry) => entry.id!));
    await binding.runtime.herdr.promptAgent(binding.agent.paneId, nativeText);
    const deadline = Date.now() + PROMPT_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PROMPT_CONFIRM_POLL_MS));
      const entryId = piUserMessageIdForText(parsePiTranscript(await readSafePiTranscript(path)), nativeText, existingIds);
      if (entryId) return { messageId: `pi:user:${entryId}` };
    }
    throw new Error("Prompt delivery could not be confirmed from the native Pi transcript");
  }

  private async deliverClaude(binding: NonNullable<ReturnType<LiveAcpSessionRegistry["binding"]>>, input: AcpPromptInput, path: string): Promise<{ messageId: string }> {
    const imagePaths: string[] = [];
    for (const image of input.images ?? []) {
      imagePaths.push(await savePrivateImageUpload({ stateDir: this.stateDir, paneId: binding.agent.paneId, mimeType: image.mimeType, bytes: image.bytes }));
    }
    // Claude Code documents absolute image paths as a supported image-context workflow. Do not use
    // terminal clipboard emulation; the owner-only path exists only in the native prompt/transcript.
    const nativeText = [input.text, ...imagePaths.map((imagePath) => `Analyze the image at: ${imagePath}`)].filter(Boolean).join("\n\n");
    const before = await readSafeClaudeTranscript(path);
    const existing = new Set(parseClaudeTranscript(before).filter((entry) => entry.message?.role === "user" && typeof entry.uuid === "string").map((entry) => entry.uuid!));
    await binding.runtime.herdr.promptAgent(binding.agent.paneId, nativeText);
    const deadline = Date.now() + PROMPT_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PROMPT_CONFIRM_POLL_MS));
      const entryId = claudeUserMessageIdForText(parseClaudeTranscript(await readSafeClaudeTranscript(path)), nativeText, existing);
      if (entryId) return { messageId: `claude:user:${entryId}` };
    }
    throw new Error("Prompt delivery could not be confirmed from the native Claude transcript");
  }
}
