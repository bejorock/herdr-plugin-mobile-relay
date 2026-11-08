import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
const keys = ["HERDR_PLUGIN_STATE_DIR", "HERDR_RELAY_STATE_DIR", "HERDR_RELAY_SOCKET", "HERDR_SOCKET_PATH", "HERDR_RELAY_ALLOWED_ORIGINS", "HERDR_RELAY_POLL_MS", "HERDR_RELAY_POLL_IDLE_MS", "HERDR_RELAY_READ_LINES", "HERDR_RELAY_SUBMIT_KEYS", "HERDR_RELAY_MULTI_SESSION"];
let saved: Array<string | undefined>;
beforeEach(() => { saved = keys.map((key) => process.env[key]); keys.forEach((key) => delete process.env[key]); });
afterEach(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
describe("socket-only configuration", () => {
  test("has no TCP/proxy/device/root policy settings", () => {
    const cfg = loadConfig(); expect(cfg.relaySocketPath).toEndWith("/relay.sock");
    for (const key of ["port", "host", "trustedUser", "deviceHeader", "browseRoots", "publicHosts"]) expect(cfg).not.toHaveProperty(key);
    expect(cfg.allowedOrigins).toEqual([]); expect(cfg.multiSession).toBe(true);
  });
  test("keeps Herdr and public relay sockets distinct", () => {
    process.env.HERDR_PLUGIN_STATE_DIR = "/tmp/relay-state"; process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    expect(loadConfig()).toMatchObject({ socketPath: "/tmp/herdr.sock", relaySocketPath: "/tmp/relay-state/relay.sock" });
    process.env.HERDR_RELAY_SOCKET = "/tmp/private/relay.sock"; expect(loadConfig().relaySocketPath).toBe("/tmp/private/relay.sock");
  });
  test("rejects relative/overlong socket paths and non-exact browser origins", () => {
    for (const value of ["relative", "/" + "x".repeat(101), "/tmp/a\n"]) { process.env.HERDR_RELAY_SOCKET = value; expect(() => loadConfig()).toThrow(); }
    process.env.HERDR_RELAY_SOCKET = "/tmp/relay.sock";
    for (const origin of ["*", "null", "https://example.test/path", "https://example.test/"]) { process.env.HERDR_RELAY_ALLOWED_ORIGINS = origin; expect(() => loadConfig()).toThrow(); }
    process.env.HERDR_RELAY_ALLOWED_ORIGINS = "https://ade.example.test"; expect(loadConfig().allowedOrigins).toEqual(["https://ade.example.test"]);
  });
  test("preserves bounded polling/read limits and multi-runtime switch", () => {
    process.env.HERDR_RELAY_POLL_MS = "10junk"; process.env.HERDR_RELAY_READ_LINES = "10001";
    expect(loadConfig().pollMs).toBe(1500); expect(loadConfig().readLines).toBe(200);
    process.env.HERDR_RELAY_POLL_MS = "500"; process.env.HERDR_RELAY_MULTI_SESSION = "off";
    expect(loadConfig().pollMs).toBe(500); expect(loadConfig().multiSession).toBe(false);
  });
});
