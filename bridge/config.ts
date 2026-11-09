import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const MAX_READ_LINES = 10_000;
export const NATIVE_CLIENT_HEADER = "x-herdr-client";
export const NATIVE_CLIENT_VALUE = "herdr-mobile-v1";

function envInt(name: string, fallback: number, min: number, max = 2_147_483_647): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  console.warn(`[config] Invalid ${name}; using ${fallback}`);
  return fallback;
}
function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  console.warn(`[config] Invalid ${name}; using ${fallback}`);
  return fallback;
}
function list(name: string): string[] { return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean); }
export interface Config {
  /** Herdr's existing control socket, not this daemon's HTTP socket. */
  socketPath: string;
  /** Owner-private HTTP/SSE/WebSocket socket. No TCP listener is opened. */
  relaySocketPath: string;
  stateDir: string;
  pollMs: number;
  pollIdleMs: number;
  readLines: number;
  submitKeys: string[];
  multiSession: boolean;
  /** Optional exact browser origins; default none. SSH itself is managed by the owner/client. */
  allowedOrigins: string[];
  /** Explicit owner-attested Herdr launcher PATH; never inferred from Bun's service PATH. */
  agentPath?: string[];
}
export function loadConfig(): Config {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? process.env.HERDR_RELAY_STATE_DIR ?? join(homedir(), ".local", "state", "rad-herdr-mobile-relay");
  const relaySocketPath = process.env.HERDR_RELAY_SOCKET ?? join(stateDir, "relay.sock");
  if (!isAbsolute(stateDir) || !isAbsolute(relaySocketPath) || /[\x00-\x1f\x7f]/.test(stateDir + relaySocketPath)) throw new Error("Relay state/socket paths must be absolute without control characters");
  // Conservative cross-platform sockaddr_un limit, leaving room for the terminating NUL.
  if (Buffer.byteLength(relaySocketPath) > 100) throw new Error("HERDR_RELAY_SOCKET exceeds 100 UTF-8 bytes; choose a shorter private directory");
  const allowedOrigins = list("HERDR_RELAY_ALLOWED_ORIGINS");
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error("HERDR_RELAY_ALLOWED_ORIGINS requires exact HTTP(S) origins");
  }
  const rawAgentPath = process.env.HERDR_RELAY_AGENT_PATH;
  const agentPath = rawAgentPath === undefined ? undefined : rawAgentPath.split(":");
  if (agentPath && (!agentPath.length || agentPath.length > 64 || agentPath.some((path) => !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)))) throw new Error("HERDR_RELAY_AGENT_PATH requires nonempty absolute PATH entries");
  const submitKeys = list("HERDR_RELAY_SUBMIT_KEYS");
  return {
    socketPath: process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock"),
    relaySocketPath, stateDir, allowedOrigins, agentPath,
    pollMs: envInt("HERDR_RELAY_POLL_MS", 1500, 250),
    pollIdleMs: envInt("HERDR_RELAY_POLL_IDLE_MS", 12_000, 1000),
    readLines: envInt("HERDR_RELAY_READ_LINES", 200, 1, MAX_READ_LINES),
    submitKeys: submitKeys.length ? submitKeys : ["Enter"],
    multiSession: boolean("HERDR_RELAY_MULTI_SESSION", true),
  };
}
