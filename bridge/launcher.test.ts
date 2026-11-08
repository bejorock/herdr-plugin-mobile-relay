import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("relay launcher", () => {
  test("prints a quote-safe managed reinstall command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-launcher-"));
    temporaryDirectories.push(directory);
    const herdr = join(directory, "herdr");
    await writeFile(
      herdr,
      `#!/bin/sh
cat <<'JSON'
{"result":{"plugins":[{"plugin_id":"rad.herdr-mobile-relay","source":{"owner":"acme","repo":"rad-herdr-mobile-relay","subdir":"plugins/mobile","requested_ref":"release'candidate"}}]}}
JSON
`,
    );
    await chmod(herdr, 0o755);

    const script = resolve(import.meta.dir, "../scripts/relay-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; managed_reinstall_command', "bash", script], {
      env: {
        ...process.env,
        HERDR_PLUGIN_CONFIG_DIR: directory,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(
      "herdr plugin install 'acme/rad-herdr-mobile-relay/plugins/mobile' --ref 'release'\\''candidate' --yes",
    );
  });

  test("loads dotenv configuration as data instead of executing shell fragments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-dotenv-"));
    temporaryDirectories.push(directory);
    const config = join(directory, "config");
    await mkdir(config, { recursive: true });
    const marker = join(directory, "must-not-exist");
    await writeFile(
      join(config, ".env"),
      `# valid configuration\nHERDR_RELAY_SOCKET=/tmp/private/relay.sock\nIGNORED=$(touch ${marker})\n`,
    );
    const script = resolve(import.meta.dir, "../scripts/relay-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; test "$HERDR_RELAY_SOCKET" = /tmp/private/relay.sock; test -n "$IGNORED"; test ! -e "$2"', "bash", script, marker], {
      env: { ...process.env, HOME: directory, HERDR_PLUGIN_CONFIG_DIR: config, PATH: "/usr/bin:/bin" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("writes a systemd unit with an unquoted absolute working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-unit-"));
    temporaryDirectories.push(directory);
    const bun = join(directory, "bun");
    await writeFile(bun, "#!/bin/sh\nexit 0\n");
    await chmod(bun, 0o755);
    const script = resolve(import.meta.dir, "../scripts/relay-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; have_systemd() { return 0; }; systemctl() { return 0; }; write_unit; grep -E "^WorkingDirectory=/" "$UNIT_FILE"; grep -E "^ExecStart=/" "$UNIT_FILE"', "bash", script], {
      env: { ...process.env, HOME: directory, HERDR_PLUGIN_CONFIG_DIR: join(directory, "config"), PATH: `/usr/bin:/bin:${dirname(bun)}` },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("writes an optional systemd environment file using valid unquoted syntax", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-envfile-"));
    temporaryDirectories.push(directory);
    const bun = join(directory, "bun");
    await writeFile(bun, "#!/bin/sh\nexit 0\n");
    await chmod(bun, 0o755);
    const config = join(directory, "config");
    const script = resolve(import.meta.dir, "../scripts/relay-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; have_systemd() { return 0; }; systemctl() { return 0; }; write_unit; grep -Fx "EnvironmentFile=-$HERDR_PLUGIN_CONFIG_DIR/.env" "$UNIT_FILE"', "bash", script], {
      env: { ...process.env, HOME: directory, HERDR_PLUGIN_CONFIG_DIR: config, PATH: `/usr/bin:/bin:${dirname(bun)}` },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("finds Bun from its standard user install path when a plugin action has a minimal PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-bun-"));
    temporaryDirectories.push(directory);
    const bin = join(directory, ".bun/bin");
    await mkdir(bin, { recursive: true });
    const bun = join(bin, "bun");
    await writeFile(bun, "#!/bin/sh\nexit 0\n");
    await chmod(bun, 0o755);
    const script = resolve(import.meta.dir, "../scripts/relay-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; test "$BUN" = "$HOME/.bun/bin/bun"', "bash", script], {
      env: { ...process.env, HOME: directory, PATH: "/usr/bin:/bin", HERDR_PLUGIN_CONFIG_DIR: join(directory, "config") },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("exports the discovered Bun directory so nested Bun scripts find bunx", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-bun-path-"));
    temporaryDirectories.push(directory);
    const bin = join(directory, ".bun/bin");
    await mkdir(bin, { recursive: true });
    const bun = join(bin, "bun");
    const bunx = join(bin, "bunx");
    await writeFile(bun, "#!/bin/sh\nexit 0\n");
    await writeFile(bunx, "#!/bin/sh\nexit 0\n");
    await chmod(bun, 0o755);
    await chmod(bunx, 0o755);
    const script = resolve(import.meta.dir, "../scripts/relay-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; command -v bun; command -v bunx', "bash", script], {
      env: { ...process.env, HOME: directory, PATH: "/usr/bin:/bin", HERDR_PLUGIN_CONFIG_DIR: join(directory, "config") },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().split("\n").filter(Boolean)).toEqual([bun, bunx]);
  });

  test("launchd stop removes the RunAtLoad plist so the bridge stays stopped after login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-launchd-stop-"));
    temporaryDirectories.push(directory);
    const plist = join(directory, "Library/LaunchAgents/dev.rad.herdr-mobile-relay.plist");
    await mkdir(join(directory, "Library/LaunchAgents"), { recursive: true });
    await writeFile(plist, "placeholder");
    const script = resolve(import.meta.dir, "../scripts/relay-ctl.sh");
    const result = Bun.spawnSync(
      [
        "/bin/bash",
        "-c",
        'source "$1"; have_systemd() { return 1; }; have_launchd() { return 0; }; launchd_domain() { echo gui/501; }; launchctl() { return 0; }; cmd_stop; test ! -e "$LAUNCHD_FILE"',
        "bash",
        script,
      ],
      {
        env: {
          ...process.env,
          HOME: directory,
          HERDR_PLUGIN_CONFIG_DIR: join(directory, "config"),
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("reference unit and launcher are socket-only without network publishing", async () => {
    const unit = await Bun.file(resolve(import.meta.dir, "../systemd/rad-herdr-mobile-relay.service")).text();
    expect(unit).toContain("HERDR_RELAY_SOCKET=");
    expect(unit).toContain("UMask=0077");
    expect(unit).not.toContain("PrivateTmp=yes");
    const script = await Bun.file(resolve(import.meta.dir, "../scripts/relay-ctl.sh")).text();
    expect(script).not.toContain("tailscale");
    expect(script).not.toContain("HERDR_RELAY_PORT");
    expect(script).toContain("unix: process.argv[1]");
  });
});
