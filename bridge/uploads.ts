import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { ensurePrivateDirectory, writePrivateFile } from "./private-fs.ts";

// Uploaded images (server.ts uploadPane → `<stateDir>/uploads/`) are referenced by path in a
// message and then never needed again, so nothing deletes them. This sweep prunes anything older
// than the TTL. The decision — which names are stale — is a pure, tested function; the runner that
// stats the dir and unlinks takes an injectable fs surface so it too can be exercised without disk.

/** Uploads older than this are swept (Herdr already read them by path; they're single-use). */
export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000; // 48 h
/** How often the runner re-sweeps after the startup pass. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Save an already validated image payload as an owner-only, server-named host file. */
export async function savePrivateImageUpload(input: {
  stateDir: string;
  paneId: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<string> {
  const ext = IMAGE_EXT[input.mimeType];
  if (!ext) throw new Error(`unsupported image type: ${input.mimeType || "unknown"}`);
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("image too large (max 10 MB)");
  }
  const dir = join(input.stateDir, "uploads");
  await ensurePrivateDirectory(dir);
  const safePane = input.paneId.replace(/[^A-Za-z0-9_-]/g, "_");
  const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const path = join(dir, filename);
  await writePrivateFile(path, input.bytes);
  return path;
}

/** Names whose mtime is older than `ttlMs` before `now`. Pure — the whole decision, unit-tested. */
export function filesToPrune(
  entries: { name: string; mtimeMs: number }[],
  now: number,
  ttlMs: number,
): string[] {
  return entries.filter((e) => now - e.mtimeMs > ttlMs).map((e) => e.name);
}

/** The slice of node:fs the sweep needs — injectable so the runner is testable with a fake. */
export interface UploadFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  unlink(path: string): Promise<void>;
}

const realFs: UploadFs = { readdir, stat: (p) => stat(p), unlink };

/**
 * Stat `dir`, prune every file past the TTL, and return the names actually removed. Best-effort
 * throughout: a missing uploads dir (nothing uploaded yet) is not an error, and a file that vanishes
 * between readdir and stat/unlink (or a stat/unlink that fails) is skipped rather than aborting the
 * sweep. `now` and `fs` are injected for tests; the bridge calls it with the defaults.
 */
export async function sweepUploads(
  dir: string,
  ttlMs: number = UPLOAD_TTL_MS,
  now: number = Date.now(),
  fs: UploadFs = realFs,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // uploads dir doesn't exist yet — nothing to sweep
  }
  const entries: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const s = await fs.stat(join(dir, name));
      entries.push({ name, mtimeMs: s.mtimeMs });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  const removed: string[] = [];
  for (const name of filesToPrune(entries, now, ttlMs)) {
    try {
      await fs.unlink(join(dir, name));
      removed.push(name);
    } catch {
      /* already gone / unlink failed — skip */
    }
  }
  return removed;
}
