# HTTP attach, prompt and discovery completion

Implemented on `lean-relay` (3.0.1). Transport remains private Unix HTTP; SSH/SFTP are client concerns.

## Attach an existing native agent

`POST /api/conversations/attach?session=<runtime>` body `{paneId,kind:"pi"|"claude",cwd:"/absolute/path"}`. Resolve a fresh Herdr agent/native reference; require explicit kind/canonical cwd to match, usable live agent and exact native identity. Persist and return 200 `{conversation}`. Repeated attachment to the same native conversation returns the same public ID even after pane changes or relay restart. No new workspace/process/prompt. Missing/busy/native-less/mismatched agents fail with machine-readable errors. Never accept client-supplied native ID/path/CLI args. Hook attachment uses the same native mapping.

## Semantic prompts

`POST /api/conversations/{id}/prompt` body `{text,requestId}`. Native marker/browser gate applies. Text nonempty, <=128 KiB UTF-8; requestId same bounded format as creation. Resolve and validate a fresh exact native attachment, then call Herdr `agent.prompt`, not raw terminal typing. No auto-resume. Serialize with same-conversation resume and prompt operations; unrelated conversations can progress independently. Blocked/not-ready agents fail before delivery when authoritative Herdr validation reports that.

Return 200 `{ok:true,conversationId,requestId,delivered:true,completion:"unknown"}` after Herdr confirms submission to terminal input. This is not transcript insertion proof, model response or completed execution. Follow transcripts/Herdr events for actual progress. No stopReason or ACP envelopes.

Persist a bounded private prompt journal **before delivery**, containing conversation/request ID, text fingerprint and status, not prompt text. Same ID+fingerprint returns cached success/failure, including after restart. Different text is 409 `request_id_conflict`. A request interrupted after reservation is 409 `prompt_delivery_unconfirmed` on retry and must not be resent automatically. Transport loss after write and native post-delivery identity mismatch are ambiguous, never blind retries. Definitive pre-delivery Herdr `agent_blocked`/`agent_not_ready`/`agent_not_found` are sanitized clear failures; other backend failures remain ambiguous. Journal persistence failure never authorizes another delivery. Journal capacity 10,000, no silent eviction; no public deletion yet.

## Discovery evidence

Keep `GET /api/agent-kinds`. Query Herdr `integration.list` first. Additionally, a fresh Herdr live-agent/native report proves that harness is running/available; no conversation is launched for discovery.

Optional `HERDR_RELAY_AGENT_PATH` is an **owner-attested PATH matching the intended Herdr shell launch environment**, not the daemon PATH and not an override of native launch. When configured, inspect fixed `pi`/`claude` executable names in those absolute directories using file/access checks; do not run binaries, models, shell startup profiles or version commands. Recheck each request. Do not return PATH/executable locations. Invalid/relative entries fail config validation. This resolves installed-hook ambiguity only where the owner supplies trustworthy launch-path evidence; without it and without live agent evidence, report `unknown/launchability_unverified` honestly. Herdr launches agents through interactive pane shells; its process PATH or an arbitrary relay login shell is not universal authoritative evidence. Aliases/functions/container environments may remain unknown and actual launch always revalidates.

CLI version remains null in this increment. Discovery must not create panes, shell probes, paid activity or change files/settings. Unknown/unreachable runtimes fail explicitly, not fallback to primary. Automated tests for configured PATH/running evidence are not a claim of automatic environment introspection on every host.

## Platform/evidence

Owner Unix socket/Node filesystem operations target Linux and macOS; native storage roots remain defaults unless adapters gain explicit configuration. Validate on actual macOS before claiming platform acceptance. No SSH/SFTP client implementation or client integration acceptance is required from this relay.

### Live validation (2026-11-09)

An isolated real Unix-socket relay attached two independently Herdr-launched agents (Pi and Claude). Repeated HTTP attach returned the same public IDs without launching anything. Each received one short explicit no-tools token prompt via the new HTTP semantic prompt operation; both acknowledged delivery and their native transcripts contained the expected assistant token. Repeated same-ID prompts produced only one top-level user message per agent. After test relay restart, attachment IDs remained unchanged and persisted prompt retries returned success without sending more messages. Fresh running-agent discovery reported both available even with no configured launcher PATH; a separate initial request also exercised owner-attested PATH. Test-owned panes closed and test relay stopped. Production remained `1.0.14+29b27e2`, personal agent settings unchanged.

Automated mocked-Herdr tests additionally cover concurrency, kind/cwd mismatch, missing/closed agents, idempotency across restart, private prompt-text exclusion from journal, blocked rejection, ambiguous transport delivery with no resend, configured-PATH both/one/neither discovery and runtime failure. Real lost-acknowledgement injection and macOS execution are not claimed. Native record insertion/completion still requires transcript/state observation; HTTP prompt success is explicitly submission acknowledgement only.
