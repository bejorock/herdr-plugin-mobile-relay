# Lean Herdr Relay Revamp

**Status:** agreed architectural direction; implementation plan, not a description of shipped APIs.

**Baseline:** `lean-relay`, pruning commit `d1916ef` (package version `2.0.0`). The former ACP/Collie implementation is preserved by branch `archive/acp-collie-v1.0.14`, tag `archive-acp-collie-v1.0.14`, and release tag `v1.0.14`.

This document supersedes the earlier ACP-centric direction. [Architecture](ARCHITECTURE.md) describes the active baseline; [OpenAPI](openapi.json) describes existing HTTP operations. Proposed capabilities here must not be treated as existing endpoints.

## Implementation tracking

The first HTTP discovery/create/read/resume increment is implemented after the pruning baseline; [HTTP lifecycle](HTTP_LIFECYCLE.md) documents its exact behavior and remaining limitations. Ordinary Pi/Claude HTTP lifecycle and native context continuation are now [live-validated](HTTP_LIFECYCLE_LIVE_VALIDATION.md). HTTP transcript history/following and selected Herdr events are implemented; see [HTTP streams](HTTP_STREAMS.md). The first native interaction/adapter increment is implemented with explicit installation and [documented evidence](HTTP_INTERACTIONS.md). Owner-configured Linux folder operations are implemented with [documented limits/evidence](HTTP_DIRECTORIES.md). Fault-injected native failures, public attach-existing, reliable executable verification when hooks are installed and macOS folder operations remain incomplete; arbitrary nested-extension interception is not supported. The requirements below describe the complete target, not a claim those remaining features exist.

## 1. Goal and principles

Expose Herdr remotely so clients can build agent development environments, and expose Pi/Claude conversation data so clients can provide a native experience rather than requiring conversation through a terminal.

- Simplicity first: one public operation for each responsibility, not overlapping lifecycle APIs.
- Herdr owns process execution and terminal/workspace management. Reuse its API instead of duplicating its runtime.
- HTTP is the public interface for management, transcript access, events and interaction responses. SSE is an HTTP delivery mechanism, not another agent protocol.
- Retain the optional terminal WebSocket because terminal display has a different purpose from native conversation display.
- Clients own rendering, including tool calls, questions, permissions and how events relate to transcript entries.
- No ACP, replacement agent protocol, relay-owned UI model, or required bundled application.
- Different internal sources are acceptable; do not expose redundant public command paths for the same action.

## 2. Responsibility boundaries

| Owner | Responsibility |
| --- | --- |
| Herdr | Runtimes, workspaces, tabs, panes, agent launch/prompt operations, terminal data and reported lifecycle/status |
| Relay Herdr layer | Authenticated remote access to selected Herdr operations and events; bounded requests and safe mutation handling |
| Relay Pi/Claude adapters | Resolve native identity/transcripts; read/follow records; register real pending interactions and route responses |
| Client | Agent-development UI, transcript/tool rendering, terminal rendering if wanted, interaction presentation/correlation, application permissions and notifications |
| Workflow/extension | Forward internal questions explicitly and deliver answers to the original waiting operation |

Starting/prompting an agent remains backed by Herdr. The HTTP surface must provide one supported creation path and one conversation-restoration operation, without adding competing launch paths with different semantics. Native restoration is a retained requirement, not an optional consequence of removing ACP: it uses Herdr to launch the exact saved native conversation. Transcript reads never launch processes.

A thin relay is not an unrestricted raw socket proxy. Dangerous methods still require deliberate exposure and authorization. Not every Herdr operation must be exposed in the first increment.

## 3. What remains and what was removed

### Retained active capabilities

- Herdr snapshots and discovered named-runtime selection.
- Existing workspace/tab/pane/worktree operations and workspace file/Git inspection.
- Terminal input, bounded uploads and `/api/live` terminal observation.
- Loopback/Tailscale identity gates, optional device write authorization, audits, mutation serialization and retry safeguards.
- Service lifecycle tooling for Linux/macOS.

### Removed application/protocol features

- ACP endpoint, negotiation, SDK and ACP lifecycle dispatcher.
- Collie/PWA frontend, service worker and bundled developer portal.
- Browser Web Push, subscription delivery, notification grouping, snooze and notification preferences.
- Background release-check and update-alert product behavior. Explicit service/plugin update tooling remains.

Clients may build notifications from Herdr events. That does not require a push-notification service in the relay. Third-party license attribution remains even though product features were removed.

## 4. Separate data channels

### Terminal channel

`/api/live` remains an optional WebSocket for actual pane terminal frames and controls. A terminal client uses a terminal emulator to interpret those frames.

