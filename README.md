# Herdr Relay — SSH + native agent interface

A TypeScript/Bun daemon exposing Herdr management and structured Pi/Claude conversations over an **owner-private Unix socket**. Clients own the UI and SSH connection. No relay TCP port, Tailscale Serve, ACP or bundled PWA.

```text
ADE native layer/backend → SSH
                          ├─ relay.sock → HTTP/SSE/terminal WebSocket → Herdr/agents
                          └─ SFTP → host folders/files
```

## Capabilities

- Herdr runtime snapshots, workspace/tab/pane/worktree management and structured Git status/diff inspection.
- HTTP Pi/Claude discovery and conversation create/read/resume with private native identity and retry safeguards.
- HTTP native transcript history/following; native tool content stays client-rendered.
- HTTP pending question/permission reads, response delivery and actionable SSE events through explicit Pi/Claude adapters.
- Optional terminal WebSocket `/api/live`, distinct from native transcript streaming.
- Owner-private socket/state, bounded requests/streams, audits and native callback ownership checks.

Use **SFTP for filesystem management**. No custom directory picker, general file-preview or upload endpoints remain. SFTP permissions are the SSH account's OS authority, not a relay root sandbox. Clients decide which folders to present; agent launch still validates cwd.

## Development

```sh
bun install
bun run typecheck
bun test ./bridge
bun run dev
```

See [`.env.example`](.env.example). State defaults to `HERDR_PLUGIN_STATE_DIR` when injected or `~/.local/state/rad-herdr-mobile-relay`. Public socket defaults to `<stateDir>/relay.sock`; use `HERDR_RELAY_SOCKET` for a shorter dedicated private path (maximum 100 UTF-8 bytes). Herdr's existing socket is separately selected by `HERDR_SOCKET_PATH`.

```sh
curl --unix-socket /absolute/private/relay.sock http://localhost/api/config
```

## SSH connection

The host's existing OpenSSH server provides authentication/encryption and SFTP; this daemon does not install/configure SSH. A native client/backend can forward directly to the remote Unix socket. A system-client example:

```sh
ssh -N -L 127.0.0.1:18787:/absolute/private/relay.sock owner@host
curl http://127.0.0.1:18787/api/config
```

Native HTTP writes and WebSocket upgrades include `X-Herdr-Client: herdr-mobile-v1`. Browser origins are denied unless explicitly configured; no permissive CORS. These are tunnel/browser safeguards, not user authentication. SSH connection security and ADE membership authorization belong to the owner/client. See [transport, filesystem boundary and migration](docs/SSH_TRANSPORT.md).

## Service and native adapters

`bash scripts/relay-ctl.sh build` installs dependencies and typechecks. Plugin actions: `start`, `stop`, `restart`, `status`, `socket`, `version`, `update`, `uninstall`. Linux uses systemd --user; macOS uses launchd. No network publishing or automatic agent settings changes.

Install/migrate native adapters explicitly with `HERDR_PLUGIN_STATE_DIR` set to the **running daemon's state directory**:

```sh
bun run scripts/agent-integrations.ts install
# also: status / uninstall
```

Backups and targeted legacy migration preserve unrelated and Herdr-owned integrations. Reload/restart Pi after extension changes. Do not migrate adapters against the old ACP production build before explicit cutover.

## Contracts and evidence

- [SSH/socket deployment and SFTP ownership](docs/SSH_TRANSPORT.md)
- [HTTP OpenAPI](docs/openapi.json)
- [Terminal WebSocket](docs/DEVELOPER_API.md)
- [Conversation lifecycle](docs/HTTP_LIFECYCLE.md) and [native live evidence](docs/HTTP_LIFECYCLE_LIVE_VALIDATION.md)
- [Transcripts and Herdr SSE](docs/HTTP_STREAMS.md)
- [Native interactions and live evidence](docs/HTTP_INTERACTIONS.md)
- [Architecture](docs/ARCHITECTURE.md) and [revamp history](docs/LEAN_RELAY_REVAMP.md)

Discovery still reports unknown when Herdr only proves installed hooks. Public attach-existing remains pending (hook registration can attach a proven native requester internally). Existing live Pi/Claude evidence predates the SSH transport migration; see transport documentation for current validation limits.

## Checkpoints

Development is on `lean-relay`; `main` and production are not automatically changed. Previous ACP/Collie implementation: branch `archive/acp-collie-v1.0.14`, tags `archive-acp-collie-v1.0.14` and `v1.0.14`. Historical `2.0.4` directory APIs were superseded by SFTP, not extended into another custom filesystem backend. Old private state is not automatically erased or migrated.

## Attribution

MIT-licensed infrastructure derived from Collie retains its attribution: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
