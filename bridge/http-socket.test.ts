import { afterEach, expect, test } from "bun:test";
import { createServer, connect } from "node:net";
import { mkdtemp, rm, stat, writeFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHttpSocket } from "./http-socket.ts";
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";
import { LiveUpdateHub } from "./live-updates.ts";
import { HerdrEventHub } from "./http-events.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "relay-sock-")); dirs.push(dir); return dir; }

test("private socket serves HTTP, SSE, and WebSocket with no TCP listener", async () => {
  const dir = await directory(); const hub = new HerdrEventHub();
  const relaySocketPath = join(dir, "relay.sock");
  const server = await startServer({ cfg: { ...loadConfig(), stateDir: dir, relaySocketPath }, registry: { get: () => ({ name: "default" }) } as never,
    conversations: { runtime: () => ({ name: "default" }) } as never, audit: {} as never, liveUpdates: new LiveUpdateHub(), herdrEvents: hub, version: "socket-test" });
  try {
    expect(server.port).toBeUndefined(); expect(server.hostname).toBeUndefined();
    expect((await stat(dir)).mode & 0o777).toBe(0o700); expect((await stat(relaySocketPath)).mode & 0o777).toBe(0o600);
    const cfg = await fetch("http://localhost/api/config", { unix: relaySocketPath }); expect(await cfg.json()).toEqual({ build: "socket-test" });
    expect((await fetch("http://localhost/api/conversations", { unix: relaySocketPath, method: "POST", body: "{}" })).status).toBe(403);
    for (const path of ["/api/directories", "/api/directories/validate"]) expect((await fetch("http://localhost" + path, { unix: relaySocketPath })).status).toBe(404);
    const abort = new AbortController(); const response = await fetch("http://localhost/api/events", { unix: relaySocketPath, signal: abort.signal });
    const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain("resync.required");
    hub.event("default", "pane_created", { pane_id: "test" }); expect(new TextDecoder().decode((await reader.read()).value)).toContain("test");
    abort.abort(); await reader.cancel().catch(() => {});
    // Native Unix upgrade and a masked client close frame prove the WebSocket endpoint without
    // adding a TCP bridge or depending on browser APIs that cannot address Unix sockets.
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(relaySocketPath); let data = Buffer.alloc(0);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("WebSocket timeout")); }, 3000);
      socket.on("error", reject);
      socket.on("connect", () => socket.write("GET /api/live HTTP/1.1\r\nHost: localhost\r\nX-Herdr-Client: herdr-mobile-v1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"));
      socket.on("data", (chunk) => { data = Buffer.concat([data, Buffer.from(chunk)]); if (data.toString().includes("connected")) { clearTimeout(timer); socket.destroy(); resolve(data.toString()); } });
    });
    expect(received).toContain("101 Switching Protocols"); expect(received).toContain("connected");
    await expect(startServer({ cfg: { ...loadConfig(), stateDir: dir, relaySocketPath }, registry: {} as never, audit: {} as never, liveUpdates: {} as never })).rejects.toThrow("active listener");
    expect((await fetch("http://localhost/api/config", { unix: relaySocketPath })).status).toBe(200);
  } finally { await server.stop(true); }
  await expect(stat(relaySocketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses regular files/symlinks and cleanup does not remove a replaced path", async () => {
  const dir = await directory(); const path = join(dir, "relay.sock"); await writeFile(path, "keep");
  await expect(prepareHttpSocket(path)).rejects.toThrow("non-owned/non-socket"); await rm(path);
  const target = join(dir, "target"); await writeFile(target, "keep"); await symlink(target, path);
  await expect(prepareHttpSocket(path)).rejects.toThrow("non-owned/non-socket"); await rm(path);
  const lease = await prepareHttpSocket(path); const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(path, resolve)); lease.bound();
  await rename(path, path + ".moved"); await writeFile(path, "replacement");
  lease.release(); expect(await Bun.file(path).text()).toBe("replacement");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

test("concurrent startup leases cannot both pass probe before bind", async () => {
  const dir = await directory(); const path = join(dir, "relay.sock");
  const first = await prepareHttpSocket(path);
  try { await expect(prepareHttpSocket(path)).rejects.toThrow("active listener/startup"); }
  finally { first.release(); }
  const second = await prepareHttpSocket(path); second.release();
});

test("reclaims an abandoned socket only after checking no active listener", async () => {
  const dir = await directory(); const path = join(dir, "relay.sock");
  // SIGKILL leaves the Unix socket entry behind (normal close unlinks it).
  const child = Bun.spawn([process.execPath, "-e", 'Bun.serve({unix:process.argv[1],fetch(){return new Response("ok")}});', path], { stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 50; i++) { try { if ((await stat(path)).isSocket()) break; } catch {} await Bun.sleep(20); }
  child.kill(9); await child.exited;
  const lease = await prepareHttpSocket(path); await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" }); lease.release();
});
