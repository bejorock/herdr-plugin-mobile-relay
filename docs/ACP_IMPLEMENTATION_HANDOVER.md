# ACP Implementation Handover

**Date:** 2026-10-26
**Repository:** `/opt/workspaces/herdr-plugin-mobile-relay`
**Current branch:** `main`
**Purpose:** Resume the hybrid Herdr + ACP relay implementation after conversation compaction without repeating discovery or revisiting settled architecture decisions.

---

## 1. Goal

Herdr Mobile Relay is being extended into a client-agnostic hybrid server:

```text
Existing REST/WebSocket control plane
  → Herdr sessions, workspaces, worktrees, tabs, panes, terminal fallback

Experimental ACP v2 WebSocket `/acp`
  → structured agent sessions, chat history/replay, live updates, prompts,
    cancellation, extension-driven interactions, and selected native Claude hooks
```

The relay remains one Bun server, loopback-only. Tailscale Serve is only the optional private remote proxy; no Funnel/public exposure.

---

## 2. Settled design decisions

### Transport and API split

- ACP uses **WebSocket only**, at `GET /acp`.
- ACP payloads are JSON-RPC 2.0 text frames.
- Existing `/api/*` and `/api/live` remain the Herdr management/raw terminal interface.
- The relay acts as the ACP Agent adapter. Herdr itself is not claimed to speak ACP.
- ACP v2 is currently experimental; pinned dependency is `@agentclientprotocol/sdk@2.0.2`.

### Identity and lifecycle

Keep IDs separate:

```text
Herdr: session name, workspaceId, tabId, paneId
Native agent: kind, native session ID/path
Relay ACP: opaque `herdr_...` session ID
```

Never expose native transcript paths or raw Herdr pane IDs from ACP session listing.

### Session creation

`session/new` requires `_meta["herdr.dev"].agent.kind`; no hidden default agent.

```text
Exact workspace root exists → create a fresh tab/pane there
No exact root → create a Herdr workspace
Then start requested Herdr-supported agent
Then wait for native session mapping
Return opaque ACP session ID
```

### Pi versus Claude

**Pi:**

- Pi is extension-driven.
- Do **not** intercept Pi/global/native permission systems or integrate with the user's optional `pi-permission-system` extension.
- Other Pi extensions deliberately use the `herdr-relay:*` event-bus bridge for remote approval/input.

**Claude:**

- Claude is hook/native-interaction-driven.
- Claude native `PermissionRequest` is intentionally mapped through ACP now.
- Future Claude `AskUserQuestion` and `ExitPlanMode` may be mapped through ACP only after safe request/response behavior is proven.

### Multi-client interaction policy

- Multiple authorized ACP clients may receive a request.
- First valid write-authorized response wins.
- Later responses are ignored/lose the race.

---

## 3. Implemented work

### Existing baseline (pre-ACP)

- Secure Bun relay and static PWA.
- Herdr RPC bridge over Unix socket.
- REST workspace/tab/pane/worktree/file/Git APIs.
- Terminal frames via `/api/live`.
- audit, push, multi-session, security gates, Tailscale-aware lifecycle.

### ACP foundation

Relevant implementation directory:

```text
bridge/acp/
```

Implemented:

- `COLLIE_ACP=on` opt-in configuration; default off.
- ACP WebSocket `/acp` mounted in `bridge/server.ts`.
- strict initialization requirement, frame limit (256 KiB), no JSON-RPC batches.
- `initialize`, `session/list`, `session/resume`, `session/new`, `session/prompt`, `session/cancel`, `session/close`.
- opaque ACP IDs generated from Herdr/native binding without revealing source IDs.
- `herdr.dev` capability/extension namespace.
- new config appears in `GET /api/config` as `acp`.

### Herdr metadata and agent control

- `AgentView.nativeSession` retained internally but explicitly redacted from existing `/api/snapshot` response.
- `bridge/herdr-client.ts` wraps:
  - `agent.get`
  - `agent.start`
  - `agent.prompt`
