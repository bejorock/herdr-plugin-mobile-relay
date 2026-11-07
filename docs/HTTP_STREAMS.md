# HTTP transcript and Herdr event increment

Implemented on `lean-relay` (2.0.2). Automated and native-read/event evidence is recorded below. No ACP. Terminal WebSocket `/api/live` remains separate.

All endpoints use existing read authorization and runtime isolation. No GET launches/resumes an agent or submits a prompt. Application credentials are not accepted in query strings.

## Transcript history

`GET /api/conversations/{id}/transcript?cursor=<opaque>&limit=100&session=<runtime>` returns `{conversationId,kind,records,nextCursor,hasMore}`. Limit 1–200, default 100. `cursor` is a position after returned records; omit to start at retained history. An empty tail page still carries a cursor for following. Explicit runtime mismatch fails. Closed conversations remain readable if their native transcript survives; a missing runtime does not authorize another runtime's data.

Pi returns the active ancestry branch's native message records. Claude returns top-level user/assistant records, excluding sidechains, API request blobs and other internal context/config records. Tool calls and results remain native content; clients own rendering. Top-level record/session/filesystem metadata is not passed through wholesale. Record identity and content are projected into a small harness-labelled envelope. Private native session references and relay upload paths are redacted; known credential/config keys are suppressed in structured payloads. Arbitrary prose/tool output can itself contain sensitive material: authorized transcript access is sensitive access, not a promise of general secret detection.

Only complete newline-terminated JSONL records are exposed. Malformed complete records fail clearly rather than silently shifting cursor positions. Safe existing adapter file/root/size guards apply; native session/cwd evidence must match the saved binding. Default native storage roots only. Bound input to 8 MiB/20,000 records and response batches to 512 KiB; individual oversized records fail explicitly rather than silently truncating tool arguments. Prefix-bound cursors are scoped to conversation/harness/projected history. Appends retain validity; replacement/truncation/branch changes that alter the prefix return 409 `transcript_reset` and require starting again. No history replay triggers interactions.

## Transcript follow

`GET /api/conversations/{id}/transcript/stream?cursor=<opaque>&session=<runtime>` is SSE. A valid `Last-Event-ID` can supply the transcript cursor when query cursor is absent. Initially deliver retained records from requested position, then poll for appended durable records (not token deltas). Events:

- `transcript.records`: same batch envelope as history; SSE `id` is the new cursor.
- `transcript.reset`: invalidate local retained history, clear cursor and follow from retained start.
- `stream.error`: sanitized `{code,message}`, then disconnect.

No cursor means history from start. Batches are authoritative native records, not UI widgets. Heartbeat comments every 15 seconds; connections are bounded, slow readers disconnected, maximum stream lifetime five minutes (reconnect with cursor). Resume cursors across reconnects, not terminal seq numbers. Initial missing/invalid transcript fails HTTP before SSE starts. Follow failures after headers use `stream.error`. This first implementation uses bounded whole-file reads with a short shared cache, not unbounded reads or an incremental file parser; large sessions above the cap are explicitly unsupported.

## Herdr events

`GET /api/events?session=<runtime>` is SSE, for actual Herdr event names/data from the relay's subscribed subset. Events:

- `herdr.event`: `{session,event,data}`; safe top-level projection of public runtime fields, not raw private `agent_session` references.
- `source.status`: `{session,live}` for upstream subscription health.
- `resync.required`: `{session,reason}`; fetch `/api/snapshot`. Sent on initial subscribe, upstream reconnect/gap/subscription changes and when the relay cannot replay a requested event position.

Native event names are preserved (for Herdr 0.9.5, observed names include `tab_created` and `pane_created`, while subscription type names use dots). Do not assume they equal subscription type strings.

A bounded per-runtime in-memory relay ring supports `Last-Event-ID` reconnect during one process lifetime. It is NOT durable Herdr history, does not recover events before upstream subscription and has no shared sequence boundary with snapshots. Treat events as invalidations for authoritative reads. Runtime name never becomes a filesystem path. No arbitrary event-name subscription supplied by clients in this increment; the supported subset follows EventPoker lifecycle and agent-status subscriptions. No actionable question/permission events are emitted yet.

HTTP/SSE caps and sanitized errors are documented in OpenAPI. Multiple streams are bounded globally and per resource; resource release occurs on request abort, client cancellation, duration timeout or server shutdown. Read-only clients may observe, never mutate.

## Validation evidence (2026-11-07)

Automated tests cover native tool content, privacy projection, filtering, partial writes, pagination/cursors, prefix/branch/truncation resets, malformed data, read caching, event forwarding, relay-ring replay/gaps, HTTP route behavior, subscriber cancellation, queue and connection caps.

A separate loopback relay read the two saved real Pi/Claude conversations from the lifecycle validation journal. Each HTTP history returned exactly four native conversation messages (user/assistant/user/assistant), excluding Claude's internal API-request blobs. SSE follow from the returned tail cursor yielded an empty initial batch without duplicate history. Native session references did not appear in returned records.

A disposable Herdr shell tab emitted actual upstream `tab_created` and `pane_created` payloads through `/api/events`; the test closed only its own pane. An initial assertion expected dotted event names and was corrected after inspecting actual native names; the relay preserves the native names, not an invented normalization. Test relay stopped, production remained build `1.0.14+29b27e2`. No model calls or agent-settings changes were made for these checks.

Live token/append streaming, filesystem rotation during a native run, tailnet/browser streaming and native hooks/interactions are not claimed as live coverage here. Folder APIs remain a separate pending increment.