Terminal frames are **not transcripts** and must not be parsed into the canonical native chat history. Current snapshot invalidations on this channel are not a complete raw Herdr event stream.

### Transcript channel

Provide HTTP history reads and incremental following, with SSE suitable for live delivery. This channel exposes recorded native messages, tool calls, arguments and results for client rendering.

- Preserve harness-specific content in a bounded envelope; do not translate it into prescribed UI cards.
- Include harness, conversation identity and suitable record/cursor information.
- Handle incomplete appends, truncation/replacement, reconnection, and Pi active-branch changes explicitly.
- Keep host transcript paths and private upload paths out of public metadata. Define sanitization before exposing raw record payloads; raw transcripts are not safe to serve without review.
- No live token-delta hook stream is required initially; following durable records is the initial target.
- Transcript replay does not emit actionable requests or rerun tools/prompts.

### Herdr/actionable-event channel

Provide HTTP event consumption, with SSE suitable for subscriptions. Herdr lifecycle/status and live actionable requests may share an event endpoint with distinct event types and filters.

Transcript and actionable-event channels remain separate by design. Clients are allowed to consume both and decide whether/how to associate them. The relay does not merge them into a conversation presentation model.

Herdr events describe runtime activity; native interaction events describe actual waiting requests. Preserve source provenance and do not claim relay event history is durable Herdr history. On event loss/reconnect, expose an explicit resynchronization path rather than silently assuming no events were missed.

## 5. Actionable request semantics

An actionable event means an integrated hook/extension has registered a current request with a real response path. A tool name in a transcript is not sufficient evidence.

Example sequence:

1. Native tool `AskUserQuestion` is recorded in the transcript.
2. The native hook registers a pending interaction and the relay emits a request event.
3. Client developers decide whether to attach controls to the transcript tool call, show a dialog or use another presentation.
4. An authorized client submits a response using the interaction ID.
5. The relay validates and returns it to the registered native requester; resolution/expiry is observable.

For questions absent from the transcript, the actionable event must contain enough bounded request data to present and answer it independently.

The contract needs:

- Conversation identity, unique interaction ID, request kind and bounded content.
- Allowed decisions or response schema, and expiry/current status.
- Tool-call ID and parent/workflow/execution context when reliably available; omit unavailable correlation rather than matching question text.
- First valid authorized response wins; invalid responses do not consume requests.
- Late, duplicate or unknown responses have clear outcomes; they never trigger another operation.
- A pending-request HTTP read for reconnect recovery. Missing the original event must not make a live wait undiscoverable.
- Owner disconnect/timeout and relay shutdown resolve safely, without implicitly approving anything.
- Authorization and audit at the HTTP boundary; observers do not gain response authority.

Use callback/hook responses for structured waits. Explicit terminal input remains available, but the relay must not guess keystrokes to answer an internal question or type into a parent pane on behalf of a child.

## 6. Identities and persistence

Keep these separate:

| Identity | Meaning |
| --- | --- |
| Herdr runtime name | Selected Herdr server/socket registry entry |
| Workspace/tab/pane IDs | Herdr organization and current process location |
| Native conversation reference | Pi transcript/session reference or Claude native session UUID |
| Public conversation reference | Client-safe stable mapping to the native conversation |
| Interaction ID | One live pending question/permission |
| Optional execution/parent ID | Provenance for integrated nested work |

Persist private native mappings without exposing transcript paths or credentials. Revalidate the current attachment against Herdr/native identity before reads that depend on it or follow-up writes. Never trust a reused pane ID alone.

The retained `agentBindingIdFor()` includes a pane ID and is only a live/private binding foundation, not the final durable conversation identifier. The retained store is inactive and currently swallows write failures; correct those semantics before promising durable identity. Do not require an existing transcript at the moment a native conversation is first reported if the harness has not created it yet; specify this state explicitly.

Reading history and responding to an interaction are different permissions/operations. Responses require an extant matching native wait, not merely a known conversation ID. Existing ACP IDs/data are not automatically migrated or erased. Retention, deletion and any migration need explicit documentation.

## 7. Injected integration changes

### Keep Herdr's own integrations

Herdr-owned `herdr-agent-state.ts` and `herdr-agent-state.sh` report lifecycle/native session references. Do not remove, replace or duplicate their authority.

### Pi relay integration

Adapt the old relay extension, independently of ACP:

- Retain explicit inter-extension permission/question request and response forwarding.
- Initially remove redundant status, token and tool streaming from this bridge; use Herdr events and transcript records for those purposes.
- Preserve exact native/session binding and bounded local socket framing.
- Scope/reconcile pending requests on session changes, disconnects and shutdown.
- Do not claim interception of every Pi extension UI dialog. An extension must use the bridge or an explicitly supported adapter.