- ACP provisioner implements exact-root workspace reuse/new workspace, tab creation, start, native-session wait.

### Pi adapter

- Safe JSONL parsing/replay from `~/.pi/agent/sessions`:
  - rejects unsafe path, symlink, non-file, oversized file;
  - active branch only;
  - user/assistant/thought messages replay as ACP updates.
- Live transcript tailer publishes newly appended complete message updates.
- Text prompts invoke Herdr `agent.prompt` then wait for a new matching Pi transcript user entry before acknowledging ACP acceptance.
- Image prompts:
  - text + max four images;
  - PNG/JPEG/WebP/GIF, strict base64, 10 MB decoded each;
  - owner-only server-generated upload files;
  - Pi receives `@absolute-path` references;
  - no host upload path returned to ACP client.
- Cancel sends one Herdr Escape only for working/blocked Pi pane. Completion remains authoritative only when later state changes.

### Pi relay hook and event bridge

Installed via:

```bash
herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay
```

Generated file:

```text
~/.pi/agent/extensions/herdr-relay-acp.ts
```

The bridge keeps a persistent local Unix-socket connection and sends:

```text
binding handshake
running/idle state
assistant text/thought message deltas
tool started/completed/failed
```

It exposes Pi event-bus integration for other extensions:

```text
herdr-relay:publish
herdr-relay:request-permission
herdr-relay:request-elicitation
herdr-relay:interaction-result
```

Detailed API/documentation:

```text
docs/PI_RELAY_HOOK_EVENTS.md
```

Generic interactions are extension-driven. The original extension owns its local action after receiving a remote result.

### Interaction broker

- Private owner-only Unix socket:

```text
<stateDir>/agent-hook.sock (0600)
```

- validates exact Herdr pane/native session binding.
- ACP interaction broker supports permission/elicitation.
- first valid authorized response wins.
- five-minute expiry.
- no authorized client → cancellation back to local hook.
- pending interactions cancel when broker closes.
- structured primitive Pi extension form schemas support: string/number/integer/boolean and string enum.

### Claude adapter

- Safe JSONL replay/tailing under `~/.claude/projects`:
  - user/assistant text only;
  - ignores sidechain messages;
  - rejects unsafe path/symlink/non-file/oversized transcript.
- Proof-based text prompt delivery through Herdr `agent.prompt`, waits for a new Claude transcript user entry.
- Claude image prompts deliberately rejected.
- Explicit Claude hook installer writes:

```text
~/.claude/hooks/herdr-relay-acp.sh
```

and merges relay-owned `SessionStart` + `PermissionRequest` entries into `~/.claude/settings.json` without removing existing Herdr/Moshi/user hooks.

- The generated Claude `PermissionRequest` hook:
  1. sends binding `hello` to relay hook socket;
  2. sends interaction request for current native Claude permission;
  3. waits for ACP response (up to 240 seconds);
  4. emits Claude-native `hookSpecificOutput.decision` allow/deny JSON;
  5. leaves normal Claude flow available if hook cannot complete.

- Claude `AskUserQuestion` is mapped via matcher-scoped `PreToolUse` to ACP `elicitation/create` using bounded `q1`–`q4` single/multi-select option fields. The generated hook validates the winning ACP answer, reconstructs exactly the original `questions` plus documented `answers`, and returns a `PreToolUse` `permissionDecision: "allow"` only then. Any bad/cancelled/expired result intentionally produces no Claude decision, leaving the local terminal interaction intact.

- Claude `ExitPlanMode` is mapped through a matcher-scoped PreToolUse hook. It emits an ACP markdown `plan_update`, requests explicit approval, and returns a native PreToolUse allow with the untouched injected plan input only on approval. All other outcomes retain Claude's terminal-local plan approval.

**Do not claim Claude image prompt or general live semantic hook support yet.**

---

## 4. Documentation

Read these first after compaction:

