# HTTP native interactions

**Transport update:** HTTP/SSE now runs on an owner-private Unix socket via SSH; generic filesystem operations use SFTP. See [SSH transport](SSH_TRANSPORT.md). Old TCP/Tailscale/device-policy references in historical evidence are not current authorization.
Implemented first interaction increment on `lean-relay` (2.0.3); evidence and limits below. No ACP and no UI/card model.

- `GET /api/interactions?session=<runtime>&conversationId=<optional>` returns `{session,interactions:[...]}` for currently pending requests. Unknown runtime 404, disconnected runtime 503. Read access required.
- `POST /api/interactions/{id}/response?session=<runtime>` body `{response: ...}` requires write access. Permission response: `{optionId:"allow_once"|"reject_once"}` (or another explicitly offered ID). Question response: `{action:"accept",content:{...}}`, `{action:"decline"}` or `{action:"cancel"}`. Reject extra response fields/invalid schema; invalid input must not consume the request. Success 200 `{ok:true}` acknowledges delivery to the registered callback, not completed tool execution.
- `/api/events` emits `interaction.requested`, `interaction.resolved`, `interaction.expired`, `interaction.cancelled`. Request event contains `{interaction}`; terminal events contain `{session,conversationId,id,reason}`. Query pending requests after reconnect; events are not a durable permission journal. Responses are not stored in event rings or audit logs.

Interaction fields: public random `id`, stable `conversationId`, `session`, harness `agent`, `kind` (permission/elicitation), title/description, options/schema, `expiresAt`, and optional toolCallId/parentToolCallId/executionId/plan. Clients own rendering and transcript correlation. Native UUIDs/transcript references are private. Event content is sensitive authorized data; known structured credential fields/private native references are redacted.

## Routing and lifecycle

Only a live native hook/extension can register a request. Transcript tool names do not create requests. Requests are bound to the exact native conversation, pane occupant and owning socket. Register/deliver responses only after a fresh Herdr native-identity check. Existing agents with proven native identity gain a durable conversation mapping when their first actual request is registered; no prompt or launch occurs. Pane IDs alone never authorize a wait. First valid authorized response wins; unknown/already-consumed IDs return 404 `interaction_unknown`, invalid responses 400 `invalid_response`, stale native/owner state 409 `interaction_stale`. Requests time out (maximum five minutes), cancel on owning socket loss, owner cancellation, native-session changes or relay stop; no synthetic allow is returned. Observing clients may disconnect without cancelling the native wait.

## Native adapters

Opt-in explicit installation only; no automatic user-settings changes on server startup/build. Back up settings, preserve unrelated hooks and Herdr-owned integrations, migrate only recognized old relay-owned entries. Minimum dependencies: Bun for installed adapters; Pi must be restarted/reloaded after extension changes. Socket path is configured in generated adapter wrappers, with runtime override `HERDR_RELAY_HOOK_SOCKET` for isolated tests.

Pi adapter forwards only explicit `herdr-relay:request-permission`, `herdr-relay:request-elicitation`, and `herdr-relay:cancel-interaction` events; results use `herdr-relay:interaction-result` with original requestId. No universal interception of `ctx.ui`; no duplicate token/tool/status streaming. Workflow parents forward unique request IDs plus optional provenance and must propagate cancellation/answers to children. Separate child processes cannot impersonate the parent native binding. Pending requests are cancelled, not replayed automatically across adapter socket/session replacement.

Claude adapter handles actual `PermissionRequest` and `PreToolUse` for `AskUserQuestion|ExitPlanMode`. It returns native documented hook output, not ACP envelopes. Preserves tool_use_id and optional agent_id as provenance; agent_id is not sufficient evidence of parent ownership. Different native child-session identity is rejected unless explicitly forwarded by a trusted parent integration. Connection/EOF/timeouts return no approval, preserving the native permission flow. Question cancellation likewise falls back to native UI, not an invented answer. Explicit deny for plan approval must block, not fall through as a successful allow. Bound input/output/socket frames and total waits. Claude's PermissionRequest input may omit tool_use_id; correlation is then absent rather than guessed. No post-tool/message/status observer hooks required.

## Sources and acceptance

Consulted Claude official hooks reference: https://code.claude.com/docs/en/hooks (PermissionRequest decisions, PreToolUse updatedInput/AskUserQuestion, common tool_use_id/agent_id). Pi installed extension docs describe explicit shared `pi.events` integration and lifecycle cleanup; event buses are per process, not cross-process.

Automated coverage includes real Unix socket -> HTTP pending/SSE -> HTTP response -> exact callback with mocked Herdr; two forwarded child requests with independent answers; invalid/repeated/read-only answers; identity changes, owner cancellation/disconnect; broker timeout; active socket ownership; and settings migration/install/uninstall preserving unrelated hooks. Claude adapter fixtures validate question/multi-select answers, permission decisions and plan denial.

### Live evidence (2026-11-07)

A separate relay on loopback port 18787 with temporary private state was used. Personal Pi/Claude settings and production relay remained unchanged. Test adapters were loaded explicitly into test-owned Herdr panes.

- **Pi 1.4.0:** a disposable command extension forwarded two concurrent permission requests with different child execution IDs. HTTP answered one allow and one deny. The original Pi extension's callbacks wrote exactly the corresponding two results. No model request was needed. This demonstrates explicit parent forwarding inside a real Pi process, not universal workflow support or actual separate child-process integration.
- The Pi first live attempt exposed a startup handshake race; adapter reconnect was added and verified after reload. An initial test fixture incorrectly used Bun inside Node-based Pi; it was corrected to Node file APIs. Pending approvals are never replayed across reconnects.
- **Claude Code 2.1.319:** a real AskUserQuestion tool call emitted an elicitation with its tool_use_id. HTTP supplied `Blue`; the native tool result recorded that answer and the agent replied `Blue`.
- **Claude PermissionRequest:** a harmless Python print command reached the native permission hook. HTTP denied it; the transcript recorded `Remote user declined` as the tool error and the agent replied `DENIED`. An earlier `printf` probe did not require permission, so no event was expected/claimed from that probe.
- Both test-owned panes closed and the test relay stopped. Production remained `1.0.14+29b27e2`.

Live plan-mode approval, permission allow execution, arbitrary Pi UI interception, separate child-process forwarding, macOS and tailnet authorization are not claimed as live coverage. Claude native child-session identities different from the Herdr parent are intentionally rejected. Installation files reference the installed checkout; keep it available and migrate explicit settings before switching a running deployment.
