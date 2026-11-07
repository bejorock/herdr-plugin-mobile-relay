# Herdr Relay — lean baseline

An authenticated, loopback-only HTTP relay for Herdr, with optional native terminal streaming. Clients own the user interface.

## Scope

- Herdr runtime snapshots and named-runtime selection.
- Workspace/tab/worktree and pane management, terminal input, bounded image uploads, and workspace file/Git inspection.
- Optional `/api/live` WebSocket: Herdr-derived snapshot invalidations and terminal frames. This is **terminal output, not an agent transcript**.
- Loopback binding, Tailscale Serve identity checks, optional device write authorization, and audit logging.

There is **no bundled application/PWA, browser Web Push, notification preferences, release-alert service, or `/acp` endpoint**.

Native Pi/Claude transcript readers, private session-binding storage and hook/request-response foundations are retained under `bridge/agents/`. They are internal, tested building blocks, **not wired to a public conversation API or active hook listener yet**. This pruning pass does not implement replacement transcript/event/response endpoints. Durable restoration through ACP is no longer available.

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

Build directly with `bash scripts/relay-ctl.sh build`. Available plugin actions include `start`, `stop`, `restart`, `status`, `url`, `version`, `update`, and `uninstall`. Linux uses a systemd user service; macOS uses launchd. No frontend build or hook installation runs.

Old agent settings may still reference the previous `scripts/acp-hooks.ts`. This branch does not silently edit Pi/Claude configuration. Before deploying it, remove only the obsolete relay-owned hook/extension entries, preserving unrelated configuration. Use the archived installer source as a reference or its `hooks-uninstall` command from the archived checkout; back up agent settings first. Do not delete Herdr's own integrations.

## API and security

- [HTTP OpenAPI](docs/openapi.json)
- [Terminal WebSocket reference](docs/DEVELOPER_API.md)
- [Architecture and remaining work](docs/ARCHITECTURE.md)

Only loopback binding is permitted. Publish remotely using **Tailscale Serve, never Funnel**. Remote requests require an allowed public Host and valid proxy-injected Tailscale identity. Configure one trusted user, a trusted-user list, or explicit any-authenticated-tailnet-user mode; enforce network permission with Tailscale ACLs. Optional device policy restricts writes further. Native clients use `X-Herdr-Client: herdr-mobile-v1` for origin-less writes on an approved public Host. Browser writes require an approved Origin.

Unknown or removed routes return 404; no SPA fallback exists. `/api/live` sends invalidation signals, not a durable/raw replay of every Herdr event. A future structured HTTP/event API is a separate design step.

## Attribution

The project retains MIT-licensed infrastructure derived from Collie. Removing its application features does not remove its license obligations; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
