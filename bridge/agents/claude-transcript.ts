import { lstat, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

export const MAX_CLAUDE_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_CLAUDE_TRANSCRIPT_LINES = 20_000;

export interface ClaudeTranscriptEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

export interface ClaudeTranscriptFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
  readFile(path: string): Promise<string>;
  readdir?(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>>;
}

const nodeFs: ClaudeTranscriptFs = {
  realpath,
  lstat,
  readFile: async (path) => await Bun.file(path).text(),
  readdir,
};

export function claudeProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export async function readSafeClaudeTranscript(
  path: string,
  opts: { home?: string; fs?: ClaudeTranscriptFs; maxBytes?: number } = {},
): Promise<string> {
  const fs = opts.fs ?? nodeFs;
  const root = await fs.realpath(claudeProjectsRoot(opts.home));
  const requested = resolve(path);
  const resolved = await fs.realpath(requested);
  if (!inside(root, resolved)) throw new Error("Claude transcript is outside the permitted projects directory");
  const stat = await fs.lstat(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Claude transcript must be a regular non-symlink file");
  if (stat.size > (opts.maxBytes ?? MAX_CLAUDE_TRANSCRIPT_BYTES)) throw new Error("Claude transcript exceeds the replay size limit");
  return await fs.readFile(resolved);
}

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Derive a private Claude transcript path from Herdr's native UUID without trusting client input.
 * Search only the known Claude projects root, reject symlink directories/files, and require exactly
 * one regular `<uuid>.jsonl` result. The discovered result must still pass readSafeClaudeTranscript.
 */
export async function findClaudeTranscriptBySessionId(
  sessionId: string,
  opts: { home?: string; fs?: ClaudeTranscriptFs } = {},
): Promise<string> {
  if (!CLAUDE_SESSION_ID.test(sessionId)) throw new Error("invalid Claude session id");
  const fs = opts.fs ?? nodeFs;
  if (!fs.readdir) throw new Error("Claude transcript discovery is unavailable");
  const root = await fs.realpath(claudeProjectsRoot(opts.home));
  const matches: string[] = [];
  for (const project of await fs.readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const dir = join(root, project.name);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== `${sessionId}.jsonl`) continue;
      const candidate = join(dir, entry.name);
      try {
        await readSafeClaudeTranscript(candidate, opts);
        matches.push(candidate);
      } catch {
        // A malformed, symlinked, or out-of-root candidate is never usable.
      }
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous Claude transcript" : "Claude transcript not found");
  return matches[0]!;
}

export function parseClaudeTranscript(text: string): ClaudeTranscriptEntry[] {
  const result: ClaudeTranscriptEntry[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (result.length >= MAX_CLAUDE_TRANSCRIPT_LINES || !line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) result.push(value as unknown as ClaudeTranscriptEntry);
    } catch {
      if (index === text.split("\n").length - 1) break;
    }
  }
  return result;
}

function textContent(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => ({ type: "text" as const, text: block.text as string }));
}

/** Claude records a mostly linear parent UUID chain; only user/assistant non-sidechain messages are chat history. */
export function claudeUserMessageIdForText(
  entries: ClaudeTranscriptEntry[],
  text: string,
  excluded: ReadonlySet<string> = new Set(),
): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.isSidechain || entry.message?.role !== "user" || !entry.uuid || excluded.has(entry.uuid)) continue;
    const candidate = textContent(entry.message.content).map((block) => block.text).join("\n");
    if (candidate === text) return entry.uuid;
  }
  return undefined;
}

/** Remove server-private relay upload paths before any Claude transcript content is exposed externally. */
export function redactRelayUploadPaths(text: string): string {
  return text.replace(/(?:^|\s)\/[^\s]*\/uploads\/[A-Za-z0-9_.-]+/g, (match) => `${match.startsWith(" ") ? " " : ""}[private relay image]`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
