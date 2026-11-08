import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, access, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { LifecycleError, REQUEST_ID } from "./agents/conversations.ts";
import type { Config } from "./config.ts";
import type { SessionRegistry } from "./sessions.ts";

type Root = { name: string; path: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
export function directoryPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.split("/").some((part) => part === "." || part === "..")) {
    throw new LifecycleError(400, "invalid_path", "Expected an absolute directory path without traversal");
  }
  return normalize(value).replace(/\/+$/, "") || "/";
}
function failure(error: unknown): LifecycleError {
  if (error instanceof LifecycleError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new LifecycleError(404, "not_found", "Directory does not exist");
  if (code === "ENOTDIR") return new LifecycleError(409, "not_directory", "Path is not an accessible non-symlink directory");
  return new LifecycleError(403, "not_accessible", "Directory is not accessible");
}
interface Dedupe { signature: string; promise: Promise<unknown>; done?: number }
export class DirectoryService {
  private readonly roots: Root[];
  private readonly creates = new Map<string, Dedupe>();
  constructor(private readonly sessions: SessionRegistry, roots: NonNullable<Config["browseRoots"]>, private readonly now = Date.now) {
    this.roots = roots.map((root) => ({ name: root.name, path: directoryPath(root.path) }));
  }
  private runtime(session?: string): string {
    const runtime = this.sessions.get(session);
    if (!runtime) throw new LifecycleError(404, "runtime_unknown", "Unknown Herdr runtime");
    if (runtime.engine.current().bridge !== "connected") throw new LifecycleError(503, "runtime_unavailable", "Herdr runtime is unavailable");
    return runtime.name;
  }
  private root(path: string): Root {
    const root = this.roots.filter((r) => path === r.path || (r.path === "/" ? path.startsWith("/") : path.startsWith(r.path + "/"))).sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) throw new LifecycleError(403, "outside_allowed_roots", "Path is outside configured roots");
    return root;
  }
  private supported(): void {
    if (process.platform !== "linux") throw new LifecycleError(503, "filesystem_unsupported", "Safe directory operations are currently supported only on Linux");
  }
  /** Open every component beneath a held descriptor; never follow a path-component symlink. */
  private async openAbsolute(path: string): Promise<FileHandle> {
    this.supported();
    let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      try { await access(`/proc/self/fd/${handle.fd}`, constants.X_OK); }
      catch { throw new LifecycleError(503, "filesystem_unsupported", "Descriptor-relative filesystem access is unavailable"); }
      for (const component of path.split("/").filter(Boolean)) {
        const next = await open(`/proc/self/fd/${handle.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close(); handle = next;
      }
      return handle;
    } catch (error) { await handle.close(); throw failure(error); }
  }
  private async held(path: string): Promise<{ handle: FileHandle; root: Root }> {
    const root = this.root(path);
    // Root errors are operational errors, not evidence a client-provided child does not exist.
    let rootHandle;
    try { rootHandle = await this.openAbsolute(root.path); }
    catch (error) { if (error instanceof LifecycleError && error.code === "filesystem_unsupported") throw error; throw new LifecycleError(503, "root_unavailable", "Configured root is unavailable or symlinked"); }
    let handle = rootHandle;
    try {
      for (const component of relative(root.path, path).split("/").filter(Boolean)) {
        const next = await open(`/proc/self/fd/${handle.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close(); handle = next;
      }
      await access(`/proc/self/fd/${handle.fd}`, constants.X_OK);
      return { handle, root };
    } catch (error) { await handle.close(); throw failure(error); }
  }
  async list(session?: string, input?: { path: string; limit?: number; cursor?: string }) {
    const runtime = this.runtime(session);
    if (!input) {
      for (const root of this.roots) { const held = await this.held(root.path); await held.handle.close(); }
      return { roots: structuredClone(this.roots) };
    }
    const path = directoryPath(input.path); const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new LifecycleError(400, "invalid_request", "limit must be between 1 and 200");
    const { handle, root } = await this.held(path);
    try {
      const directories: Array<{ name: string; path: string }> = [];
      let count = 0;
      const dir = await opendir(`/proc/self/fd/${handle.fd}`);
      let entryBytes = 0;
      for await (const entry of dir) {
        if (++count > 10_000) throw new LifecycleError(413, "directory_too_large", "Directory exceeds the enumeration limit");
        if (entry.isDirectory() && !entry.isSymbolicLink() && !/[\x00-\x1f\x7f]/.test(entry.name)) {
          const candidate = { name: entry.name, path: join(path, entry.name) };
          entryBytes += Buffer.byteLength(JSON.stringify(candidate));
          if (entryBytes > 8 * 1024 * 1024) throw new LifecycleError(413, "directory_too_large", "Directory entries exceed the supported size");
          directories.push(candidate);
        }
      }
      directories.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const fingerprint = digest([runtime, root.path, path, directories]);
      let position = 0;
      if (input.cursor !== undefined) {
        let cursor;
        try { if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.cursor)) throw new Error(); cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); }
        catch { throw new LifecycleError(400, "invalid_cursor", "Invalid directory cursor"); }
        if (!cursor || cursor.v !== 1 || !Number.isSafeInteger(cursor.n) || cursor.n < 0 || typeof cursor.h !== "string") throw new LifecycleError(400, "invalid_cursor", "Invalid directory cursor");
        if (cursor.h !== fingerprint || cursor.n > directories.length) throw new LifecycleError(409, "directory_changed", "Directory listing changed; restart pagination");
        position = cursor.n;
      }
      const page = directories.slice(position, position + limit); const end = position + page.length;
      return { path, parentPath: path === root.path ? null : dirname(path), directories: page,
        nextCursor: end < directories.length ? Buffer.from(JSON.stringify({ v: 1, n: end, h: fingerprint })).toString("base64url") : null };
    } catch (error) { throw failure(error); } finally { await handle.close(); }
  }
  async validate(session: string | undefined, value: unknown) {
    this.runtime(session); const path = directoryPath(value);
    try {
      const { handle } = await this.held(path); await handle.close(); return { path, valid: true, reason: null };
    } catch (error) {
      const f = failure(error);
      if (["outside_allowed_roots", "not_found", "not_directory", "not_accessible"].includes(f.code)) return { path, valid: false, reason: f.code };
      throw f;
    }
  }
  async create(session: string | undefined, input: unknown): Promise<{ ok: true; path: string; created: boolean }> {
    const runtime = this.runtime(session);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new LifecycleError(400, "invalid_request", "Expected directory creation parameters");
    const body = input as { parentPath?: unknown; name?: unknown; requestId?: unknown };
    if (Object.keys(body).some((key) => !["parentPath", "name", "requestId"].includes(key)) || typeof body.name !== "string" || !body.name || body.name === "." || body.name === ".." || /[\/\\\x00-\x1f\x7f]/.test(body.name) || Buffer.byteLength(body.name) > 255 || typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) throw new LifecycleError(400, "invalid_request", "Invalid child name or requestId");
    const parentPath = directoryPath(body.parentPath); const name = body.name;
    const key = JSON.stringify([runtime, body.requestId]); const signature = JSON.stringify([parentPath, name]);
    for (const [id, entry] of this.creates) if (entry.done !== undefined && entry.done + 600_000 <= this.now()) this.creates.delete(id);
    const existing = this.creates.get(key);
    if (existing) {
      if (existing.signature !== signature) throw new LifecycleError(409, "request_id_conflict", "requestId was used with different directory parameters");
      return await existing.promise as { ok: true; path: string; created: boolean };
    }
    if (this.creates.size >= 512) {
      const completed = [...this.creates].find(([, value]) => value.done !== undefined);
      if (!completed) throw new LifecycleError(429, "request_capacity", "Directory request cache is full");
      this.creates.delete(completed[0]);
    }
    const entry: Dedupe = { signature, promise: Promise.resolve(undefined) };
    entry.promise = Promise.resolve().then(async () => {
      const { handle } = await this.held(parentPath);
      try {
        const target = `/proc/self/fd/${handle.fd}/${name}`;
        let created = true;
        try { await mkdir(target, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failure(error);
          created = false;
        }
        try { const child = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await child.close(); }
        catch { throw new LifecycleError(409, "existing_non_directory", "Child exists but is not a safe directory"); }
        return { ok: true as const, path: join(parentPath, name), created };
      } finally { await handle.close(); }
    }).finally(() => { entry.done = this.now(); });
    this.creates.set(key, entry);
    return await entry.promise as { ok: true; path: string; created: boolean };
  }
}
