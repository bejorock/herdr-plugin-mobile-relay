import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, fileAuditAppender } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { EventPoker } from "./event-poker.ts";
import { HerdrClient } from "./herdr-client.ts";
import { LiveUpdateHub } from "./live-updates.ts";
import { ensurePrivateDirectory } from "./private-fs.ts";
import { startServer } from "./server.ts";
import { deriveConfigRoot, SessionRegistry, type SessionFactory } from "./sessions.ts";
import { StateEngine } from "./state-engine.ts";
import { SWEEP_INTERVAL_MS, sweepUploads } from "./uploads.ts";

const cfg = loadConfig();
await ensurePrivateDirectory(cfg.stateDir);
const audit = new AuditLog(fileAuditAppender(join(cfg.stateDir, "audit.log")));
const liveUpdates = new LiveUpdateHub();
const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;

const makeSession: SessionFactory = (name, socketPath) => {
  const herdr = new HerdrClient(socketPath);
  const engine = new StateEngine(herdr, cfg.pollMs);
  // Herdr events invalidate the cache; authoritative snapshots remain the source of truth.
  const poker = new EventPoker(herdr);
  poker.onPoke(() => engine.pokeNow());
  poker.onHealth((healthy) => {
    engine.setCadence(healthy ? cfg.pollIdleMs : cfg.pollMs);
    liveUpdates.setSourceHealthy(name, healthy);
  });
  engine.onUpdate((snapshot) => poker.setAgentPanes(snapshot.agents.map((agent) => agent.paneId)));
  engine.onUpdate(() => liveUpdates.snapshotChanged(name));
  engine.start();
  poker.start();
  return { herdr, engine, poker };
};
const registry = new SessionRegistry({
  configRoot: deriveConfigRoot(cfg.socketPath), primarySocketPath: cfg.socketPath,
  factory: makeSession, multiSession: cfg.multiSession,
  listSessionDirs(dir) {
    try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
    catch { return []; }
  },
  exists: existsSync,
});
await registry.refresh();
const refreshTimer = setInterval(() => void registry.refresh(), 15_000);
refreshTimer.unref();
const uploadsDir = join(cfg.stateDir, "uploads");
void sweepUploads(uploadsDir);
const sweepTimer = setInterval(() => void sweepUploads(uploadsDir), SWEEP_INTERVAL_MS);
sweepTimer.unref();
const server = startServer({ cfg, registry, audit, liveUpdates, version });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(refreshTimer);
  clearInterval(sweepTimer);
  liveUpdates.closeAll();
  // Terminal observers belong to sockets and are closed by websocket.close.
  await server.stop(true);
  await registry.disposeAll();
  await audit.flush();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
