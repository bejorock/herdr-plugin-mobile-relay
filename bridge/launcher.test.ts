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

describe("collie launcher", () => {
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

    const script = resolve(import.meta.dir, "../scripts/collie-ctl.sh");
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

  test("finds Bun from its standard user install path when a plugin action has a minimal PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-bun-"));
    temporaryDirectories.push(directory);
    const bin = join(directory, ".bun/bin");
    await mkdir(bin, { recursive: true });
    const bun = join(bin, "bun");
    await writeFile(bun, "#!/bin/sh\nexit 0\n");
    await chmod(bun, 0o755);
    const script = resolve(import.meta.dir, "../scripts/collie-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; test "$BUN" = "$HOME/.bun/bin/bun"', "bash", script], {
      env: { ...process.env, HOME: directory, PATH: "/usr/bin:/bin", HERDR_PLUGIN_CONFIG_DIR: join(directory, "config") },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("launchd stop removes the RunAtLoad plist so the bridge stays stopped after login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-launchd-stop-"));
    temporaryDirectories.push(directory);
    const plist = join(directory, "Library/LaunchAgents/dev.rad.herdr-mobile-relay.plist");
    await mkdir(join(directory, "Library/LaunchAgents"), { recursive: true });
    await writeFile(plist, "placeholder");
    const script = resolve(import.meta.dir, "../scripts/collie-ctl.sh");
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

  test("reference systemd unit leaves launcher-only effective values unset", async () => {
    const unit = await Bun.file(resolve(import.meta.dir, "../systemd/rad-herdr-mobile-relay.service")).text();
    expect(unit).not.toContain("HERDR_CONTROL_EFFECTIVE_PORT");
    expect(unit).not.toContain("HERDR_CONTROL_EFFECTIVE_PUBLIC_HOSTS");
  });

  test("ACP Claude hook lifecycle preserves existing Claude hook entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-claude-hooks-"));
    temporaryDirectories.push(directory);
    const settings = join(directory, ".claude/settings.json");
    await mkdir(dirname(settings), { recursive: true });
    const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "moshi-hook claude-hook" }] }] } };
    await writeFile(settings, JSON.stringify(existing));
    const helper = resolve(import.meta.dir, "../scripts/acp-hooks.ts");
    const env = { ...process.env, HOME: directory, HERDR_PLUGIN_STATE_DIR: join(directory, "state") };
    const install = Bun.spawnSync([process.execPath, "run", helper, "install", "claude"], { env, stdout: "pipe", stderr: "pipe" });
    expect(install.exitCode, install.stderr.toString()).toBe(0);
    const installed = JSON.parse(await Bun.file(settings).text()) as { hooks: { SessionStart: unknown[]; PermissionRequest: unknown[]; PreToolUse: unknown[]; PostToolUse: unknown[]; PostToolUseFailure: unknown[]; MessageDisplay: unknown[]; Stop: unknown[] } };
    expect(installed.hooks.SessionStart).toHaveLength(2);
    expect(installed.hooks.PermissionRequest).toHaveLength(1);
    expect(installed.hooks.PreToolUse).toHaveLength(1);
    expect(installed.hooks.PostToolUse).toHaveLength(1);
    expect(installed.hooks.PostToolUseFailure).toHaveLength(1);
    expect(installed.hooks.MessageDisplay).toHaveLength(1);
    expect(installed.hooks.Stop).toHaveLength(1);
    expect(JSON.stringify(installed.hooks.SessionStart[0])).toContain("moshi-hook");
    expect(JSON.stringify(installed.hooks.SessionStart[1])).toContain("herdr-relay-acp.sh");
    expect(JSON.stringify(installed.hooks.PermissionRequest[0])).toContain("herdr-relay-acp.sh");
    expect(JSON.stringify(installed.hooks.PreToolUse[0])).toContain("herdr-relay-acp.sh");
    expect(JSON.stringify(installed.hooks.PostToolUse[0])).toContain("herdr-relay-acp.sh");
    expect(JSON.stringify(installed.hooks.MessageDisplay[0])).toContain("herdr-relay-acp.sh");
    const hook = join(directory, ".claude/hooks/herdr-relay-acp.sh");
    expect(await Bun.file(hook).exists()).toBe(true);
    const source = await Bun.file(hook).text();
    expect(source).toContain('"hookEventName":"PreToolUse"');
    expect(source).toContain('"answers":answers');
    expect(source).toContain('"Approve Claude\'s plan"');

    const uninstall = Bun.spawnSync([process.execPath, "run", helper, "uninstall", "claude"], { env, stdout: "pipe", stderr: "pipe" });
    expect(uninstall.exitCode, uninstall.stderr.toString()).toBe(0);
    const removed = JSON.parse(await Bun.file(settings).text()) as { hooks: { SessionStart: unknown[]; PermissionRequest: unknown[]; PreToolUse: unknown[]; PostToolUse: unknown[]; PostToolUseFailure: unknown[]; MessageDisplay: unknown[]; Stop: unknown[] } };
    expect(removed.hooks.SessionStart).toHaveLength(1);
    expect(removed.hooks.PermissionRequest).toEqual([]);
    expect(removed.hooks.PreToolUse).toEqual([]);
    expect(removed.hooks.PostToolUse).toEqual([]);
    expect(removed.hooks.PostToolUseFailure).toEqual([]);
    expect(removed.hooks.MessageDisplay).toEqual([]);
    expect(removed.hooks.Stop).toEqual([]);
    expect(JSON.stringify(removed.hooks.SessionStart[0])).toContain("moshi-hook");
    expect(await Bun.file(hook).exists()).toBe(false);
  });

  test("ACP Pi hook lifecycle preserves unrelated extension entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rad-herdr-mobile-relay-hooks-"));
    temporaryDirectories.push(directory);
    const settings = join(directory, ".pi/agent/settings.json");
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ extensions: ["+extensions/moshi-hooks.ts", "+extensions/herdr-agent-state.ts"] }));
    const helper = resolve(import.meta.dir, "../scripts/acp-hooks.ts");
    const env = { ...process.env, HOME: directory, HERDR_PLUGIN_STATE_DIR: join(directory, "state") };
    const install = Bun.spawnSync([process.execPath, "run", helper, "install"], { env, stdout: "pipe", stderr: "pipe" });
    expect(install.exitCode, install.stderr.toString()).toBe(0);
    const installed = JSON.parse(await Bun.file(settings).text()) as { extensions: string[] };
    expect(installed.extensions).toEqual([
      "+extensions/moshi-hooks.ts",
      "+extensions/herdr-agent-state.ts",
      "+extensions/herdr-relay-acp.ts",
    ]);
    const extension = join(directory, ".pi/agent/extensions/herdr-relay-acp.ts");
    expect(await Bun.file(extension).exists()).toBe(true);
    const generated = await Bun.file(extension).text();
    expect(generated).toContain("herdr-relay:publish");
    expect(generated).toContain("herdr-relay:request-permission");
    expect(generated).toContain("herdr-relay:request-elicitation");
    expect(generated).toContain("herdr-relay:interaction-result");

    const uninstall = Bun.spawnSync([process.execPath, "run", helper, "uninstall"], { env, stdout: "pipe", stderr: "pipe" });
    expect(uninstall.exitCode, uninstall.stderr.toString()).toBe(0);
    const removed = JSON.parse(await Bun.file(settings).text()) as { extensions: string[] };
    expect(removed.extensions).toEqual(["+extensions/moshi-hooks.ts", "+extensions/herdr-agent-state.ts"]);
    expect(await Bun.file(extension).exists()).toBe(false);
  });
});