### Claude relay integration

Adapt the old native hooks, independently of ACP:

- Retain supported permission, question and plan-approval request/response paths.
- Replace ACP-shaped response envelopes with the small internal response contract.
- Preserve native tool-call IDs where supplied by the hook input.
- Correct EOF/disconnect handling and bound waiting, buffering and failure behavior.
- Verify hook event names and output contracts against the supported installed CLI version before claiming support.
- Avoid retaining observability hooks solely to duplicate Herdr status or durable transcript data.

The local installed relay-owned files still use names `herdr-relay-acp.ts` and `herdr-relay-acp.sh`; the pruning commit did not modify user settings. Reintroduce a safe, targeted installation/migration path with backups and preservation of unrelated hooks. Local machine inspection is evidence about this host, not a universal installation state.

## 8. Workflow/subagent questions

Initial supported mechanism: **explicit parent forwarding**.

```text
child/workflow waits
  → owning parent integration forwards a uniquely identified request
  → relay publishes actionable event
  → authorized client responds
  → parent integration returns answer to the original child wait
```

This works without a child transcript entry. The relay routes requests; it does not schedule or interpret the workflow.

A separate child process does not share the parent's Pi event bus automatically. A child with a different native session cannot impersonate the parent under the existing exact pane/session handshake. Direct child adapters, if needed later, require an explicit authenticated ownership model; do not weaken binding checks to accommodate them.

Test simultaneous requests from different children. Conversation ID alone cannot identify the correct wait. Include cancellation when the owning task exits; never redirect an answer to a replacement task.

## 9. Retained discovery, creation, restoration and folder requirements

Changing transport removes ACP, not the product requirements previously called RELAY-01/02/03. Their behavior must be expressed through the HTTP-first approach. This section defines required behavior; endpoint names and exact schemas still require approval.

### Installed harness discovery (former RELAY-02)

Expose installed/launchable Pi and Claude for the selected runtime, even with no running agent. Reuse `integration.list` and other authoritative Herdr metadata before adding independent executable probing. Distinguish supported harness, installed integration and launchable executable. Herdr integration availability can include installed-hook evidence; manifest/integration versions are not CLI versions.

Return `available`, `unavailable` or `unknown`, with bounded machine-readable reasons and optional safely detected CLI version. Inspect the Herdr launch environment rather than only the Bun service PATH. No agent conversation, model prompt, interactive login or filesystem modification for discovery. Authentication/quota/MCP readiness is outside installed-agent discovery. Unknown runtime must fail explicitly; unreachable runtime must not be reported as every agent missing. Bound probes and revalidate at actual launch.

### Create a native conversation

A write-authorized HTTP creation request selects an explicit supported harness, absolute cwd and Herdr runtime. Herdr creates/reuses the appropriate terminal organization and starts the harness. Return a stable client-safe conversation reference once native identity and private binding persistence are established; do not claim startup from an early acknowledgement alone. Workspace/tab management remains separate and does not itself create a conversation.

Persist logical identity when creation succeeds, not only after the first prompt. Account explicitly for a native session whose transcript has not yet been created. If the harness cannot preserve an unprompted conversation, record/document that state and fail missing restoration clearly; never send a synthetic prompt to make it durable. Attachments to existing discovered conversations must also establish persistent mappings.

Use native Herdr launch/prompt primitives internally. Select one public agent-creation contract before implementation; do not expose both a high-level create and an equivalent alternative launch flow as mandatory client paths. Never require clients to construct native CLI resume arguments.

### Resume the same native conversation (former RELAY-01)

Provide an explicit HTTP resume operation using the saved public conversation reference. It must:

- Reuse the matching live native conversation in the saved runtime, even if its pane changed; validate native identity, not merely pane ID or cwd.
- After agent exit, pane closure or relay restart, launch the exact saved conversation through Herdr using supported native continuation (`pi --session <private path>`, `claude --resume <private UUID>`), then prove native identity and update only the live attachment.
- Preserve the public conversation reference. Keep native UUIDs/paths and restoration arguments private.
- Validate requested cwd against saved cwd, reject mismatches, and preserve required non-secret launch configuration.
- Serialize concurrent restoration and reconcile ambiguous/lost launch responses before retry so the same conversation is not launched twice. Do not interrupt unrelated/busy agents.
- Never submit/rerun prompts, replay tool operations or substitute a fresh conversation during restoration. History retrieval is separate; reading transcript history never triggers restoration.
- Fail clearly for unknown conversation, missing native data, unavailable harness/runtime, unsupported restore and identity-proof failure, using documented HTTP status and machine-readable error codes. ACP JSON-RPC error numbers no longer apply.
- Retain mappings after ordinary pane closure and document retention/deletion. Persistence failure must not be acknowledged as durable success.

