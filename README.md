# Herdr Relay — lean baseline

An authenticated, loopback-only HTTP relay for Herdr, with optional native terminal streaming. Clients own the user interface.

## Scope

- Herdr runtime snapshots and named-runtime selection.
- Workspace/tab/worktree and pane management, terminal input, bounded image uploads, and workspace file/Git inspection.
- Owner-configured host folder browse/validate/create on Linux, separate from Herdr workspace creation. Disabled by default; [directory contract](docs/HTTP_DIRECTORIES.md).
- Optional `/api/live` WebSocket: Herdr-derived snapshot invalidations and terminal frames. This is **terminal output, not an agent transcript**.
- Loopback binding, Tailscale Serve identity checks, optional device write authorization, and audit logging.

There is **no bundled application/PWA, browser Web Push, notification preferences, release-alert service, or `/acp` endpoint**.

HTTP harness discovery and native conversation create/read/resume are implemented; see [HTTP lifecycle contract](docs/HTTP_LIFECYCLE.md) for schemas, errors and limitations. These lifecycle paths have automated mocked-Herdr coverage and [live Pi/Claude HTTP validation](docs/HTTP_LIFECYCLE_LIVE_VALIDATION.md), including native context recall after recovery. Fault-injected launch failures remain mocked-test coverage only. Discovery reports `unknown` where Herdr only proves an installed hook, not executable availability.

HTTP native transcript history/following and selected Herdr events are implemented; see [HTTP streams](docs/HTTP_STREAMS.md). Native tool content is client-rendered. Terminal frames, transcript records and Herdr events have distinct purposes. Pending interaction reads, request/resolution events, HTTP responses and the native hook listener are implemented; see [HTTP interactions](docs/HTTP_INTERACTIONS.md). Adapters are explicitly installed—not silently added to agent settings. Durable restoration is HTTP-only; ACP is removed.

## Checkpoint and branches

The previous full implementation is preserved at:

- tag `v1.0.14`
- branch `archive/acp-collie-v1.0.14`
- tag `archive-acp-collie-v1.0.14`

The API-only reset is developed on `lean-relay`. Version `2.0.0` marks breaking removal of the old interfaces; it is not a claim that the replacement agent API is complete.

## Development

Requirements: Bun, running Herdr (plugin minimum in `herdr-plugin.toml`), and Tailscale for remote access.

```sh
bun install
bun run typecheck
bun test ./bridge
bun run dev
```

Configuration is documented in [`.env.example`](.env.example). All former `COLLIE_*` configuration keys are replaced by `HERDR_RELAY_*`; they are **not silently inherited**. Migrate the existing `.env` before switching a running installation. Explicit migration avoids accidentally enabling an obsolete identity policy.

Example:

```dotenv
HERDR_RELAY_TRUSTED_USER=you@example.com
HERDR_RELAY_PUBLIC_HOSTS=your-host.your-tailnet.ts.net
```

The service reads `.env` strictly as data, never shell code. Herdr's `HERDR_SOCKET_PATH` and plugin directory variables remain unchanged.

## Plugin/service operations

```sh
herdr plugin link /absolute/path/to/herdr-plugin-mobile-relay
```

Build directly with `bash scripts/relay-ctl.sh build`. Available plugin actions include `start`, `stop`, `restart`, `status`, `url`, `version`, `update`, and `uninstall`. Linux uses a systemd user service; macOS uses launchd. No frontend build or automatic hook installation runs.

Install/migrate native adapters explicitly using `bun run scripts/agent-integrations.ts install` (or `status`/`uninstall`). Set `HERDR_PLUGIN_STATE_DIR` to the **running relay's state directory** when installing outside a Herdr plugin action; the generated wrappers must point at that relay's socket. The installer backs up settings, preserves unrelated/Herdr-owned hooks, and removes only recognized old relay-owned settings. Restart/reload Pi after installation. Do not run migration against the old production relay until deploying the lean build; its old response protocol differs. See the interaction guide for scope and limitations.

## API and security

- [HTTP OpenAPI](docs/openapi.json)
- [HTTP lifecycle contract and limitations](docs/HTTP_LIFECYCLE.md)
- [HTTP transcript and Herdr SSE contract](docs/HTTP_STREAMS.md)
- [HTTP interactions, native adapter installation and live evidence](docs/HTTP_INTERACTIONS.md)
- [Host folder operations, root configuration and platform limits](docs/HTTP_DIRECTORIES.md)
- [Terminal WebSocket reference](docs/DEVELOPER_API.md)
- [Architecture and remaining work](docs/ARCHITECTURE.md)
- [Revamp direction and implementation assessment](docs/LEAN_RELAY_REVAMP.md) — agreed scope, adapter changes, phases and acceptance; not yet implemented API contracts.

Only loopback binding is permitted. Publish remotely using **Tailscale Serve, never Funnel**. Remote requests require an allowed public Host and valid proxy-injected Tailscale identity. Configure one trusted user, a trusted-user list, or explicit any-authenticated-tailnet-user mode; enforce network permission with Tailscale ACLs. Optional device policy restricts writes further. Native clients use `X-Herdr-Client: herdr-mobile-v1` for origin-less writes on an approved public Host. Browser writes require an approved Origin.

Unknown or removed routes return 404; no SPA fallback exists. `/api/live` retains terminal frames and invalidation signals. `/api/events` delivers a selected, privacy-projected Herdr event subset, not durable/raw replay of every Herdr event. Transcript SSE follows durable records, not token deltas.

## Attribution

The project retains MIT-licensed infrastructure derived from Collie. Removing its application features does not remove its license obligations; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
