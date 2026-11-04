import { HerdrRpcError } from "../wire.ts";
import { parsePiTranscript, piUserMessageIdForText, readSafePiTranscript } from "./pi-transcript.ts";
import { parseClaudeTranscript, claudeUserMessageIdForText, readSafeClaudeTranscript } from "./claude-transcript.ts";
import { LiveAcpSessionRegistry } from "./session-registry.ts";
import { MAX_IMAGE_UPLOAD_BYTES, savePrivateImageUpload } from "../uploads.ts";

const PROMPT_CONFIRM_TIMEOUT_MS = 8_000;
const PROMPT_CONFIRM_POLL_MS = 150;
const AGENT_READY_TIMEOUT_MS = 10_000;
const AGENT_READY_RETRY_MS = 250;

export interface AcpPromptInput {
  sessionId: string;
  text: string;
  images?: Array<{ mimeType: string; bytes: Uint8Array }>;
}

/** Only retry Herdr's definitive no-delivery readiness rejection; never retry an ambiguous write. */
export async function promptWhenAgentReady(
  sender: { promptAgent(paneId: string, text: string): Promise<unknown> },
  paneId: string,
  text: string,
  sleep: (ms: number) => Promise<void> = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  for (;;) {
    try {
      await sender.promptAgent(paneId, text);
      return;
    } catch (error) {
      // `agent_not_ready` is a structured Herdr rejection before terminal delivery. It is safe to
      // retry the identical semantic prompt after a bounded delay; every other error may be
      // transport-ambiguous or post-delivery and must propagate exactly once.
      if (!(error instanceof HerdrRpcError) || error.code !== "agent_not_ready" || Date.now() >= deadline) throw error;
      await sleep(AGENT_READY_RETRY_MS);
    }
  }
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
    if (!native) throw new Error("This session does not support safe ACP prompt delivery");
    if (native.agent === "claude" && native.kind === "id") {
      // A new Claude SessionStart names its JSONL before the first prompt creates it. Submit via
      // Herdr, then discover only the exact `<native UUID>.jsonl` under Claude's private root and
      // use that transcript as the acceptance proof.
      return await this.deliverNewClaude(binding, input);
    }
    if (native.kind !== "path") throw new Error("This session does not support safe ACP prompt delivery");
    if (native.agent === "pi") {
      const result = await this.deliverPi(binding, input, native.value);
      // The proof loop above has just read a safe, real Pi transcript. Only now is this logical
      // session eligible for durable closed-pane recovery.
      this.sessions.persistBinding(input.sessionId);
      return result;
    }
    if (native.agent === "claude") return await this.deliverClaude(binding, input, native.value);
    throw new Error("This session does not support safe ACP prompt delivery");
  }

  private async deliverPi(binding: NonNullable<ReturnType<LiveAcpSessionRegistry["binding"]>>, input: AcpPromptInput, path: string): Promise<{ messageId: string }> {
    const imagePaths: string[] = [];
    for (const image of input.images ?? []) {
      imagePaths.push(await savePrivateImageUpload({ stateDir: this.stateDir, paneId: binding.agent.paneId, mimeType: image.mimeType, bytes: image.bytes }));
    }
    const nativeText = [input.text, ...imagePaths.map((imagePath) => `@${imagePath}`)].filter(Boolean).join("\n\n");
    // Pi may report its future transcript path before its first turn creates the JSONL. A missing
    // pre-prompt transcript is therefore an empty baseline, not a delivery failure. We still require
    // the post-prompt safe transcript proof before acknowledging or persisting this session.
    let existingIds = new Set<string>();
    try {
      existingIds = new Set(parsePiTranscript(await readSafePiTranscript(path))
        .filter((entry) => entry.message?.role === "user" && typeof entry.id === "string")
        .map((entry) => entry.id!));
    } catch {
      // First-turn transcript creation is expected here; the proof loop below remains mandatory.
    }
    await promptWhenAgentReady(binding.runtime.herdr, binding.agent.paneId, nativeText);
    const deadline = Date.now() + PROMPT_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PROMPT_CONFIRM_POLL_MS));
      try {
        const entryId = piUserMessageIdForText(parsePiTranscript(await readSafePiTranscript(path)), nativeText, existingIds);
        if (entryId) return { messageId: `pi:user:${entryId}` };
      } catch {
        // Pi has not created its transcript yet; keep waiting within the bounded proof window.
      }
    }
    throw new Error("Prompt delivery could not be confirmed from the native Pi transcript");
  }

  private async deliverNewClaude(binding: NonNullable<ReturnType<LiveAcpSessionRegistry["binding"]>>, input: AcpPromptInput): Promise<{ messageId: string }> {
    const imagePaths: string[] = [];
    for (const image of input.images ?? []) {
      imagePaths.push(await savePrivateImageUpload({ stateDir: this.stateDir, paneId: binding.agent.paneId, mimeType: image.mimeType, bytes: image.bytes }));
    }
    const nativeText = [input.text, ...imagePaths.map((imagePath) => `Analyze the image at: ${imagePath}`)].filter(Boolean).join("\n\n");
    await promptWhenAgentReady(binding.runtime.herdr, binding.agent.paneId, nativeText);
    const deadline = Date.now() + PROMPT_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PROMPT_CONFIRM_POLL_MS));
      if (!await this.sessions.discoverClaudeTranscript(input.sessionId)) continue;
      const refreshed = this.sessions.binding(input.sessionId);
      const path = refreshed?.agent.nativeSession?.kind === "path" ? refreshed.agent.nativeSession.value : undefined;
      if (!path) continue;
      try {
        const entryId = claudeUserMessageIdForText(parseClaudeTranscript(await readSafeClaudeTranscript(path)), nativeText);
        if (entryId) {
          this.sessions.persistBinding(input.sessionId);
          return { messageId: `claude:user:${entryId}` };
        }
      } catch { /* wait for Claude's async transcript writer */ }
    }
    throw new Error("Prompt delivery could not be confirmed from the native Claude transcript");
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
    await promptWhenAgentReady(binding.runtime.herdr, binding.agent.paneId, nativeText);
    const deadline = Date.now() + PROMPT_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PROMPT_CONFIRM_POLL_MS));
      const entryId = claudeUserMessageIdForText(parseClaudeTranscript(await readSafeClaudeTranscript(path)), nativeText, existing);
      if (entryId) return { messageId: `claude:user:${entryId}` };
    }
    throw new Error("Prompt delivery could not be confirmed from the native Claude transcript");
  }
}
