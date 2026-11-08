# HTTP lifecycle — first increment contract

**Transport update:** HTTP/SSE now runs on an owner-private Unix socket via SSH; generic filesystem operations use SFTP. See [SSH transport](SSH_TRANSPORT.md). Old TCP/Tailscale/device-policy references in historical evidence are not current authorization.
Status: implemented first-increment contract for discovery and native conversation creation/restoration on `lean-relay`. [Live Pi/Claude HTTP validation](HTTP_LIFECYCLE_LIVE_VALIDATION.md) covers ordinary create/restart/exit/pane-close restoration and native context recall; fault-injected launch ambiguity remains automated mocked coverage. No ACP methods or envelopes. Transcript/event/interaction and folder endpoints are separate increments.

All routes use owner socket authority and Host/Origin/native-client request-shape checks. `?session=<name>` selects a discovered Herdr runtime; omitted selects primary. Unknown runtime: 404 `runtime_unknown`; unreachable: 503 `runtime_unavailable`. Errors use `{ "error": { "code": "machine_code", "message": "bounded explanation" } }` without native IDs/paths or raw backend errors.

## Discovery

`GET /api/agent-kinds` returns `{session, agents:[{kind,availability,version,reason}]}` for Pi and Claude. Uses Herdr `integration.list`, never starts processes or invokes a model. `available` only when executable evidence is sufficient; installed integration alone is `unknown`/`launchability_unverified`. Herdr metadata cannot always distinguish an installed hook from an executable: do not interpret `unknown` as absent. CLI versions remain null when not detected; integration versions are not CLI versions. Discovery is advisory; launch is revalidated by Herdr.

## Create

`POST /api/conversations` body `{kind:"pi"|"claude",cwd:"/absolute/path",requestId:"unique-id"}`. Requires write authorization. `requestId` is mandatory (1–128 ASCII letters/digits/`.`/`_`/`:`/`-`), scoped to runtime. Reusing it with different kind/canonical cwd is 409 `request_id_conflict`. Private persisted deduplication lasts as long as the conversation record. Same request after restart returns the same record, not another agent. An interrupted initial launch with no saved native identity fails `create_pending` and requires operator inspection: a pane occupant alone cannot prove the original conversation.

Return 201 `{conversation:{id,session,kind,cwd,paneId,status}}`. `id` is an opaque durable conversation reference, unrelated to a replaceable pane. Native ID/transcript references remain private. Exact cwd is validated/canonicalized to an accessible directory; no folder is implicitly created. Reuse exact-root Herdr workspace or create workspace, create a fresh pane/tab, start explicit harness, verify interactive readiness/native identity, then persist before success. No synthetic prompt.

An unprompted native session may have no transcript. Its identity is persisted, but after exit it fails `native_session_missing` unless native conversation data was created independently. The relay never prompts solely to force persistence.

## Read and restore

`GET /api/conversations/{id}` returns `{conversation}` (read authorization). Reports current matching attachment or `closed`/`unavailable`/`starting`; does not launch. Native identity is reconciled from a fresh Herdr read, not just a cached pane ID. Unknown conversation: 404 `conversation_unknown`.

`POST /api/conversations/{id}/resume` body `{cwd:"/same/canonical/path"}` requires write authorization. Return 200 `{conversation}`. Use saved runtime; explicit `?session=` mismatch is 400 `runtime_mismatch`. Reject different cwd: 400 `cwd_mismatch`. Reuse exact matching live native agent regardless of pane change; ambiguous multiple matches fail 409 `native_session_ambiguous`. Otherwise validate private native transcript, launch via Herdr with relay-derived `pi --session <path>` or `claude --resume <id>`, prove same native reference, persist new pane without changing conversation ID. No prompts, history injection or tool execution by the relay.

Concurrent same-conversation requests share one operation. Persist intended replacement pane before native start; an uncertain restoration is reconciled against the saved native identity on retry. Initial creation with no persisted native reference is not adopted by pane ID alone. Do not create another replacement while the previous launch is unresolved. Failure can leave a shell/failed-start pane for explicit inspection; do not automatically destroy potentially useful work.

Other errors: 400 `invalid_request`/`invalid_cwd`, 409 `create_pending`/`restore_pending`/`native_identity_mismatch`, 404 `native_session_missing`, 503 `discovery_unavailable`, 502 `create_failed`/`restore_failed`, 500 `persistence_failed`. Missing native data never falls back to fresh creation. Authentication/quota failures may initially be reported as sanitized launch failures; exact classification requires trustworthy native evidence.

## Limits and retention

Initial increment does not accept arbitrary CLI args, MCP configuration, credentials, historical ACP IDs or client-supplied native references. It does not add another prompt API: use existing Herdr-facing operations until the semantic prompt route is specified. No auto-restore during reads. Restoring a conversation does not reestablish expired callbacks. Transcript replay is separate, not part of the resume response.

Private state uses owner-only permissions and atomic replacement. Persistence errors propagate. Records/dedupe keys survive ordinary pane closure and relay restart; no automatic expiry or public deletion in this increment. Operators must stop the relay before editing/removing the private store; removal discards restore/dedupe mappings, not native transcripts. Bound record count and reject new creates at capacity, never evict active recovery handles silently.

## Remaining gaps

No attach-existing endpoint yet. Harness availability backed only by installed-hook evidence remains `unknown`; exact launcher verification in Herdr's environment is not implemented. Initial launch interruptions before native identity was persisted require operator intervention rather than automatic adoption by pane ID. No automatic retry of unresolved launch allocations. Native transcript validation currently assumes default Pi/Claude storage roots and requires matching saved cwd evidence; custom agent config roots need explicit support. Agent exit with stale native metadata/not-ready status may conservatively return `restore_pending` instead of launching. Those limits require live investigation, not weakening identity checks.

## Evidence required

Automated tests distinguish mocked Herdr/adapter behavior from live native tests. Both harnesses require native create/live resume/restart/exit/pane-close proof, missing data/cwd mismatch, concurrent and ambiguous-retry coverage before claiming full native validation. No deployment/restart of the existing service is implicit in this implementation.