```text
docs/ACP_IMPLEMENTATION_HANDOVER.md            this document
docs/ACP_HYBRID_RELAY_IMPLEMENTATION_PLAN.md   broad architecture and phased plan
docs/ACP_API.md                                client-facing ACP wire contract
docs/PI_RELAY_HOOK_EVENTS.md                   Pi extension event-bus bridge
README.md                                       installation/config overview
```

---

## 5. Local development environment/status

- Bun is installed at `~/.bun/bin/bun`; prepend it to PATH when using tools/scripts:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

- Herdr is installed/running; socket normally:

```text
~/.config/herdr/herdr.sock
```

- Tailscale is installed but intentionally not configured for this local ACP work.
- The normal local relay was earlier started on port 8787.
- ACP local test relay has been used at port 8788 with:

```bash
COLLIE_ACP=on
COLLIE_PORT=8788
COLLIE_STATE_DIR="$PWD/.local-acp-runtime-state"
bun run bridge/index.ts
```

Temporary runtime state is git-untracked and should be removed when finished.

- Pi hook was installed locally during testing. Newly started Pi sessions load it; existing Pi sessions require restart.
- Claude relay hook was installed locally during testing. Newly started Claude sessions load it; existing Claude sessions require restart.

No live destructive/new agent tests were run: no actual ACP `session/new`, real Pi/Claude prompt, image prompt, or permission approval was sent to a live active agent without explicit user consent.

---

## 6. Validation status

Latest full validation succeeded:

```text
bun run typecheck
bun run test
bun run build:web
```

At last validation:

```text
374 bridge tests passed
33 web tests passed
```

Also check formatting/safety:

```bash
git diff --check
```

Relevant focused test files:

```text
bridge/acp/server.test.ts
bridge/acp/session-registry.test.ts
bridge/acp/pi-transcript.test.ts
bridge/acp/tailer.test.ts
bridge/acp/prompt.test.ts
bridge/acp/cancel.test.ts
bridge/acp/hook.test.ts
bridge/acp/interactions.test.ts
bridge/acp/provision.test.ts
bridge/acp/claude-transcript.test.ts
bridge/launcher.test.ts
```

---

## 7. Current working-tree state

This task has extensive uncommitted work. Do not discard it.

Tracked modified files include:

```text
.env.example
README.md
bridge/config.test.ts
bridge/config.ts
bridge/herdr-client.ts
bridge/index.ts
bridge/launcher.test.ts
bridge/server.test.ts
bridge/server.ts
bridge/state-engine.test.ts
bridge/state-engine.ts
bridge/types.ts
bridge/uploads.ts
bun.lock
herdr-plugin.toml
package.json
scripts/collie-ctl.sh
web/src/lib/types.ts
```

New/untracked project artifacts include:

```text
bridge/acp/
docs/ACP_API.md
docs/ACP_HYBRID_RELAY_IMPLEMENTATION_PLAN.md
docs/PI_RELAY_HOOK_EVENTS.md
docs/ACP_IMPLEMENTATION_HANDOVER.md
scripts/acp-hooks.ts
.pi-workflow/
```

---

## 8. Next recommended work

### Next functional task: remaining live failure-path validation

The core Pi and Claude adapters now have a successful disposable local validation run. Basic ACP audit records now cover session creation, proof-confirmed prompts (character/image counts only), cancellation requests, and interaction request/resolution outcomes. Claude native-ID → transcript-path bindings are now persisted owner-only at `<stateDir>/acp-bindings.json`, restored only when the exact live Herdr pane/native ID matches, and deleted when a connected snapshot proves them stale. Newly provisioned but undiscovered sessions expire after 30 seconds. Relay shutdown deterministically cancels pending interactions before stopping the hook listener. Unit coverage verifies read-only clients cannot resolve, one writable client disconnecting does not cancel an interaction while another remains, malformed elicitation can be followed by valid resolution, and shutdown cancels pending interactions. A local client built with the installed official `@agentclientprotocol/sdk` v2 WebSocket transport successfully initialized and listed sessions after the relay was aligned with required ACP v2 `info` metadata and standard session capability advertisement. Prioritize live explicit decline/cancel/timeout and two-writable-client race validation. The remaining live coverage should include declined/cancelled/timeout interaction paths and multi-client races.

