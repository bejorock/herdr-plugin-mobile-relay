import { copyFile, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const marker = "herdr-relay-interactions";
const root = resolve(import.meta.dir, "..");
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
async function load(path: string): Promise<Record<string, any>> {
  try { const value = JSON.parse(await readFile(path, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Invalid settings: ${path}`); }
}
async function save(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  try { await copyFile(path, `${path}.relay-backup-${Date.now()}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600);
}
export async function manageIntegrations(action: "install" | "uninstall" | "status", options: { home?: string; stateDir?: string } = {}) {
  const home = options.home ?? homedir();
  const piDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const stateDir = options.stateDir ?? process.env.HERDR_PLUGIN_STATE_DIR ?? process.env.HERDR_RELAY_STATE_DIR ?? join(home, ".local", "state", "herdr", "plugins", "rad.herdr-mobile-relay");
  const socket = join(stateDir, "agent-hook.sock");
  if (!socket.startsWith("/") || /[\r\n\0]/.test(socket)) throw new Error("State directory must be an absolute single-line path");
  const piSettingsPath = join(piDir, "settings.json"); const claudeSettingsPath = join(claudeDir, "settings.json");
  const pi = await load(piSettingsPath); const claude = await load(claudeSettingsPath);
  if (pi.extensions !== undefined && !Array.isArray(pi.extensions)) throw new Error("Invalid Pi extensions configuration");
  if (claude.hooks !== undefined && (!claude.hooks || typeof claude.hooks !== "object" || Array.isArray(claude.hooks))) throw new Error("Invalid Claude hooks configuration");
  const piPath = join(piDir, "extensions", `${marker}.ts`);
  const claudePath = join(claudeDir, "hooks", `${marker}.sh`);
  const ownedPi = (entry: unknown) => typeof entry === "string" && ["extensions/herdr-relay-acp.ts", "+extensions/herdr-relay-acp.ts", `extensions/${marker}.ts`, `+extensions/${marker}.ts`, piPath, `+${piPath}`, join(piDir, "extensions", "herdr-relay-acp.ts"), `+${join(piDir, "extensions", "herdr-relay-acp.ts")}`].includes(entry);
  // Recognize exact generated command paths, not arbitrary commands containing a matching word.
  const commands = [claudePath, join(claudeDir, "hooks", "herdr-relay-acp.sh")].flatMap((path) => [`sh ${shellQuote(path)}`, `bash ${shellQuote(path)}`]);
  const ownedClaude = (entry: any) => entry?.type === "command" && commands.includes(entry.command);
  if (action === "status") return { pi: (pi.extensions ?? []).some(ownedPi), claude: Object.values(claude.hooks ?? {}).some((groups: any) => Array.isArray(groups) && groups.some((g: any) => Array.isArray(g.hooks) && g.hooks.some(ownedClaude))) };
  const nextPi = { ...pi, extensions: (pi.extensions ?? []).filter((entry: unknown) => !ownedPi(entry)) };
  const hooks: Record<string, any[]> = {};
  for (const [event, groups] of Object.entries(claude.hooks ?? {})) {
    if (!Array.isArray(groups)) throw new Error("Invalid Claude hook group");
    hooks[event] = groups.flatMap((group: any) => {
      if (!group || !Array.isArray(group.hooks)) throw new Error("Invalid Claude hook handlers");
      const handlers = group.hooks.filter((entry: unknown) => !ownedClaude(entry));
      return handlers.length ? [{ ...group, hooks: handlers }] : [];
    });
    if (!hooks[event]!.length) delete hooks[event];
  }
  if (action === "install") {
    await mkdir(resolve(piPath, ".."), { recursive: true, mode: 0o700 }); await mkdir(resolve(claudePath, ".."), { recursive: true, mode: 0o700 });
    // Wrappers reference this pinned checkout; do not overwrite Herdr's own integration files.
    for (const target of [piPath, claudePath]) {
      try {
        const content = await readFile(target, "utf8");
        if (!content.includes(`Generated ${marker}`)) throw new Error("Refusing to overwrite unrecognized adapter file");
        await copyFile(target, `${target}.relay-backup-${Date.now()}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await writeFile(piPath, `// Generated ${marker}; explicit install only.\nprocess.env.HERDR_RELAY_HOOK_SOCKET ||= ${JSON.stringify(socket)};\nexport { default } from ${JSON.stringify(join(root, "adapters", "pi-interactions.ts"))};\n`, { mode: 0o600 });
    await writeFile(claudePath, `#!/bin/sh\n# Generated ${marker}; native request/response only.\nif [ -z "\${HERDR_RELAY_HOOK_SOCKET:-}" ]; then HERDR_RELAY_HOOK_SOCKET=${shellQuote(socket)}; export HERDR_RELAY_HOOK_SOCKET; fi\nexec ${shellQuote(process.execPath)} run ${shellQuote(join(root, "adapters", "claude-interactions.ts"))}\n`, { mode: 0o700 });
    nextPi.extensions.push(`+extensions/${marker}.ts`);
    hooks.PermissionRequest = [...(hooks.PermissionRequest ?? []), { hooks: [{ type: "command", command: `sh ${shellQuote(claudePath)}`, timeout: 240 }] }];
    hooks.PreToolUse = [...(hooks.PreToolUse ?? []), { matcher: "^(AskUserQuestion|ExitPlanMode)$", hooks: [{ type: "command", command: `sh ${shellQuote(claudePath)}`, timeout: 240 }] }];
  }
  // Uninstall/migration must neutralize obsolete auto-loaded Pi entrypoints too. Keep files for
  // backup but move out of extensions; otherwise removing the explicit setting is insufficient.
  for (const old of [join(piDir, "extensions", "herdr-relay-acp.ts"), ...(action === "uninstall" ? [piPath] : [])]) {
    try {
      const content = await readFile(old, "utf8");
      if (!content.includes("Generated by Herdr Mobile Relay hooks-install") && !content.includes(`Generated ${marker}`)) throw new Error("Refusing to move unrecognized relay extension file");
      await rename(old, join(piDir, `${old.split("/").at(-1)}.relay-backup-${Date.now()}`));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await save(piSettingsPath, nextPi); await save(claudeSettingsPath, { ...claude, hooks });
  return { action, piSettingsPath, claudeSettingsPath, restartPi: true };
}
if (import.meta.main) {
  const action = process.argv[2];
  if (!["install", "uninstall", "status"].includes(action ?? "")) throw new Error("Usage: bun run scripts/agent-integrations.ts install|uninstall|status");
  console.log(JSON.stringify(await manageIntegrations(action as "install" | "uninstall" | "status")));
}