History and pending-interaction reads allow clients to synchronize after resume. Restoring an exited conversation does not resurrect expired permissions or old callbacks. Opaque IDs whose mappings were already lost need not become recoverable retroactively. Migration of archived ACP mappings, if desired, must be explicit rather than implied by shared storage.

### Folder selection/creation (former RELAY-03)

Retain the requirement to browse allowed roots/immediate directories, validate manual absolute paths and explicitly create one child folder. It is sequenced after core creation/restoration, not silently dropped. Existing workspace/tab APIs accept cwd; a filesystem folder is not the same resource as a Herdr workspace, and general host directory operations were not found in the inspected Herdr API.

Specify owner-configured roots, canonical path/symlink containment, bounded stable pagination, launch-identity accessibility, write authorization/audit, single-component nonrecursive creation, existing-file conflicts and request-ID retry policy (including relay restart behavior). Browsing/validation must not create Herdr workspaces or modify folders. No generic exec API is required.

All operations must consistently select the same runtime. An unknown runtime is not an instruction to fall back to the primary.

## 10. Implementation increments

1. **Herdr boundary and creation:** installed-harness discovery, selected agent operations, one HTTP creation path and actual Herdr events; retain terminal behavior/security.
2. **Identity, restoration and transcripts:** durable native mappings, explicit HTTP resume with native proof and duplicate-launch safeguards, safe bounded history reads and incremental transcript following for both harnesses. Restoration is part of core delivery.
3. **Interactions:** update both injected integrations and relay together; publish pending requests, expose pending read/response, test native main-agent flows and one parent-forwarded nested workflow.
4. **Folder selection/creation:** deliver the retained folder-picker requirements after core behavior is demonstrated. Other convenience features need separate justification.

Before each increment, specify endpoint names, schemas, filters, cursors, errors and response shapes. Endpoint sketches from discussion are **not approved integration contracts**. Update OpenAPI only for implemented operations; do not publish proposed paths as available.

## 11. Acceptance and evidence

- Discovery covers Pi only, Claude only, both, neither, differing relay/Herdr PATH, timeout and unavailable runtime without creating conversations or invoking a model.
- HTTP creation returns an opaque persisted identity for the explicit harness/cwd/runtime; test unprompted creation and attach-existing semantics, not just first-prompt durability.
- For both native Pi and Claude, prove live resume, relay restart with agent alive, agent exit, pane closure, missing native data, cwd mismatch and concurrent/retried restoration without duplicate launch. Demonstrate native conversation continuation, not only old-text replay.
- Folder operations cover allowed roots, pagination, manual validation, explicit creation/retry, existing-file conflicts, permissions and traversal/symlink escapes; no implicit Herdr workspace creation.
- Herdr management targets the selected runtime; native-client and browser authorization remain fail-closed.
- Terminal streaming still reproduces panes and remains independent of native transcript display.
- Pi and Claude transcripts retain messages/tool parameters/results, handle interrupted writes/reconnects and never leak private path metadata.
- Main-agent native question and permission: receive event, answer once, prove the original waiting operation continues.
- Historical tool calls never become live requests merely through replay.
- Request without transcript: client can receive and answer using event content alone.
- Integrated workflow: two concurrent nested requests reach the correct waiting children, including cancellation and stale-response tests.
- Read-only clients cannot respond; competing valid answers produce exactly one native resolution.
- Event reconnection provides current pending requests and clear resynchronization behavior.
- Native session changes/pane reuse cannot redirect responses or conversation attachments.
- Persistence failures do not acknowledge durable success; missing native data does not silently become a fresh conversation.

Distinguish mocked tests from live Pi/Claude evidence. Do not claim arbitrary extension/subagent coverage from a single bridge fixture.

## 12. Deployment constraints

Keep one Bun process, loopback-only binding and Tailscale Serve (never Funnel). Preserve safe dotenv parsing, private state files and valid absolute unquoted systemd paths. SSE and transcript reads pass the same authorization gates as existing APIs; response operations require write authorization.

Before deploying the lean branch, migrate configuration to `HERDR_RELAY_*` and safely migrate/disable old relay-owned agent hook entries. Do not erase native conversations or unrelated agent configuration. A running process can still be the archived build even while its linked checkout is on `lean-relay`; an accidental restart loads the new source. Deployment is an explicit step, not a side effect of this design document.
