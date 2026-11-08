# SSH + SFTP transport (socket-only daemon)

Implemented direction: TypeScript/Bun remains. The daemon does not implement SSH, SFTP, authentication-key management or an SSH listener. Owner/client manages those. This document supersedes earlier TCP/Tailscale Serve and scoped-directory deployment contracts.

```text
ADE native layer/backend
  └─ existing SSH server on agent host
       ├─ forwarded Unix stream → relay.sock → HTTP/SSE/terminal WebSocket
       │                                  → Herdr socket → agents
       └─ SFTP subsystem → account-authorized host files/directories
```

Browser-only applications need a native/backend SSH layer. Client SSH libraries must support OpenSSH streamlocal forwarding or an equivalent owner-configured tunnel. No changes to system SSH configuration are made by build/start/install.

## Socket contract

- `HERDR_RELAY_SOCKET`, default `<stateDir>/relay.sock`; absolute, at most 100 UTF-8 bytes for conservative Linux/macOS Unix socket compatibility. Choose a short dedicated private directory if state path is long.
- Socket parent: same owner, non-symlink final directory, mode 0700. Socket: mode 0600. Existing ancestor aliases (e.g. macOS `/var` → `/private/var`) are resolved by the OS; local owner/admin is trusted.
- No daemon TCP listener or automatic TCP fallback. `HERDR_RELAY_PORT`, Tailscale identity/device headers and Serve/public-host configuration are removed.
- Startup uses an owner-private `<socket>.lock` directory to serialize probe/bind, then probes existing owned sockets before reclaiming stale entries; active listeners and ordinary files/symlinks are refused. Dead-PID locks can be reclaimed; an incomplete lock (crash before PID write) fails closed for operator inspection. Cleanup checks the owned inode before removal. Never put the socket in a shared non-dedicated parent: permissions are tightened.
- `relay.sock` is distinct from Herdr's control socket (`HERDR_SOCKET_PATH`) and local adapter `agent-hook.sock`.
- Local socket access grants owner authority, not a per-Cowork-member read-only role. SSH identity/keys are not inferred from request headers. Audits record operations, not invented remote user attribution.

## HTTP through forwarding

Native clients use `Host: localhost` (also accepted: loopback or `relay.localhost`) and `X-Herdr-Client: herdr-mobile-v1` on mutation requests and WebSocket upgrades. No permissive CORS. Browser origins are denied unless explicitly listed by exact origin in `HERDR_RELAY_ALLOWED_ORIGINS`. Forwarding/Tailscale headers are rejected rather than interpreted as identity. These request-shape checks protect client-side loopback tunnels; they do not authenticate an OS user or replace SSH security.

Direct host inspection:

```sh
curl --unix-socket /absolute/private/relay.sock http://localhost/api/config
curl -N --unix-socket /absolute/private/relay.sock http://localhost/api/events
```

Example using system OpenSSH (owner config/host verification applies):

```sh
ssh -N -L 127.0.0.1:18787:/absolute/private/relay.sock owner@host
curl http://127.0.0.1:18787/api/config
curl -H 'X-Herdr-Client: herdr-mobile-v1' -H 'Content-Type: application/json' \
  -d '{"kind":"pi","cwd":"/repo","requestId":"create-001"}' \
  http://127.0.0.1:18787/api/conversations
```

This opens a **client-local** TCP tunnel, not a daemon TCP port. Native libraries can open remote Unix-stream channels directly without a local TCP listener. HTTP/SSE/WebSocket remain their existing application formats inside the channel. SSH reconnect requires opening new streams and using transcript/event cursors and pending-request reads; Herdr agents outlive client disconnection.

## Filesystem boundary

Use the existing SSH SFTP subsystem for folders and file transfer. Removed: `/api/directories`, `/api/directories/validate`, `/api/workspace/{id}/files`, `/api/workspace/{id}/file`, `/api/pane/{id}/upload` and their generic file-transfer runtime machinery. Those routes return 404. Historical private uploads are not erased. Native transcript readers retain path/size safeguards and legacy private-path redaction.

SFTP grants the SSH account's OS filesystem authority. The old relay browse-root policy is not retained or claimed equivalent. No custom symlink resolver/native helper is needed for generic file operations. Agent cwd validation remains at create/resume; Herdr workspace/tab/worktree operations and structured Git status/diff inspection remain, since SFTP does not provide their semantics.

## Services and migration

Linux systemd --user and macOS launchd continue to supervise the Bun daemon. Launchers load dotenv as data, discover Bun with minimal PATH, report socket readiness and do not run Tailscale commands. `socket` replaces the plugin `url` action. Service umask is 0077; avoid PrivateTmp because sshd must see the same socket path.

Before explicitly restarting a linked installation:

1. Preserve current checkpoint and private conversations/settings.
2. Remove obsolete port/public-host/Tailscale/device/browse-root variables; set a suitable socket path if needed.
3. Regenerate service configuration using the updated launcher; do not restart while another migration is incomplete.
4. Separately remove **only the old relay-owned** Tailscale Serve mapping if desired, after verifying its target. New tooling deliberately does not mutate Tailscale state or unrelated mappings.
5. Install/migrate relay-owned Pi/Claude adapters explicitly with the running state directory; keep Herdr integrations and unrelated hooks.
6. Connect through the owner's SSH setup and SFTP client. No automatic production cutover.

## Validation

Automated tests use actual Unix HTTP, SSE, and WebSocket upgrade/data transport; assert Bun has no port/hostname listener; check directory/socket modes, active socket collision, stale socket recovery, ordinary-file/symlink refusal and replaced-path cleanup. Existing lifecycle/interaction tests now use Unix HTTP and request-shape gates rather than proxy identities.

### Live transport evidence (2026-11-08)

On Linux with OpenSSH 10.5p1, a separate nonprivileged sshd was launched on loopback port 22987 using ephemeral keys/configuration in a private cache directory. Its temporary host key was explicitly pinned with StrictHostKeyChecking=yes and a dedicated known-hosts file; no host/user SSH configuration or authorized_keys was changed. A separate real relay served only its Unix socket.

OpenSSH local forwarding to that remote Unix socket passed HTTP `/api/config` (build 3.0.0), SSE `/api/events` resynchronization and terminal WebSocket 101 upgrade. SFTP on the temporary SSH server passed directory create/list/remove. The first SSH attempt used temporary keys under `/tmp`, which strict SSH ownership checks rejected; the retry used an owner-private directory. An initial SFTP test used an unsupported `ls -d` flag; it was corrected to listing the parent. Neither failure required changing host SSH policy.

Temporary servers/tunnels/keys/state and SFTP test folders were removed. Production remained `1.0.14+29b27e2`. Tests did not invoke models or modify personal Pi/Claude settings. The SSH check proves loopback OpenSSH streamlocal forwarding, not mobile-client library compatibility, network-change reconnects or macOS execution. Existing Pi/Claude functional live evidence predates the transport change; no new native-agent execution over SSH is claimed.
