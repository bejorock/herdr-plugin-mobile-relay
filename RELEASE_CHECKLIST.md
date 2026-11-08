# Socket-only release verification

- Preserve prior refs; work on `lean-relay`, not an implicit production cutover.
- Run `bun install`, `bun run typecheck`, `bun test ./bridge`, shell syntax checks and `bash scripts/check-version.sh`.
- Verify no daemon TCP listener; Unix directory/socket modes, active ownership, stale recovery and cleanup.
- Exercise HTTP, SSE and terminal WebSocket over Unix socket/SSH forwarding; test SFTP separately using the host subsystem.
- Verify removed ACP/PWA/push/preferences/directory/generic file/upload routes return 404.
- Preserve transcript privacy, native identity/callback checks, body limits and mutation retry safeguards.
- Before deployment explicitly migrate old port/proxy/device/root configuration and adapter entries. Regenerate service files; keep socket visible to the SSH account (no PrivateTmp).
- New tooling never modifies SSH or Tailscale configuration. Separately verify/remove only a former relay-owned Serve mapping if the owner wants it removed.
- Native agents and transcripts are not deleted during migration. Do not claim new native lifecycle coverage from transport-only tests.
- Verify Linux and macOS on their actual systems before cross-platform release acceptance; document unavailable evidence honestly.
