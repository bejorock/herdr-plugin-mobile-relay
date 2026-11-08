import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

export interface SocketLease { path: string; bound(): void; release(): void }
/** Acquire an owner-private socket location without stealing an active listener or ordinary file. */
export async function prepareHttpSocket(path: string): Promise<SocketLease> {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100 || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid/overlong relay socket path");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Relay socket directory must belong to the current user and not be a symlink");
  // Resolve existing ancestor links (e.g. macOS /var -> /private/var), but never accept a symlink leaf.
  const canonicalParent = realpathSync(parent);
  if (resolve(canonicalParent) === "/") throw new Error("Relay socket requires a dedicated private directory");
  chmodSync(parent, 0o700);
  // Serialize probe/bind across daemon processes. Bun's bind must not race another startup
  // between the stale-socket check and listen. Crash-before-PID write fails closed for inspection.
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Unsafe relay socket lock");
    let pid: number;
    try { const value = readFileSync(`${lock}/pid`, "utf8").trim(); if (!/^\d+$/.test(value)) throw new Error(); pid = Number(value); if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(); }
    catch { throw new Error("Incomplete relay socket lock requires operator inspection"); }
    try { process.kill(pid, 0); throw new Error("Relay socket already has an active listener/startup"); }
    catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
    }
    const current = lstatSync(lock);
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("Relay lock changed during startup");
    unlinkSync(`${lock}/pid`); rmdirSync(lock); mkdirSync(lock, { mode: 0o700 });
  }
  const lockStat = lstatSync(lock);
  writeFileSync(`${lock}/pid`, String(process.pid), { mode: 0o600, flag: "wx" });
  const unlock = () => {
    try {
      const stat = lstatSync(lock);
      if (stat.ino === lockStat.ino && stat.dev === lockStat.dev) { unlinkSync(`${lock}/pid`); rmdirSync(lock); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  try {
  let existing;
  try { existing = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error("Refusing to replace non-owned/non-socket relay path");
    const active = await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(path);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Relay socket probe timed out")); }, 1000);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer); socket.destroy();
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false); else reject(error);
      });
    });
    if (active) throw new Error("Relay socket already has an active listener");
    // Recheck identity before unlinking the stale socket.
    try { const current = lstatSync(path); if (current.ino !== existing.ino || current.dev !== existing.dev) throw new Error("Relay socket changed during startup"); unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let owned: { ino: number; dev: number } | undefined;
  return {
    path,
    bound() { const stat = lstatSync(path); if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unexpected relay socket ownership"); chmodSync(path, 0o600); owned = { ino: stat.ino, dev: stat.dev }; },
    release() {
      try {
        if (owned) {
          try { const stat = lstatSync(path); if (stat.isSocket() && stat.ino === owned.ino && stat.dev === owned.dev) unlinkSync(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          owned = undefined;
        }
      } finally { unlock(); }
    },
  };
  } catch (error) { unlock(); throw error; }
}
