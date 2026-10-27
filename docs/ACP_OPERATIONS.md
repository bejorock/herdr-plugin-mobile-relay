# ACP Operations Guide

This guide is for operators of Herdr Mobile Relay's experimental ACP adapter.

## Enable ACP

ACP is disabled by default. Edit the plugin configuration file:

```bash
config_dir="$(herdr plugin config-dir rad.herdr-mobile-relay)"
install -d -m 700 "$config_dir"
install -m 600 .env.example "$config_dir/.env"  # only when it does not yet exist
```

Set:

```dotenv
COLLIE_ACP=on
```

Then restart the bridge:

```bash
herdr plugin action invoke restart --plugin rad.herdr-mobile-relay
```

The endpoint is:

```text
ws://127.0.0.1:8787/acp              local host
wss://<tailnet-host>:8787/acp         through Tailscale Serve
```

ACP uses the same trusted-user, public-host, same-origin, and optional device-write authorization gates as the normal relay API.

## Install agent hooks

Hooks are optional and are **never installed automatically**. They add local semantic updates and native interaction mapping; transcript replay and proof-based prompts do not require them.

```bash
# Install both Pi and Claude adapters.
herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay

# Check state.
herdr plugin action invoke hooks-status --plugin rad.herdr-mobile-relay

# Remove only relay-owned entries/files.
herdr plugin action invoke hooks-uninstall --plugin rad.herdr-mobile-relay
```

From a checkout, target one adapter directly:

```bash
bash scripts/collie-ctl.sh hooks-install pi
bash scripts/collie-ctl.sh hooks-install claude
bash scripts/collie-ctl.sh hooks-status all
```

Restart affected Pi or Claude Code sessions after every hook install, refresh, or uninstall.

The installer preserves unrelated configuration:

```text
Pi:      existing extension entries remain unchanged
Claude:  existing SessionStart, PermissionRequest, PreToolUse,
         PostToolUse, PostToolUseFailure, MessageDisplay, and Stop hooks remain unchanged
```

## Supported behavior

| Capability | Pi | Claude Code |
| --- | --- | --- |
| Transcript history/reconnect replay | Yes | Yes |
| Complete transcript tail updates | Yes | Yes |
| Proof-confirmed text prompt | Yes | Yes |
| ACP image prompt | `@private-path` | private absolute-path instruction *(final live smoke test pending Claude quota)* |
| Private upload path exposed to ACP client | Never | Never |
| Cancellation | Escape for working/blocked Pi | Not mapped as native cancellation |
| Live assistant content | extension deltas | `MessageDisplay` line batches |
| Live tool state | extension events | Pre/Post tool hooks |
| Native permission | explicit extension event only | `PermissionRequest` |
| Native question | explicit extension event only | `AskUserQuestion` single/multi-select |
| Native plan approval | explicit extension event only | `ExitPlanMode` |

Transcript replay is authoritative. Live chunks and semantic hook updates are best-effort UX acceleration and may be repeated or followed by a transcript-backed complete update.

## Pi extension integration

Pi native/global permissions are intentionally not intercepted. An extension explicitly opts in by emitting events on Pi's shared event bus:

```text
herdr-relay:publish
herdr-relay:request-permission
herdr-relay:request-elicitation
herdr-relay:interaction-result
```

See [PI Relay Hook Events](PI_RELAY_HOOK_EVENTS.md) for payload definitions. Elicitation forms accept bounded primitive properties plus bounded multi-select string arrays. The originating extension must perform the resulting host-side action itself.

## Claude native interaction behavior

The relay adapts documented Claude hook paths only where it can safely return an exact native decision:

```text
PermissionRequest   → ACP approval/denial
AskUserQuestion     → ACP form elicitation
ExitPlanMode        → ACP markdown plan update + approval
```

A failed, expired, invalid, disconnected, or unauthorised remote interaction does not auto-approve. Claude retains its terminal-local interaction UI.

## Security and privacy

- Bind only to loopback; this relay rejects non-loopback bind settings.
- Use Tailscale Serve or an equally trusted private proxy. **Never use Tailscale Funnel.**
- Configure `COLLIE_TRUSTED_USER` before remote use.
- Treat ACP write access as remote shell authority.
- ACP session IDs are opaque. ACP responses do not contain Herdr pane IDs, native agent IDs, transcript paths, or private upload paths.
- Images are written to server-generated owner-only files. Native prompts can reference the private path; ACP transcript replay redacts it.
- A pending approval/form is delivered only to write-authorized ACP clients. The first valid response wins.
- Claude transcript-path bindings are stored owner-only and restored only when their exact live Herdr pane/native ID still matches.

## Audit trail

The relay appends bounded metadata to its owner-only audit log in the state directory. ACP records include:

```text
acp.session.new
acp.prompt
acp.cancel
acp.interaction.permission
acp.interaction.elicitation
```

Prompt text, image bytes, transcript paths, and upload paths are not recorded in ACP audit metadata.

## Client requirements

ACP is WebSocket-only and experimental. Clients must:

1. Connect to `/acp`.
2. Send JSON-RPC 2.0 text frames.
3. Send `initialize` first, exactly once.
4. Include ACP v2 `protocolVersion: 2` and `info.name` / `info.version`.
5. Call `session/list`, then `session/resume` with the exact listed `cwd`.
6. Treat transcript replay as recovery after reconnect.

See [ACP WebSocket API](ACP_API.md) for request/response examples.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/acp` unavailable | Confirm `COLLIE_ACP=on`, then restart the bridge. |
| ACP has history but no live semantic events | Install the relevant hook and restart that Pi/Claude session. |
| Claude shows a local permission/question/plan UI | No authorized ACP writer was connected, an answer was invalid, or the hook interaction expired/cancelled. This is intentional fail-safe behavior. |
| Pi extension receives no interaction result | Confirm the Pi relay hook is installed, the extension uses an exact request ID, and an authorized ACP client answered. |
| An image path appears in terminal output | Expected on the native host side. ACP clients must receive only redacted replay text and original prompt image content. |
| Remote requests return 403 | Configure `COLLIE_TRUSTED_USER`, correct proxy headers, and—if enabled—device allowlisting. |

## Release caveat

ACP v2 and the underlying Claude hook surface are evolving. Pin compatible clients, retain transcript replay as the recovery path, and test hooks after upgrading Pi or Claude Code. Before publishing a release that advertises Claude image prompting or live semantic hooks as live-validated, complete the deferred disposable Claude smoke test after cloud quota renewal.
