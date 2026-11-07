import { createHash } from "node:crypto";
import { activePiEntries, readSafePiTranscript, type PiTranscriptEntry } from "./pi-transcript.ts";
import { findClaudeTranscriptBySessionId, readSafeClaudeTranscript } from "./claude-transcript.ts";
import { ConversationService, LifecycleError } from "./conversations.ts";

export interface TranscriptRecord { id: string; type: "message"; role: string; content: unknown; toolCallId?: string; toolName?: string; isError?: boolean }
interface Binding { id: string; kind: "pi" | "claude"; cwd: string; native: { kind: "id" | "path"; source: string; value: string } }
export interface TranscriptSource { read(binding: Binding): Promise<string> }
const source: TranscriptSource = {
  async read(binding) {
    try {
      return binding.kind === "pi" ? await readSafePiTranscript(binding.native.value)
        : await readSafeClaudeTranscript(await findClaudeTranscriptBySessionId(binding.native.value));
    } catch { throw new LifecycleError(404, "transcript_unavailable", "Native transcript is unavailable or exceeds supported limits"); }
  },
};
export interface TranscriptPage { conversationId: string; kind: "pi" | "claude"; records: TranscriptRecord[]; nextCursor: string; hasMore: boolean }
const MAX_BATCH_BYTES = 512 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const PRIVATE_KEYS = /^(?:sessionId|session_id|transcriptPath|transcript_path|nativeSession|agent_session|api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|password|secret|env|headers)$/i;

/** Preserve native content shape, not opaque top-level execution/config records. */
export function publicTranscriptContent(value: unknown, nativeValue: string, depth = 0): unknown {
  if (depth > 32) throw new LifecycleError(413, "record_too_large", "Transcript content nesting exceeds the supported limit");
  if (typeof value === "string") return value.split(nativeValue).join("[private native reference]")
    .replace(/\/[^\s"'<>]*\/(?:\.pi\/agent\/sessions|\.claude\/projects)\/[^\s"'<>]+/g, "[private transcript path]")
    .replace(/\/[^\s"'<>]*\/uploads\/[A-Za-z0-9_.-]+/g, "[private relay upload]");
  if (Array.isArray(value)) return value.map((entry) => publicTranscriptContent(entry, nativeValue, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    PRIVATE_KEYS.test(key) ? "[redacted]" : publicTranscriptContent(entry, nativeValue, depth + 1)]));
  return value;
}
function parseComplete(text: string): Array<Record<string, unknown>> {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new LifecycleError(413, "transcript_too_large", "Transcript exceeds the supported limit");
  const end = text.lastIndexOf("\n");
  if (end < 0) return [];
  const lines = text.slice(0, end).split("\n").filter((line) => line.trim());
  if (lines.length > 20_000) throw new LifecycleError(413, "transcript_too_large", "Transcript has too many records");
  return lines.map((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      return entry as Record<string, unknown>;
    } catch { throw new LifecycleError(409, "transcript_invalid", "Native transcript has an invalid complete record"); }
  });
}
function project(binding: Binding, text: string): TranscriptRecord[] {
  const entries = parseComplete(text);
  if (!entries.length) return [];
  const proof = entries.some((entry) => entry.cwd === binding.cwd && (binding.kind === "pi"
    ? entry.type === "session" && typeof entry.id === "string"
    : entry.sessionId === binding.native.value));
  if (!proof) throw new LifecycleError(409, "native_identity_mismatch", "Transcript does not match the saved conversation");
  const selected = binding.kind === "pi" ? activePiEntries(entries as unknown as PiTranscriptEntry[]) : entries;
  const result: TranscriptRecord[] = [];
  for (const item of selected) {
    const entry = item as Record<string, unknown>;
    const message = entry.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const msg = message as Record<string, unknown>;
    if (binding.kind === "claude" && (entry.isSidechain === true || !["user", "assistant"].includes(String(entry.type)) || entry.sessionId !== binding.native.value)) continue;
    if (binding.kind === "pi" && entry.type !== "message") continue;
    const id = binding.kind === "pi" ? entry.id : entry.uuid;
    if (typeof id !== "string" || id.length > 256 || typeof msg.role !== "string" || !["user", "assistant", "toolResult"].includes(msg.role)) continue;
    result.push({ id: publicTranscriptContent(id, binding.native.value) as string, type: "message", role: msg.role,
      content: publicTranscriptContent(msg.content ?? [], binding.native.value),
      ...(typeof msg.toolCallId === "string" ? { toolCallId: publicTranscriptContent(msg.toolCallId, binding.native.value) as string } : {}),
      ...(typeof msg.toolName === "string" ? { toolName: publicTranscriptContent(msg.toolName, binding.native.value) as string } : {}),
      ...(typeof msg.isError === "boolean" ? { isError: msg.isError } : {}),
    });
  }
  return result;
}

/** Bounded native history with prefix-bound cursors; no launch or prompt side effects. */
export class TranscriptService {
  // Short cache bounds concurrent SSE/history reads without retaining an unbounded transcript set.
  private cache = new Map<string, { until: number; pending: Promise<TranscriptRecord[]> }>();
  constructor(private readonly conversations: Pick<ConversationService, "transcriptBinding">, private readonly fs = source, private readonly now = Date.now) {}
  async page(id: string, opts: { session?: string; cursor?: string; limit?: number } = {}): Promise<TranscriptPage> {
    const limit = opts.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new LifecycleError(400, "invalid_request", "limit must be between 1 and 200");
    const binding = this.conversations.transcriptBinding(id, opts.session);
    const key = digest(JSON.stringify(binding));
    let cached = this.cache.get(key);
    if (!cached || cached.until <= this.now()) {
      if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
      cached = { until: this.now() + 750, pending: this.fs.read(binding).then((text) => project(binding, text)) };
      this.cache.set(key, cached);
    }
    const records = await cached.pending;
    let position = 0;
    const prefix = (n: number) => digest(JSON.stringify([id, binding.kind, records.slice(0, n)]));
    if (opts.cursor !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(opts.cursor)) throw new LifecycleError(400, "invalid_cursor", "Invalid transcript cursor");
      let parsed: { v: number; n: number; h: string };
      try { parsed = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8")); }
      catch { throw new LifecycleError(400, "invalid_cursor", "Invalid transcript cursor"); }
      if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.n) || parsed.n < 0 || typeof parsed.h !== "string") throw new LifecycleError(400, "invalid_cursor", "Invalid transcript cursor");
      position = parsed.n;
      if (position > records.length || parsed.h !== prefix(position)) throw new LifecycleError(409, "transcript_reset", "Retained transcript prefix changed; restart from history beginning");
    }
    const batch: TranscriptRecord[] = [];
    let bytes = 0;
    while (position < records.length && batch.length < limit) {
      const record = records[position]!;
      const size = Buffer.byteLength(JSON.stringify(record));
      if (size > MAX_BATCH_BYTES) throw new LifecycleError(413, "record_too_large", "Native record exceeds the supported response size");
      if (bytes + size > MAX_BATCH_BYTES) break;
      batch.push(record); bytes += size; position++;
    }
    const nextCursor = Buffer.from(JSON.stringify({ v: 1, n: position, h: prefix(position) })).toString("base64url");
    return { conversationId: id, kind: binding.kind, records: batch, nextCursor, hasMore: position < records.length };
  }
}
