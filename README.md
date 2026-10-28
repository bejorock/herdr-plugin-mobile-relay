# Herdr Mobile Relay

Herdr Mobile Relay is the host-side companion for remote Herdr clients. It runs beside Herdr,
translates a bounded HTTP and WebSocket API into Herdr socket operations, and can publish that API
privately through Tailscale Serve.

Native client repository: [Herdr Mobile](https://github.com/benkraus/herdr-mobile).

The repository is packaged as a Herdr plugin. This fork uses the unique registered plugin ID
`rad.herdr-mobile-relay`, so it can coexist with upstream plugins that use a different ID.

> **Fork migration:** `rad.herdr-mobile-relay` deliberately uses its own plugin configuration,
> state directory, service unit, push tags, and Tailscale Serve ownership record. It does not reuse
> an upstream `herdr.control` installation. Install/configure this plugin separately; keep the
> upstream plugin installed only if you intentionally want both services.

## What it provides

- A responsive browser control surface served by the relay itself.
- A native-client API used by the separate
  [Herdr Mobile](https://github.com/benkraus/herdr-mobile) application.
- Live terminal frames with device-sized terminal control.
- Workspace, worktree, tab, pane, and multi-session navigation.
- Bounded workspace file previews and read-only Git status/diff inspection.
- Authorized terminal input and structural mutations.
- Optional Web Push notifications for agent state changes.
- Append-only auditing of remote write operations.
- launchd supervision on macOS and systemd user-service supervision on Linux.
- Private tailnet publishing through Tailscale Serve.
- An opt-in ACP v2 WebSocket adapter for structured Pi and Claude Code sessions.
- Explicit, owner-only local Pi/Claude hook bridges for low-latency semantic updates and remote interactions.

Herdr remains the source of truth. Closing a browser or mobile client does not terminate the Herdr
server, its workspaces, terminal panes, or agents.

## Architecture

```text
browser or native mobile app
          |
          | HTTPS REST + session-scoped WebSocket
          v
Tailscale Serve (tailnet-only reverse proxy)
          |
          | loopback HTTP
          v
Herdr Mobile Relay (Bun, 127.0.0.1:8787 by default)
          |
          | Herdr RPC over Unix socket
          v
Herdr server -> workspaces -> tabs -> panes -> agents
```

Tailscale normally establishes a direct peer-to-peer WireGuard path. It may transparently use a
DERP relay when a direct path cannot be established; this application does not operate a central
Internet relay of its own.

The relay uses REST for snapshots, bounded workspace/file/Git reads, and mutations. Workspace
inspection resolves roots from Herdr's authoritative workspace state, rejects path traversal and
symlink reads, and caps file and Git output sizes. A WebSocket carries structural change
notifications and native terminal frames. The selected terminal is driven at the client’s measured
columns and rows, which lets smaller devices navigate a live TUI instead of viewing a desktop-width
text dump.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for ownership and protocol boundaries.

## Requirements

- Herdr 0.7.0 or newer.
- Bun available on `PATH`.
- macOS or Linux.
- Tailscale when remote tailnet access is desired.
- A single-user host, or an owner-isolated VM/container.

The relay is intentionally unavailable on Windows because its service lifecycle and Herdr socket
integration currently target launchd and systemd-style environments.

## Install from GitHub

Replace `<owner>` with the GitHub account or organization that publishes this repository:

```bash
herdr plugin install bejorock/herdr-plugin-mobile-relay --yes
```

Herdr runs the manifest build step during installation. That step installs both Bun dependency
trees, typechecks the relay and browser client, and produces the static web bundle.

Create the private configuration file before starting remote access:

```bash
config_dir="$(herdr plugin config-dir rad.herdr-mobile-relay)"
install -d -m 700 "$config_dir"
install -m 600 .env.example "$config_dir/.env"
```

Edit `$config_dir/.env` and set at least the trusted Tailscale identity for remote use:

```dotenv
COLLIE_TRUSTED_USER=you@example.com
```

Then start the service:

```bash
herdr plugin action invoke start --plugin rad.herdr-mobile-relay
herdr plugin action invoke status --plugin rad.herdr-mobile-relay
herdr plugin action invoke url --plugin rad.herdr-mobile-relay
```

The URL action prints the address to enter in Herdr Mobile, normally similar to:

```text
https://your-machine.your-tailnet.ts.net:8787
```

Do not publish this service with Tailscale Funnel. Authorized write endpoints can type into live
terminal processes and therefore carry the authority of a remote shell.

## Local development installation

Clone the repository, then link it instead of installing a managed GitHub checkout:

```bash
git clone https://github.com/bejorock/herdr-plugin-mobile-relay.git
cd herdr-plugin-mobile-relay
herdr plugin link "$(pwd)"
herdr plugin action invoke start --plugin rad.herdr-mobile-relay
```

Herdr does not run manifest build steps for a local link. The first `start` builds the browser client
lazily when `web/dist` is absent.

## Configuration

All settings live in the plugin configuration directory returned by:

```bash
herdr plugin config-dir rad.herdr-mobile-relay
```

Copy [.env.example](.env.example) to `.env` in that directory. Important settings include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COLLIE_PORT` | `8787` | Loopback relay port. |
| `COLLIE_HOST` | `127.0.0.1` | Bind host; non-loopback values are rejected. |
| `COLLIE_SERVE_MODE` | `https` | Tailscale Serve mode; `http` supports Headscale environments without certificates. |
| `COLLIE_SERVE_PORT` | relay port | Dedicated public tailnet listener. |
| `HERDR_SOCKET_PATH` | Herdr default socket | Override only for a nonstandard Herdr installation. |
| `COLLIE_MULTI_SESSION` | `on` | Discover and expose named Herdr sessions. |
| `COLLIE_ACP` | `on` | Enable the experimental ACP v2 WebSocket endpoint at `/acp`; set `off` to disable it. |
| `COLLIE_UPDATE_REPO` | unset | Optional GitHub `owner/repo` for release-update checks, e.g. `bejorock/herdr-plugin-mobile-relay`. |
| `COLLIE_POLL_MS` | `1500` | Fast fallback polling interval. |
| `COLLIE_POLL_IDLE_MS` | `12000` | Safety-net polling while event subscriptions are healthy. |
| `COLLIE_READ_LINES` | `200` | Default bounded pane read size. |
| `COLLIE_NOTIFY_DELAY_MS` | `30000` | Notification debounce interval. |
| `COLLIE_TRUSTED_USER` | unset | Required matching proxy identity for remote API access. |
| `COLLIE_TRUSTED_USER_HEADER` | `Tailscale-User-Login` | Identity header injected by the trusted proxy. |
| `COLLIE_PUBLIC_HOSTS` | derived for Tailscale | Allowed public `host[:port]` values. |
| `COLLIE_ALLOWED_ORIGINS` | unset | Extra full browser origins for custom reverse proxies. |
| `COLLIE_DEVICE_HEADER` | unset | Optional proxy-injected device identity header. |
| `COLLIE_DEVICE_ALLOWLIST` | unset | Devices allowed to perform write operations. |
| `COLLIE_VAPID_PUBLIC` | unset | Optional Web Push public key. |
| `COLLIE_VAPID_PRIVATE` | unset | Optional Web Push private key. |
| `COLLIE_VAPID_SUBJECT` | generic mailto | Optional Web Push administrator contact. |

### Tailscale

The `start` action installs a dedicated Serve listener and records exactly which mapping it owns.
Updates and teardown verify that ownership before replacing or removing anything, so unrelated
Tailscale Serve applications are left intact.

The default public port matches `COLLIE_PORT` rather than taking over port 443. Set
`COLLIE_SERVE_PORT=443` only when this relay should own the root MagicDNS HTTPS URL.

### Headscale and custom proxies

Set `COLLIE_SERVE_MODE=http` for a private Headscale network without managed HTTPS certificates.
For another TLS terminator or vanity domain, configure the exact public host and origin:

```dotenv
COLLIE_PUBLIC_HOSTS=herdr.example.com
COLLIE_ALLOWED_ORIGINS=https://herdr.example.com
```

The proxy must strip and inject the configured trusted-user header and must preserve public request
provenance using standard forwarded headers. Never accept a client-supplied identity header directly.

### Optional device authorization

Device authorization is an additional write gate, not a substitute for user authentication. A
trusted reverse proxy can inject an opaque device ID:

```dotenv
COLLIE_DEVICE_HEADER=X-Device-Id
COLLIE_DEVICE_ALLOWLIST=phone,tablet
```

Unknown devices become read-only. On a public host, a missing device header also fails closed to
read-only access.

### Web Push

Generate VAPID keys with:

```bash
bunx web-push generate-vapid-keys
```

Set all three `COLLIE_VAPID_*` values, restart the relay, then subscribe from the browser client.
Push subscriptions and preferences are stored in the private plugin state directory.

## Plugin actions

```bash
herdr plugin action invoke start --plugin rad.herdr-mobile-relay
herdr plugin action invoke stop --plugin rad.herdr-mobile-relay
herdr plugin action invoke restart --plugin rad.herdr-mobile-relay
herdr plugin action invoke status --plugin rad.herdr-mobile-relay
herdr plugin action invoke url --plugin rad.herdr-mobile-relay
herdr plugin action invoke version --plugin rad.herdr-mobile-relay
herdr plugin action invoke update --plugin rad.herdr-mobile-relay
herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay
herdr plugin action invoke hooks-status --plugin rad.herdr-mobile-relay
herdr plugin action invoke hooks-uninstall --plugin rad.herdr-mobile-relay
herdr plugin action invoke uninstall --plugin rad.herdr-mobile-relay
```

`hooks-install` is opt-in and installs only the relay's separate Pi extension and Claude relay
hooks; it does not alter Herdr-managed, Moshi-managed, or other user extension entries. Restart Pi
or Claude Code after installing or uninstalling it. Target one adapter directly with
`bash scripts/collie-ctl.sh hooks-install pi` or `... hooks-install claude`. `uninstall` removes
the supervised service and the Serve mapping created by this
plugin. It keeps the private `.env`, state directory, and source checkout. Remove the plugin
registration separately:

```bash
herdr plugin uninstall rad.herdr-mobile-relay
```

The `update` action can update a linked branch checkout. Herdr-managed GitHub installs are pinned to
a resolved commit; for those installations the action prints the safe uninstall/reinstall command.

For update notifications from this published fork, opt in with:

```dotenv
COLLIE_UPDATE_REPO=bejorock/herdr-plugin-mobile-relay
```

## Development

Install dependencies:

```bash
bun install
cd web && bun install && cd ..
```

Run the relay and browser development server separately:

```bash
# Terminal 1
bun run dev:bridge

# Terminal 2
bun run dev:web
```

Vite proxies `/api` to `http://127.0.0.1:8787`. Add `?demo=1` to the browser URL to use preview
data explicitly. Connection failures do not silently enable demo mode.

Run verification:

```bash
bun run typecheck
bun run test
bun run build
```

## Repository layout

```text
bridge/                 Bun HTTP/WebSocket service and Herdr socket adapter
docs/                   Architecture and protocol notes
scripts/                Service, update, Tailscale, push, and release helpers
systemd/                Reference systemd user unit
web/                    React/Vite browser client and PWA
herdr-plugin.toml       Herdr plugin manifest
.env.example            Documented runtime configuration
```

## ACP agent API (experimental)

Herdr Mobile Relay includes an [Agent Client Protocol (ACP) v2](https://agentclientprotocol.com/) adapter by default. It uses a WebSocket-only JSON-RPC endpoint:

```text
local:  ws://127.0.0.1:8787/acp
remote: wss://your-machine.your-tailnet.ts.net:8787/acp
```

ACP is enabled by default. To deliberately disable it in the private plugin configuration file:

```dotenv
COLLIE_ACP=off
```

Then restart the bridge:

```bash
herdr plugin action invoke restart --plugin rad.herdr-mobile-relay
```

ACP does not replace the existing interfaces:

```text
/api/*       Herdr workspace/pane/worktree management
/api/live    raw terminal/control WebSocket fallback
/acp         structured ACP agent sessions
```

See the built-in **Developer API Reference** at `http://127.0.0.1:8787/developer.html` (or the equivalent private Tailscale URL) for interactive REST request/response documentation, route security, and WebSocket summaries. Its raw OpenAPI 3.1 document is served at `/developer/openapi.json` for client generation or tooling. The complete rendered **ACP WebSocket Guide** is available beside it at `/developer-acp.html`. The repository's [Developer API Guide](docs/DEVELOPER_API.md) explains REST conventions and the raw `/api/live` WebSocket protocol. See [ACP WebSocket API](docs/ACP_API.md) for the source version of the full ACP wire contract, initialization example, session lifecycle, and client requirements. See the [ACP Operations Guide](docs/ACP_OPERATIONS.md) for enablement, hook lifecycle, troubleshooting, and security guidance.

### What ACP supports

| Agent | Supported ACP behavior |
| --- | --- |
| **Pi** | Session replay/tailing, proof-confirmed text and image prompts, cancellation, best-effort state/tool/text/thought updates, and explicit extension event-bus notifications/approvals/forms. |
| **Claude Code** | Session replay/tailing, proof-confirmed text prompts, native permission decisions, `AskUserQuestion` single/multi-select, `ExitPlanMode` approval, best-effort assistant/tool/idle semantic updates, and safe terminal-local fallback when no remote client can answer. Private-path image prompting is implemented but awaits its final live smoke test after Claude quota renewal. |

The relay creates opaque `herdr_…` ACP session IDs. ACP responses never disclose Herdr pane IDs, native session IDs, or host transcript/upload paths.

### Enable local agent hooks explicitly

ACP transcript replay and semantic prompts work without modifying agent configuration. Optional low-latency updates and native interaction mapping require relay-owned local hooks. Installation is explicit and never happens when the relay starts:

```bash
# Install both adapters.
herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay

# Inspect current state.
herdr plugin action invoke hooks-status --plugin rad.herdr-mobile-relay

# Remove only relay-owned entries/files.
herdr plugin action invoke hooks-uninstall --plugin rad.herdr-mobile-relay
```

To target one adapter from a checkout, use the lifecycle helper with the plugin state directory inherited from the plugin action or service:

```bash
bash scripts/collie-ctl.sh hooks-install pi
bash scripts/collie-ctl.sh hooks-install claude
bash scripts/collie-ctl.sh hooks-status all
```

Restart affected Pi or Claude Code sessions after an install, update, or uninstall. The installer preserves existing Herdr, Moshi, and user extensions/hooks; it removes only entries it owns.

### Pi extension event bridge

Pi global/native permissions are intentionally not intercepted. A Pi extension opts into remote interaction by emitting events on Pi's shared event bus:

```text
herdr-relay:publish
herdr-relay:request-permission
herdr-relay:request-elicitation
herdr-relay:interaction-result
```

Forms support bounded strings, numbers, integers, booleans, single-select enums, and multi-select string arrays. The originating extension always owns the host-side action after receiving the result. See [Pi relay hook events](docs/PI_RELAY_HOOK_EVENTS.md) for payloads, response handling, and security rules.

### ACP safety rules

- Keep the relay loopback-only and use Tailscale Serve or an equally trusted private proxy; **never use Tailscale Funnel**.
- Configure `COLLIE_TRUSTED_USER` for remote access and optional device allowlisting for remote writes.
- ACP prompt delivery succeeds only after matching native transcript evidence; terminal injection acknowledgement alone is insufficient.
- Images are written to owner-only server-generated upload files. Native prompts may receive a private path, but ACP replay redacts that path.
- The first **valid**, write-authorized client interaction response wins. Invalid responses do not consume the request.
- If no authorized ACP client can answer a native Claude interaction, Claude retains its terminal-local UI.
- ACP is experimental. Treat client interoperability and agent hook contracts as versioned opt-in behavior.

## Security model

- The relay always binds loopback.
- Remote access is disabled until a trusted user is configured.
- Every non-loopback request must match the public Host allowlist.
- Browser writes are protected by same-origin checks.
- Forwarded requests do not receive loopback operator exemptions.
- Terminal output is rendered as text rather than injected HTML.
- Mutation bodies, uploads, scrollback, and concurrency are bounded.
- Writes are attributed in an append-only audit log.
- Runtime credentials and state use owner-only filesystem permissions.

Operate it only on a single-user host or an equivalently isolated environment.

## Troubleshooting

Check relay and service status:

```bash
herdr plugin action invoke status --plugin rad.herdr-mobile-relay
bash scripts/collie-ctl.sh logs 100
```

Common causes:

- **Remote requests return 403:** configure `COLLIE_TRUSTED_USER` and verify Tailscale Serve is
  injecting the expected identity.
- **Cross-origin rejected:** add the exact custom origin and public host to the allowlists.
- **Browser UI returns 503:** run `bash scripts/collie-ctl.sh build`, then restart.
- **Herdr shows disconnected:** confirm the Herdr server is running and the configured socket exists.
- **No HTTPS on Headscale:** use HTTP Serve mode inside the private tailnet or add an external TLS
  terminator; PWA installation and Web Push still require a secure browser context.
- **Port already belongs to another Serve app:** choose another `COLLIE_SERVE_PORT`; the launcher
  intentionally refuses to overwrite mappings it does not own.
- **`/acp` returns 404 or upgrade fails:** confirm `COLLIE_ACP` is not set to `off`, then restart the bridge.
- **ACP has transcript updates but no live Pi/Claude events:** explicitly install the appropriate relay hook and restart that agent session.
- **Claude uses terminal-local permission/question/plan UI:** no write-authorized ACP client was connected, the interaction was cancelled/expired, or the hook is not installed for that session. This is fail-safe behavior.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
