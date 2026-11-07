# HTTP lifecycle native validation

Date: 2026-11-07. Source tested: `a0c3607` on `lean-relay`, version `2.0.1`.

## Environment and isolation

- Herdr 0.9.5; Pi 1.4.0; Claude Code 2.1.319; Bun 1.4.4.
- Separate Bun relay bound to `127.0.0.1:18787`, temporary owner-only state, same local Herdr runtime as the running service.
- Production relay on port 8787 was not restarted; it remained build `1.0.14+29b27e2`.
- No agent settings/hooks were modified. Existing installed Herdr/native integrations remained in place.
- Test-owned tabs/panes were created in the repository workspace. Only test-owned panes were closed. No native transcripts were deleted.

These were real HTTP requests backed by real Herdr socket operations and real interactive Pi/Claude processes, not mocked lifecycle tests.

## Results

| Case | Pi | Claude |
| --- | --- | --- |
| HTTP create returns stable persisted ID before first prompt | Pass | Pass |
| Repeat same create/request ID returns original conversation/pane | Pass | Pass |
| Live HTTP resume reuses existing agent | Pass | Pass |
| Restart test relay with agent alive, then resume | Pass | Pass |
| Close pane, then issue three simultaneous HTTP resume requests | Pass: one replacement pane | Pass: one replacement pane |
| Replacement reports original native reference and original public ID | Pass | Pass |
| Native conversation remembers prior token after pane recovery | Pass | Pass |
| Agent exit while shell pane remains, then HTTP restore | Pass | Pass |
| Cwd mismatch | 400 `cwd_mismatch` | 400 `cwd_mismatch` |
| Missing native transcript | 404 `native_session_missing`, no new pane | 404 `native_session_missing`, no new pane |
| Transcript user-message count shows no automatic prompt replay | Pass | Pass |
| Closed conversation read does not relaunch | Pass | Pass |

Additional real HTTP checks: unknown runtime returned 404 `runtime_unknown`; unknown conversation returned 404 `conversation_unknown`; reused request ID with different cwd returned 409 `request_id_conflict`.

## Conversation continuation proof

For each harness, one explicit prompt supplied a unique disposable token and requested a token-only response, with no tools or file changes. After pane closure and native HTTP restoration, a second explicit prompt asked for the previously supplied token without including it. Both agents returned the correct original token in their native transcripts.

The restored Pi session path and Claude UUID matched the saved private references. Thus the check demonstrated native context continuation, not merely the ability to display old transcript text.

Each native conversation had exactly two top-level user conversation messages: the seed and recall requests. No tools were requested. Lifecycle operations themselves submitted no prompts. Claude also stored an `api-request-blob` containing a user-shaped message; it is not a top-level user conversation record and was excluded from this count. Transcript adapters must preserve that distinction in the future.

Prompts used the existing Herdr semantic prompt CLI because this increment does not yet expose the new semantic-prompt HTTP route. Creation/read/resume used the HTTP endpoints being validated.

## Failure simulation and cleanup

After closing each live test agent pane, the test temporarily renamed only that test conversation's native transcript. Resume failed with `native_session_missing` and the pane-ID inventory remained unchanged. A `finally` step restored each filename. Native conversations and transcript contents were preserved.

Agent-only exit used Pi Ctrl+D and Claude `/exit`. The shell panes remained until explicit cleanup; subsequent resume created fresh panes while retaining conversation identity. Test relay process was terminated normally and verified stopped. All test-created panes (including shells left after agent exit) were closed. Temporary private test journal/logs were retained locally as evidence, not committed.

## Remaining limits — not claimed as live coverage

- Discovery returned `unknown` for both agents because Herdr reported installed integrations, which alone are not strict executable evidence. Both executables did launch, but that does not complete environment-aware discovery implementation.
- Lost native launch acknowledgements and relay crashes during mutation are covered by automated mocked tests, not fault-injected real Herdr failures in this run.
- Restart tested the relay only, not a Herdr server restart or machine reboot.
- A process that exits but leaves stale native status may still conservatively return `restore_pending`; ordinary exits tested here cleared correctly.
- No native permission/question, workflow/subagent, public transcript/SSE, attach-existing, custom-config-root or folder API validation is claimed. Those implementations remain pending.
- No tailnet/browser authorization or macOS validation was performed in this run; existing automated security/launcher tests remain separate evidence.
