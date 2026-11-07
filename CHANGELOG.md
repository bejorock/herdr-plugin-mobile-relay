# Changelog

## [2.0.3] - 2026-11-07

### Added

- HTTP pending question/permission reads and validated response delivery, with scoped SSE request/resolution/expiry/cancellation events and exact native callback ownership.
- Minimal Pi inter-extension forwarding and Claude native PermissionRequest/AskUserQuestion/plan adapters; explicit settings-backed installer with backups and targeted legacy migration.
- Active hook socket ownership protection, connection shutdown cleanup and stale native-request sweeps. No ACP or transcript-inferred approvals.

### Validation and limits

- Live real-Pi two-request parent-forwarding callbacks and real-Claude question answer/permission denial through HTTP; isolated relay and test-owned panes, no personal settings changes or production restart.
- Separate child-process forwarding, universal extension UI interception, native plan approval and permission allow execution remain unvalidated; discovery executable verification and folder APIs are still pending.

## [2.0.2] - 2026-11-07

### Added

- HTTP native transcript history and bounded SSE following with conversation-scoped prefix cursors, partial-write handling, active Pi branch selection and native tool content.
- HTTP SSE for selected real Herdr events, with safe field projection, bounded in-memory reconnect history and explicit snapshot resynchronization signals.
- Stream queue/subscriber/lifetime limits and shutdown/abort cleanup; terminal WebSocket remains separate.

### Validation and limitations

- Read prior real Pi/Claude conversations over HTTP and resumed SSE at the tail without duplicate records; observed real Herdr `tab_created`/`pane_created` events from a disposable tab. No model calls in these streaming checks.
- Initial transcript implementation uses bounded whole-file reads with a short cache, default storage roots and fixed file/record limits. Native interaction events/responses, updated integrations, attach-existing and folder APIs remain pending.

## [2.0.1] - 2026-11-07

### Added

- HTTP-only Pi/Claude discovery and conversation create/read/resume with runtime/cwd validation, private native identity journal, durable request-ID deduplication and exact native restoration proof.
- Journal unresolved launch allocations before mutation; retries never blindly launch another agent. Initial launches without saved native identity require explicit inspection rather than unsafe pane-only adoption.
- Structured lifecycle errors and first-increment OpenAPI/contract documentation, plus the complete lean revamp direction.

### Validation and limitations

- Automated HTTP/security and mocked Herdr/native lifecycle tests; this HTTP implementation has not yet received live Pi/Claude acceptance validation.
- Installed-hook evidence alone reports discovery as unknown. Public transcript/events/interactions, attach-existing and folder APIs remain pending.

## [2.0.0] - 2026-11-07

### Changed

- Reset to an API-only Herdr relay on the `lean-relay` branch. Preserve the previous implementation at `archive-acp-collie-v1.0.14`.
- Remove ACP endpoint/SDK, bundled frontend/PWA, browser push, notification preferences/snooze, and background release/update alerts.
- Keep Herdr HTTP management, workspace inspection, terminal WebSocket, audit and authorization protections.
- Rename launcher to `scripts/relay-ctl.sh` and configuration to `HERDR_RELAY_*` (breaking; migrate existing dotenv values).
- Preserve native transcript readers, private binding storage and hook/interaction foundations under `bridge/agents`; no replacement public agent API is exposed yet.


## [1.0.14] - 2026-11-04

### Fixed

- Make Claude ACP prompts and durable recovery independent of the cross-process Claude hook socket: securely discover transcripts only by the exact Herdr-reported native Claude UUID under `~/.claude/projects`.

### Validated

- Live-tested Claude ACP lifecycle: create → proof-confirmed prompt → close pane → `session/resume` into a replacement pane with the same native Claude UUID and opaque ACP session ID.

## [1.0.13] - 2026-11-04

### Fixed

- Wait for Herdr to confirm an interactive named agent before ACP’s first semantic prompt, avoiding the `agent_not_ready` creation race.
- Boundly retry only Herdr’s definitive pre-delivery `agent_not_ready` prompt rejection; ambiguous prompt failures remain non-retried.

### Validated

- Live-tested Pi ACP lifecycle: create → proof-confirmed prompt → close pane → `session/list` resumable → `session/resume` into a new pane under the same opaque ACP ID.

## [1.0.12] - 2026-11-04

### Added

- Make opaque ACP session IDs durable logical conversation identities: `session/resume` can safely recreate a closed Pi or Claude pane against its validated stored native conversation, then replay/tail it under the original ID.
- Keep closed-but-recoverable sessions visible in ACP `session/list` with `herdr.dev.resumable: true`.

### Safety

- Session recovery requires ACP write authorization, serializes concurrent recovery requests, validates owner-only persisted transcript/native handles, and fails instead of silently creating a fresh conversation when the native conversation cannot be proven.

## [1.0.11] - 2026-10-28

### Added

- Support `COLLIE_TRUSTED_USERS` for explicit multi-user Tailscale identity allowlists.
- Support explicit `COLLIE_ALLOW_ANY_TAILNET_USER=on` mode for any authenticated identity permitted by tailnet ACLs; anonymous/public requests remain denied.

## [1.0.10] - 2026-10-28

### Fixed

- Document fish-compatible macOS configuration commands and avoid assuming `.env.example` is in the user's current directory.
- Parse relay `.env` configuration as dotenv data rather than sourcing it as shell code.

## [1.0.9] - 2026-10-28

### Added

- Render the Pi extension `pi.events` relay-hook guide inside the developer portal at `/developer-pi-hooks.html`, linked from both REST and ACP developer references.

## [1.0.8] - 2026-10-28

### Added

- Render the complete ACP v2 WebSocket guide inside the developer portal at `/developer-acp.html`, linked directly from the Redoc REST reference.

## [1.0.7] - 2026-10-28

### Fixed

- Improve the Redoc developer portal's dark theme contrast, code styling, response panels, navigation, and typography for readable API documentation.

## [1.0.6] - 2026-10-28

### Added

- Ship an interactive Redoc developer portal at `/developer.html`, backed by a same-origin OpenAPI 3.1 document at `/developer/openapi.json`.
- Document REST control-plane routes, security requirements, the `/api/live` terminal WebSocket protocol, and the ACP WebSocket integration path for third-party client authors.

## [1.0.5] - 2026-10-28

### Fixed

- Generate valid optional systemd `EnvironmentFile=` syntax, so remote Tailscale access settings in the plugin `.env` load correctly.

## [1.0.4] - 2026-10-28

### Fixed

- Export the discovered Bun directory into plugin action `PATH` so nested `bun run` scripts can resolve `bunx`.

## [1.0.3] - 2026-10-28

### Fixed

- Generate a valid systemd `WorkingDirectory=` and `ExecStart=` when starting the plugin service.

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