### Claude native interaction implementation notes (completed, live test still pending)

- It uses an exact `PreToolUse` matcher for `AskUserQuestion`, not generic `PermissionRequest`.
- It uses internal `q1`–`q4` schema keys and never lets ACP replace native question/options content.
- It accepts documented selected labels only; free text/Other behavior is intentionally not claimed.
- Multi-select option labels containing commas are rejected to avoid ambiguity in Claude's documented comma-joined native answers.
- The interaction broker validates elicitation responses before settlement, so first **valid** authorized response wins.
- The persistent Pi hook socket disables its five-second handshake timeout only after a verified `hello_ack`; pre-handshake bridge events are bounded and queued until that acknowledgement, preventing a first-request startup race.
- The native hook waits 240 seconds, while question broker timeout is 225 seconds to avoid stale response acceptance.
- Disposable live Pi and Claude sessions were validated on 2026-10-27 after explicit workspace-trust approval. Pi ran with `deepseek-flash` (the inherited Qwen test model was unavailable); ACP Pi replay, proof-based text prompt, proof-based PNG image prompt, and explicit event-bus permission plus bounded primitive elicitation round trips passed. The Pi interaction run used `-ne` with only the explicit Herdr state adapter, relay adapter, and a temporary test extension; it returned the selected `allow_once` and `{ environment: "staging", enabled: true, retries: 3 }` to exact request IDs. Claude transcript binding/replay, proof-based ACP prompt, remote single-select and multi-select `AskUserQuestion`, remote `ExitPlanMode` approval, and native generic Bash `PermissionRequest` allow passed. The Claude permission test created then removed only `/tmp/acp-claude-permission-test`. A no-authorized-client AskUserQuestion test correctly fell back to Claude's terminal-local question UI, where `local` was selected.

### Other future work

```text
live validation of Claude image prompt and MessageDisplay/tool/Stop hook events
optional Pi URL/custom/file interaction modes (not planned without a separate lifecycle/security contract)
additional richer Pi primitive constraints
```

---

## 9. Critical safety invariants

Do not regress these:

1. Never expose transcript paths or raw Herdr pane IDs from ACP list responses.
2. Never treat terminal input or Herdr acknowledgement alone as prompt acceptance; wait for native transcript evidence.
3. Do not auto-install hooks on relay start. Hook modification stays explicit.
4. Preserve Herdr/Moshi/user hook and Pi extension configuration during install/uninstall.
5. Pi global/native permissions are out of scope; only event-bridge-aware extensions use remote approvals/questions.
6. Claude native interaction mapping is allowed only where documented hook input/output provides an exact safe path.
7. No remote write/interactions without existing trusted-user/device authorization.
8. The local hook socket is owner-only and validates native session binding against current Herdr state.
9. First valid authorized interaction response wins. Later responses must not reach the agent/extension.
10. Raw terminal `/api/*` control stays available as fallback.

---

## 10. Useful commands

```bash
# Environment
export PATH="$HOME/.bun/bin:$PATH"

# Full check
bun run typecheck
bun run test
bun run build:web
git diff --check

# Hook lifecycle
herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay
herdr plugin action invoke hooks-status --plugin rad.herdr-mobile-relay
herdr plugin action invoke hooks-uninstall --plugin rad.herdr-mobile-relay

# Direct per-adapter hook lifecycle
bun run scripts/acp-hooks.ts install pi
bun run scripts/acp-hooks.ts install claude
bun run scripts/acp-hooks.ts status all

# Local ACP test relay
COLLIE_ACP=on COLLIE_PORT=8788 \
COLLIE_STATE_DIR="$PWD/.local-acp-runtime-state" \
bun run bridge/index.ts
```
