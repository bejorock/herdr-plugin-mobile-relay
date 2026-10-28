# Changelog

## [1.0.2] - 2026-10-28

### Fixed

- Discover Bun from the standard `~/.bun/bin/bun` location when Herdr invokes plugin actions with a minimal `PATH`.

## [1.0.1] - 2026-10-28

### Changed

- Enable the experimental ACP v2 WebSocket endpoint by default. Set `COLLIE_ACP=off` to deliberately disable it; Pi and Claude hooks remain separately explicit opt-in actions.

## [1.0.0] - 2026-10-27

### Added

- Experimental, opt-in ACP v2 JSON-RPC WebSocket adapter at `/acp`.
- Opaque ACP session mapping, proof-confirmed prompts, transcript replay/tailing, restart-safe Claude binding recovery, bounded interaction broker, and ACP audit records.
- Pi ACP integration: private relay extension, low-latency state/tool/message/thought updates, text/image prompts, explicit `pi.events` notification/permission/elicitation bridge, and bounded multi-select forms.
- Claude Code ACP integration: private command hooks, text/private-path image prompts, native `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode`, and best-effort assistant/tool/idle updates.
- Explicit hook install/status/uninstall lifecycle that preserves unrelated Herdr, Moshi, and user hook configuration.
- ACP operations, security, client API, and release documentation.

### Security

- ACP stays loopback-only and reuses the relay's trusted-user/device authorization gates.
- Owner-only local hook socket, upload files, audit state, and persisted Claude transcript bindings.
- No Herdr pane IDs, native session IDs, host transcript paths, or private upload paths are exposed through ACP.

### Compatibility

- Renamed this fork's plugin identity from upstream `herdr.control` to `rad.herdr-mobile-relay` so both plugins can coexist on one host.
- ACP remains experimental; the final disposable Claude smoke test for private-path image prompting and live semantic hooks is deferred until cloud quota is available.

## [0.1.0] - 2026-07-15

- Added the T3 Code-style desktop and mobile control plane.
- Added the Collie-derived Herdr socket bridge, Tailscale launcher, audit log, and multi-session discovery.
- Added live pane output, replies, terminal keys, uploads, workspace/tab creation, and pane termination.
- Added PWA packaging and a typed client boundary for future native apps.
