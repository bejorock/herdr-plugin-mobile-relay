import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

// loadConfig is the deployment contract — env vars in, a resolved Config out. Pure (just reads
// process.env + homedir), so we drive it by mutating the environment and restoring it after.

const KEYS = [
  "HERDR_RELAY_BROWSE_ROOTS",
  "HERDR_RELAY_PORT",
  "HERDR_RELAY_EFFECTIVE_PORT",
  "HERDR_RELAY_HOST",
  "HERDR_RELAY_POLL_MS",
  "HERDR_RELAY_POLL_IDLE_MS",
  "HERDR_RELAY_READ_LINES",
  "HERDR_RELAY_SUBMIT_KEYS",
  "HERDR_RELAY_TRUSTED_USER",
  "HERDR_RELAY_TRUSTED_USERS",
  "HERDR_RELAY_ALLOW_ANY_TAILNET_USER",
  "HERDR_RELAY_TRUSTED_USER_HEADER",
  "HERDR_RELAY_DEVICE_HEADER",
  "HERDR_RELAY_DEVICE_ALLOWLIST",
  "HERDR_RELAY_ALLOWED_ORIGINS",
  "HERDR_RELAY_PUBLIC_HOSTS",
  "HERDR_RELAY_EFFECTIVE_PUBLIC_HOSTS",
  "HERDR_RELAY_SERVE_MODE",
  "HERDR_RELAY_STATE_DIR",
  "HERDR_RELAY_MULTI_SESSION",
  "HERDR_SOCKET_PATH",
  "HERDR_PLUGIN_STATE_DIR",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadConfig", () => {
  test("directory roots are explicit JSON configuration and invalid policies fail closed", () => {
    expect(loadConfig().browseRoots).toEqual([]);
    process.env.HERDR_RELAY_BROWSE_ROOTS = JSON.stringify([{ name: " Workspaces ", path: "/home/u/workspaces/" }]);
    expect(loadConfig().browseRoots).toEqual([{ name: "Workspaces", path: "/home/u/workspaces" }]);
    for (const value of ["not-json", "{}", '[{"name":"x","path":"relative"}]', '[{"name":"x","path":"/tmp/../etc"}]', '[{"name":"x","path":"/tmp"},{"name":"y","path":"/tmp/"}]']) {
      process.env.HERDR_RELAY_BROWSE_ROOTS = value; expect(() => loadConfig()).toThrow();
    }
  });
  test("uses safe single-user defaults", () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.pollMs).toBe(1500);
    expect(cfg.pollIdleMs).toBe(12_000);
    expect(cfg.readLines).toBe(200);
    expect(cfg.submitKeys).toEqual(["Enter"]);
    expect(cfg.trustedUser).toBe("");
    expect(cfg.trustedUsers).toEqual([]);
    expect(cfg.allowAnyTrustedUser).toBe(false);
    expect(cfg.trustedUserHeader).toBe("tailscale-user-login");
    expect(cfg.allowedOrigins).toEqual([]);
    // Host-header validation is opt-in (empty = off, legacy behaviour).
    expect(cfg.publicHosts).toEqual([]);
    expect(cfg.publicScheme).toBe("https");
    // Per-device auth is off by default (empty header = feature disabled).
    expect(cfg.deviceHeader).toBe("");
    expect(cfg.deviceAllowlist).toEqual([]);
    // Multi-session support is on by default.
    expect(cfg.multiSession).toBe(true);
  });

  test("parses HERDR_RELAY_MULTI_SESSION as a boolean toggle (default on)", () => {
    // Falsey spellings turn it off (pin to the primary session only).
    for (const off of ["off", "0", "false", "no", "OFF", " False "]) {
      process.env.HERDR_RELAY_MULTI_SESSION = off;
      expect(loadConfig().multiSession).toBe(false);
    }
    // Truthy spellings keep it on.
    for (const on of ["on", "1", "true", "yes", "ON", " True "]) {
      process.env.HERDR_RELAY_MULTI_SESSION = on;
      expect(loadConfig().multiSession).toBe(true);
    }
    // Garbage and empty fall back to the default (on).
    process.env.HERDR_RELAY_MULTI_SESSION = "banana";
    expect(loadConfig().multiSession).toBe(true);
    process.env.HERDR_RELAY_MULTI_SESSION = "";
    expect(loadConfig().multiSession).toBe(true);
  });

  test("reads the per-device auth header and allowlist", () => {
    process.env.HERDR_RELAY_DEVICE_HEADER = "  X-Device-Id  ";
    process.env.HERDR_RELAY_DEVICE_ALLOWLIST = " phone , laptop ,";
    const cfg = loadConfig();
    expect(cfg.deviceHeader).toBe("X-Device-Id");
    expect(cfg.deviceAllowlist).toEqual(["phone", "laptop"]);
  });

  test("keeps device auth fail-closed when its configured header name is invalid", () => {
    process.env.HERDR_RELAY_DEVICE_HEADER = "bad header";
    expect(loadConfig().deviceHeader).toBe("x-herdr-invalid-device-header");
    process.env.HERDR_RELAY_DEVICE_HEADER = "   ";
    expect(loadConfig().deviceHeader).toBe("");
  });

  test("reads a deduplicated trusted-user allowlist and explicit allow-any mode", () => {
    process.env.HERDR_RELAY_TRUSTED_USER = " owner@example.com ";
    process.env.HERDR_RELAY_TRUSTED_USERS = " teammate@example.com, owner@example.com, teammate@example.com, ";
    process.env.HERDR_RELAY_ALLOW_ANY_TAILNET_USER = "yes";
    const cfg = loadConfig();
    expect(cfg.trustedUser).toBe("owner@example.com");
    expect(cfg.trustedUsers).toEqual(["teammate@example.com", "owner@example.com"]);
    expect(cfg.allowAnyTrustedUser).toBe(true);
    process.env.HERDR_RELAY_ALLOW_ANY_TAILNET_USER = "garbage";
    expect(loadConfig().allowAnyTrustedUser).toBe(false);
  });

  test("defaults blank or invalid trusted-user header names", () => {
    process.env.HERDR_RELAY_TRUSTED_USER_HEADER = "   ";
    expect(loadConfig().trustedUserHeader).toBe("tailscale-user-login");
    process.env.HERDR_RELAY_TRUSTED_USER_HEADER = "bad header";
    expect(loadConfig().trustedUserHeader).toBe("tailscale-user-login");
    process.env.HERDR_RELAY_TRUSTED_USER_HEADER = " X-Verified-User ";
    expect(loadConfig().trustedUserHeader).toBe("x-verified-user");
  });

  test("parses integer env vars and falls back to the default on garbage", () => {
    process.env.HERDR_RELAY_PORT = "9999";
    expect(loadConfig().port).toBe(9999);
    process.env.HERDR_RELAY_PORT = "not-a-number";
    expect(loadConfig().port).toBe(8787);
  });

  test("uses the launcher's normalized effective port over a raw EnvironmentFile value", () => {
    process.env.HERDR_RELAY_PORT = " 9999 ";
    process.env.HERDR_RELAY_EFFECTIVE_PORT = "9999";
    expect(loadConfig().port).toBe(9999);
  });

  test("rejects trailing-garbage integers (parseInt would have accepted '8080abc')", () => {
    process.env.HERDR_RELAY_PORT = "8080abc";
    expect(loadConfig().port).toBe(8787);
    // Surrounding whitespace is still fine.
    process.env.HERDR_RELAY_READ_LINES = "  120  ";
    expect(loadConfig().readLines).toBe(120);
  });

  test("clamps out-of-range integers back to the default", () => {
    process.env.HERDR_RELAY_PORT = "0";
    expect(loadConfig().port).toBe(8787);
    process.env.HERDR_RELAY_PORT = "70000";
    expect(loadConfig().port).toBe(8787);
    process.env.HERDR_RELAY_POLL_MS = "100"; // below the 250 floor
    expect(loadConfig().pollMs).toBe(1500);
    process.env.HERDR_RELAY_POLL_IDLE_MS = "500"; // below the 1000 floor
    expect(loadConfig().pollIdleMs).toBe(12_000);
    process.env.HERDR_RELAY_READ_LINES = "10001";
    expect(loadConfig().readLines).toBe(200);
    process.env.HERDR_RELAY_POLL_MS = "999999999999999999999999999999999999";
    expect(loadConfig().pollMs).toBe(1500);
    process.env.HERDR_RELAY_POLL_MS = "2147483648";
    expect(loadConfig().pollMs).toBe(1500);
  });

  test("accepts an in-range integer", () => {
    process.env.HERDR_RELAY_POLL_MS = "250";
    expect(loadConfig().pollMs).toBe(250);
    process.env.HERDR_RELAY_POLL_IDLE_MS = "30000";
    expect(loadConfig().pollIdleMs).toBe(30_000);
  });

  test("reads the public-hosts allowlist, trimming and dropping blanks", () => {
    process.env.HERDR_RELAY_PUBLIC_HOSTS = " relay.example.ts.net , relay.example.com:8443 ,";
    expect(loadConfig().publicHosts).toEqual([
      "relay.example.ts.net",
      "relay.example.com:8443",
    ]);
  });

  test("uses the launcher's effective public hosts over a blank EnvironmentFile value", () => {
    process.env.HERDR_RELAY_PUBLIC_HOSTS = "";
    process.env.HERDR_RELAY_EFFECTIVE_PUBLIC_HOSTS = "host.tailnet.ts.net:8787";
    expect(loadConfig().publicHosts).toEqual(["host.tailnet.ts.net:8787"]);
  });

  test("uses HTTP as the public scheme only for explicit HTTP serve mode", () => {
    process.env.HERDR_RELAY_SERVE_MODE = "http";
    expect(loadConfig().publicScheme).toBe("http");
    process.env.HERDR_RELAY_SERVE_MODE = "HTTPS";
    expect(loadConfig().publicScheme).toBe("https");
    process.env.HERDR_RELAY_SERVE_MODE = "garbage";
    expect(loadConfig().publicScheme).toBe("https");
  });

  test("splits comma lists, trimming whitespace and dropping blanks", () => {
    process.env.HERDR_RELAY_SUBMIT_KEYS = " ctrl+a , Enter ,";
    expect(loadConfig().submitKeys).toEqual(["ctrl+a", "Enter"]);
    process.env.HERDR_RELAY_ALLOWED_ORIGINS = "https://a.example.com, https://b.example.com";
    expect(loadConfig().allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  test("falls back to [Enter] when HERDR_RELAY_SUBMIT_KEYS is empty", () => {
    process.env.HERDR_RELAY_SUBMIT_KEYS = "";
    expect(loadConfig().submitKeys).toEqual(["Enter"]);
  });

  test("honours an explicit trusted user but rejects a non-loopback bind override", () => {
    process.env.HERDR_RELAY_TRUSTED_USER = "me@example.com";
    process.env.HERDR_RELAY_HOST = "0.0.0.0";
    const cfg = loadConfig();
    expect(cfg.trustedUser).toBe("me@example.com");
    expect(cfg.host).toBe("127.0.0.1");
  });
});
