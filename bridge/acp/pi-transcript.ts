import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

/** A deliberately bounded ceiling for retained Pi history replay on one ACP resume. */
export const MAX_PI_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_PI_TRANSCRIPT_LINES = 20_000;
export const MAX_PI_CONTENT_CHARS = 512 * 1024;

export interface PiTranscriptEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: {
    role?: string;
    content?: unknown;
  };
}

export interface PiTranscriptFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
  readFile(path: string): Promise<string>;
}

const nodeFs: PiTranscriptFs = {
  realpath,
  lstat,
  readFile: async (path) => await Bun.file(path).text(),
};

export function piSessionRoot(home: string = homedir()): string {
  return join(home, ".pi", "agent", "sessions");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== "..";
}

/**
 * Resolve an adapter-supplied Pi transcript only under Pi's known session root. Both the root and
 * file are canonicalized; a symlink (including one inside the root) is rejected rather than read.
 */
export async function readSafePiTranscript(
  path: string,
  opts: { home?: string; fs?: PiTranscriptFs; maxBytes?: number } = {},
): Promise<string> {
  const fs = opts.fs ?? nodeFs;
  const root = await fs.realpath(piSessionRoot(opts.home));
  const requested = resolve(path);
  const resolved = await fs.realpath(requested);
  if (!isWithin(root, resolved)) throw new Error("Pi transcript is outside the permitted session directory");
  const stat = await fs.lstat(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Pi transcript must be a regular non-symlink file");
  const maxBytes = opts.maxBytes ?? MAX_PI_TRANSCRIPT_BYTES;
  if (stat.size > maxBytes) throw new Error("Pi transcript exceeds the replay size limit");
  return await fs.readFile(resolved);
}

/** Parse complete JSONL records only; an incomplete final write is ignored for safe live-tail reuse. */
export function parsePiTranscript(text: string): PiTranscriptEntry[] {
  const lines = text.split("\n");
  const entries: PiTranscriptEntry[] = [];
  for (let index = 0; index < lines.length && entries.length < MAX_PI_TRANSCRIPT_LINES; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.type !== "string") continue;
      entries.push(value as unknown as PiTranscriptEntry);
    } catch {
      // Only an incomplete final append is normal. Any malformed earlier record is ignored rather
      // than making an ACP resume disclose arbitrary parser failure details.
      if (index === lines.length - 1) break;
    }
  }
  return entries;
}

/** Select the ancestry path of the newest entry, rather than replaying abandoned Pi branches. */
export function activePiEntries(entries: PiTranscriptEntry[]): PiTranscriptEntry[] {
  const withId = entries.filter((entry): entry is PiTranscriptEntry & { id: string } => typeof entry.id === "string");
  const byId = new Map(withId.map((entry) => [entry.id, entry]));
  const leaf = withId.at(-1);
  if (!leaf) return [];
  const path: PiTranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: (PiTranscriptEntry & { id: string }) | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function textBlocks(content: unknown): Array<{ type: "text"; text: string }> {
  const source = typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content
      : [];
  const result: Array<{ type: "text"; text: string }> = [];
  let used = 0;
  for (const block of source) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const remaining = MAX_PI_CONTENT_CHARS - used;
    if (remaining <= 0) break;
    const text = block.text.slice(0, remaining);
    if (!text) continue;
    result.push({ type: "text", text });
    used += text.length;
  }
  return result;
}

function thinkingBlocks(content: unknown): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(content)) return [];
  const result: Array<{ type: "text"; text: string }> = [];
  let used = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
    const remaining = MAX_PI_CONTENT_CHARS - used;
    if (remaining <= 0) break;
    const text = block.thinking.slice(0, remaining);
    if (!text) continue;
    result.push({ type: "text", text });
    used += text.length;
  }
  return result;
}

/** Convert Pi's durable active branch into complete ACP message updates for `replayFrom:start`. */
export function piUserMessageIdForText(
  entries: PiTranscriptEntry[],
  text: string,
  excludedIds: ReadonlySet<string> = new Set(),
): string | undefined {
  for (const entry of activePiEntries(entries).reverse()) {
    if (entry.message?.role !== "user" || !entry.id || excludedIds.has(entry.id)) continue;
    const candidate = textBlocks(entry.message.content).map((block) => block.text).join("\n");
    if (candidate === text) return entry.id;
  }
  return undefined;
}

export function piEntryUpdates(sessionId: string, entry: PiTranscriptEntry): unknown[] {
  const updates: unknown[] = [];
  {
    const role = entry.message?.role;
    if (!entry.id || !role) return updates;
    if (role === "user") {
      const content = textBlocks(entry.message?.content);
      if (content.length) {
        updates.push({
          sessionId,
          update: { sessionUpdate: "user_message", messageId: `pi:user:${entry.id}`, content },
        });
      }
      return updates;
    }
    if (role === "assistant") {
      const thoughts = thinkingBlocks(entry.message?.content);
      if (thoughts.length) {
        updates.push({
          sessionId,
          update: { sessionUpdate: "agent_thought", messageId: `pi:thought:${entry.id}`, content: thoughts },
        });
      }
      const content = textBlocks(entry.message?.content);
      if (content.length) {
        updates.push({
          sessionId,
          update: { sessionUpdate: "agent_message", messageId: `pi:agent:${entry.id}`, content },
        });
      }
    }
  }
  return updates;
}

export function piHistoryUpdates(sessionId: string, entries: PiTranscriptEntry[]): unknown[] {
  return activePiEntries(entries).flatMap((entry) => piEntryUpdates(sessionId, entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `dirname` keeps TypeScript from erasing the dependency from Node's path type surface on older
// bundled declarations; it also documents that transcript paths are file, not directory, bindings.
void dirname;
