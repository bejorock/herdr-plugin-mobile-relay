# Hybrid ACP + Herdr Relay Implementation Plan

**Status:** In progress — see [`ACP_IMPLEMENTATION_HANDOVER.md`](ACP_IMPLEMENTATION_HANDOVER.md) for the current implemented slice, validated behavior, safety invariants, and next-step context.
**Last updated:** 2026-10-26
**Scope:** `herdr-plugin-mobile-relay` only. This document defines a client-agnostic relay interface; no particular mobile, desktop, web, or CLI client is required.

## Implementation status

Completed initial vertical slice:

- pinned `@agentclientprotocol/sdk` `2.0.2` and uses its experimental ACP v2 protocol constant;
- added opt-in `COLLIE_ACP=on` configuration, off by default;
- added authenticated WebSocket endpoint `GET /acp` to the existing Bun relay;
- preserves Herdr-reported native session references internally while redacting them from existing REST snapshots;
- projects connected Herdr agent panes into opaque ACP session IDs;
- implements ACP initialization, `session/list`, and state-synchronizing `session/resume` for the discovery/resume preview;
- implements bounded, path-contained Pi JSONL replay for `session/resume` with `replayFrom: { type: "start" }`;
- implements the private owner-only local hook socket, validated hook binding handshake, and namespaced custom-notification forwarding primitives;
- implements guarded ACP `session/new` provisioning: exact-root workspace reuse (or workspace creation), fresh tab/pane creation, explicit supported agent choice, Herdr agent startup, and native-session discovery wait;
- implements proof-based Pi text `session/prompt`: invokes Herdr semantic prompting, serializes delivery per ACP session, and waits for a new matching native transcript entry before returning the ACP message ID;
- implements Pi cancellation by forwarding ACP `session/cancel` to a single Herdr Escape key request only for a working/blocked pane; completion remains authoritative only when later Herdr state reports it; `session/close` releases the ACP attachment without destroying the Herdr pane;
- implements bounded Pi transcript tailing after ACP resume, with deduplicated complete ACP message/thought updates for newly appended JSONL entries and cleanup when the WebSocket closes;
- implements explicit, idempotent Pi hook lifecycle actions (`hooks-install`, `hooks-status`, `hooks-uninstall`) that install only the relay-owned extension and preserve Herdr, Moshi, and user extension entries;
- implements ACP text-plus-image prompt parsing with strict image MIME/count/decoded-size limits, owner-only server-named upload files, and Pi `@absolute-path` native attachment references; transcript confirmation remains the prompt acceptance boundary;
- extends the installed Pi relay extension to publish immediate validated `running`/`idle` state, tool lifecycle, and assistant/thought streaming deltas as ACP updates, while Herdr polling and transcript replay remain the authoritative fallback;
- implements a first-authorized-response-wins ACP interaction broker for validated local hook permission/elicitation requests, including expiry, no-authorized-client cancellation, private hook resolution commands, and client connection-close cancellation;
- implements and documents a Pi extension event-bus bridge (`herdr-relay:publish`, `herdr-relay:request-permission`, `herdr-relay:request-elicitation`, `herdr-relay:interaction-result`) instead of a separate SDK package, including bounded primitive custom elicitation schemas;
- verifies the endpoint, transcript replay/tailing, hook handshake/state/tool/interaction validation, provisioning logic, prompt validation, cancellation behavior, image storage, interaction response races, event-bridge generation, structured elicitation, and hook config preservation through automated tests plus live local Herdr/Pi non-mutating checks.

- implements an initial Claude transcript adapter for hook-mapped Claude sessions: path-contained JSONL replay/tailing of non-sidechain user/assistant text messages, plus proof-based text prompting through Herdr `agent.prompt`; Claude image prompts remain unsupported.

- implements explicit Claude SessionStart, PermissionRequest, and matcher-scoped PreToolUse (`AskUserQuestion|ExitPlanMode`) hook lifecycle actions that preserve existing Claude, Herdr, Moshi, and user hook entries, report a safe native transcript binding, and synchronously map remote ACP permission, documented option-question, and plan approval responses back to the exact native hook invocation.

- maps Claude `AskUserQuestion` to bounded ACP form elicitation: 1–4 unique questions, single/multi-select documented option labels, first-valid-authorized response wins, original native questions are preserved, and invalid/cancelled/expired/disconnected remote interactions emit no Claude decision so the terminal-local interaction remains available.

- maps Claude `ExitPlanMode` to a bounded ACP markdown `plan_update` followed by an approval request. The hook returns a native PreToolUse allow only for explicit remote approval and preserves the injected native plan payload exactly; every other outcome falls back terminal-local.

Not yet implemented: optional URL/custom/file Pi extension interaction modes and any richer Claude-native features beyond the documented current hooks. Claude now provides best-effort MessageDisplay/tool/Stop semantic hook events and proof-based private-path image prompts; Pi generic elicitation now supports bounded multi-select arrays in addition to primitives. Native Pi/global permission, question, and plan interception remains intentionally out of scope; Pi extensions use the documented event bridge instead. The remaining phases below are still required before claiming full ACP support.

---

## 1. Executive summary

Extend Herdr Mobile Relay into a **hybrid control and agent relay**:

```text
Any remote client
  ├─ Herdr Mobile Relay API (REST + existing live-terminal WebSocket)
  │    └─ manages Herdr sessions, workspaces, worktrees, tabs, panes,
  │       terminal input/output, files, Git inspection, and agent lifecycle
  │
  └─ ACP v2 API (WebSocket-only JSON-RPC)
       └─ exposes native agent sessions as structured conversations,
          updates, tools, permissions, elicitation, plans, and extensions

                             ↓

                   Herdr Mobile Relay
                    (single Bun server)

                             ↓

Herdr Unix-socket RPC            Local agent integration protocol
  ├─ durable multiplexer state     ├─ Pi extension
  ├─ agent start/prompt             ├─ Claude Code hooks
  ├─ pane input/keys                └─ third-party hook SDK
  └─ terminal streaming

                             ↓

Normal interactive Pi / Claude Code / future agent process in a Herdr pane
  ├─ native terminal UI remains intact
  ├─ native agent configuration remains intact
  └─ native transcript remains durable source of conversation history
```

The relay remains the **only network-facing component**. It still binds loopback-only and is published privately by Tailscale Serve when remote use is configured. Hooks are host-local integrations; they never expose an additional network listener.

The ACP interface does **not** require an agent to run in ACP, RPC, JSON, or headless mode. Pi and Claude Code continue running normally in Herdr terminals. The relay adapts their native session/transcript/hook signals into ACP.

A future optional mode may launch a new Pi instance using Pi RPC for a more direct structured source, but it is explicitly out of scope for the initial interactive-terminal adapter.

---

## 2. Decisions already made

| Topic | Decision |
| --- | --- |
| Client | Client-agnostic. A hypothetical native client is illustrative only; it is not part of this repository’s scope. |
| Existing relay | Preserve existing Herdr management REST API and terminal WebSocket. Do not replace them with ACP. |
| ACP role | The relay acts as the ACP **Agent** to remote ACP Clients. Herdr itself is not claimed to natively implement ACP. |
| ACP protocol target | ACP **v2 semantics**, including session lifecycle, `session/update`, permissions, elicitation, plans, metadata/extensibility, and resume/replay rules. |
| ACP remote transport | **WebSocket only**, at a dedicated `/acp` endpoint. JSON-RPC 2.0 payloads use WebSocket text frames. |
| ACP HTTP/SSE | Not implemented initially. No POST/SSE profile, HTTP/2 requirement, connection/session stream headers, or cookie-affinity scheme in phase 1. |
| Server topology | One Bun relay process/server. `/api/*`, `/api/live`, static PWA assets, and `/acp` coexist. No separate ACP daemon. |
| Herdr resources | Herdr REST/control API creates workspaces, worktrees, tabs, and panes. ACP binds/runs agent conversations; it does not silently own structural creation. |
| Agent launch | A Herdr management request may explicitly ask to start an agent after creating a shell pane. It reports a staged readiness lifecycle. |
| Terminal fallback | Keep raw terminal reads, live frames, raw input, semantic keys, submit, focus, and close actions. They remain the universal fallback. |
| Hooks | Ship relay-owned hooks/adapters for Pi and Claude Code; install only via explicit actions, never on relay start. |
| Existing Herdr hooks | Reuse existing Herdr agent-session/state reporting first. Do not edit Herdr-managed integration files. |
| Moshi | Use it as evidence/prior art only. The relay must not depend on Moshi, its daemon, its private gateway, its pairing, or its cloud service. |
| IDs | Keep Herdr IDs, native-agent IDs, and relay ACP IDs distinct. Never make clients infer one namespace from another. |
| Pi custom hooks | The relay-owned Pi bridge exposes namespaced informational events plus custom elicitation and custom approvals over Pi's event bus. It does not intercept or control Pi/global permission systems. |
| Claude native hooks | A later Claude adapter may map Claude's own hook-reported permissions, questions, and plans through ACP only where the hook provides an exact safe resolution path. |
| Relay ACP namespace | Use `herdr.dev` for relay-specific ACP `_meta` capabilities and custom JSON-RPC methods such as `_herdr.dev/...`. |
| Multiple ACP clients | Multiple authorized clients may attach to a session. The first valid authorized answer to a pending interaction wins; later answers receive an already-resolved error/notification. |
| `session/new` backing resources | `session/new` automatically provisions a Herdr backing pane: reuse one exact-root workspace (prefer focused on ties) and create a new tab/pane, or create a workspace when no exact root match exists. |
| Agent selection | `session/new` requires the client to explicitly supply a supported agent kind via `herdr.dev` metadata; there is no hidden default agent. |
| ACP images | Support text and image prompt blocks: save accepted images privately through the relay upload flow, then use adapter-specific safe native path-reference syntax. Reject unsupported adapter/version cases. |
| Hook install | Provide explicit install/status/uninstall management. Installer must preserve user, Herdr, and Moshi integrations. |

---

## 3. Problem statement

The current relay securely maps Herdr’s local Unix-socket RPC to remote REST/WebSocket operations. It is excellent at managing durable terminal workspaces, but a remote client sees agent output principally as terminal output.

Terminal output is not enough for a reliable native conversation interface because it intermixes:

- user prompts;
- assistant prose;
- tool activity;
- tool result output;
- prompts and permission menus;
- ANSI formatting and redraws;
- arbitrary third-party CLI content.

Yet launching a second dedicated ACP agent process would fork or replace the user’s existing terminal session. It would lose the existing agent’s working context, terminal state, local configuration, agent permissions, skills, MCP servers, and active process lifecycle.

The solution is a hybrid adapter:

1. Keep the existing live terminal as source of truth and fallback.
2. Discover which native agent session currently belongs to a Herdr pane.
3. Read/tail its durable transcript for historical chat and tool information.
4. Receive fine-grained semantic lifecycle events from opt-in relay hooks.
5. Normalize those sources into ACP v2 messages.
6. Route prompts and supported responses back to the exact same live agent through Herdr.

---

## 4. Non-goals

The first implementation must not:

- replace Herdr’s ownership of terminal/workspace/process lifecycle;
- force Pi, Claude Code, or other agents to run in RPC/headless/ACP mode;
- parse arbitrary terminal text into fabricated message/tool/permission objects;
- expose Herdr’s Unix socket directly to remote clients;
- expose the hook socket or any new listener off-host;
- depend on Moshi’s private loopback gateway/API;
- automatically edit agent configuration during relay startup;
- make all existing agents ACP-capable;
- promise that every native terminal interaction can be represented as a structured ACP interaction;
- expose absolute host transcript paths to remote clients by default;
- let an arbitrary custom extension impersonate Pi/Claude native permission prompts.

---

## 5. Public surface and route layout

### 5.1 Existing Herdr control interface

Keep and evolve the current routes under `/api/*`:

```text
GET  /api/snapshot
GET  /api/pane/:paneId
POST /api/pane/:paneId/reply
POST /api/pane/:paneId/input
POST /api/pane/:paneId/submit
POST /api/pane/:paneId/keys
POST /api/pane/:paneId/upload
POST /api/pane/:paneId/close
POST /api/tab
PATCH /api/tab/:tabId
DELETE /api/tab/:tabId
POST /api/workspace
DELETE /api/workspace/:workspaceId
POST /api/worktree
DELETE /api/worktree/:workspaceId
POST /api/focus/:paneId
GET  /api/workspace/:workspaceId/{files,file,git,diff}
GET  /api/live                 # existing non-ACP WebSocket
```

This plane remains responsible for **structure, raw terminal access, and universal fallback**.

### 5.2 New ACP interface

Add one endpoint only:

```text
GET /acp
Upgrade: websocket
```

Local development:

```text
ws://127.0.0.1:8787/acp
```

Private deployed use:

```text
wss://<machine>.<tailnet>.ts.net:<serve-port>/acp
```

It carries only UTF-8 JSON-RPC 2.0 text frames. Binary frames are rejected/ignored according to the selected ACP transport behavior. The route has the same access/identity/origin/device gating as the current relay, with ACP-specific connection/session authorization described below.

### 5.3 ACP transport statement

Document the endpoint honestly as:

> ACP v2 JSON-RPC over the WebSocket remote transport profile.

ACP standardizes local stdio; its remote Streamable HTTP/WebSocket work is evolving. This relay intentionally implements only the WebSocket profile. It does not claim to implement the POST + SSE transport profile.

### 5.4 Why WebSocket only

ACP is a bidirectional protocol, not just a stream of assistant tokens:

```text
Client → Relay
  initialize, session/list, session/resume, session/prompt, session/cancel,
  session/close, responses to permission/elicitation requests

Relay → Client
  JSON-RPC responses, session/update notifications, session/request_permission,
  elicitation/create, notices, extension notifications
```

WebSocket provides one full-duplex JSON-RPC channel with one reconnect model. Streamable HTTP would require HTTP/2 plus separate POST and multiple SSE stream lifecycles per connection/session; that is not justified for the loopback/private, stateful relay deployment.

Native mobile support is standard:

- iOS: `URLSessionWebSocketTask`;
- Android: OkHttp/Ktor WebSocket;
- Flutter: `web_socket_channel` / Dart WebSocket;
- React Native: built-in `WebSocket`;
- desktop and browsers: standard WebSocket implementations.

---

## 6. Identifier model and durable mapping

Do not merge these identity spaces.

### 6.1 Herdr structural identifiers

```text
herdrSessionName     e.g. default
workspaceId          e.g. w1P
tabId                e.g. w1P:t1
paneId               e.g. w1P:p1
```

### 6.2 Native agent identifiers

```text
agentKind            pi | claude | ...
nativeSessionId      agent’s own durable session ID, if supplied
transcriptPath       absolute local-only path, if supplied
agentSource          herdr:pi | relay:pi | ...
```

### 6.3 Relay ACP identifiers

```text
acpConnectionId      in-memory identity for one authenticated WebSocket
acpSessionId         opaque durable relay-owned agent-session identifier
hookConnectionId     ephemeral local IPC connection identity
interactionId        opaque pending permission/elicitation/action identifier
```

### 6.4 Agent session registry

Add a process-owned `AgentSessionRegistry` with durable metadata storage under the relay private state directory. It maps a stable adapter session to its current native owner:

```ts
interface AgentSessionBinding {
  acpSessionId: string;
  owner: {
    user: string | null;          // configured/trusted user identity scope
    deviceScope?: string | null;  // only if device policy requires it
  };
  herdr: {
    session: string;
    workspaceId: string;
    tabId: string;
    paneId: string;
  };
  adapter: {
    kind: "pi" | "claude" | string;
    version: number;
  };
  native: {
    sessionId?: string;
    transcriptRef?: string;       // private resolver key; do not expose host path
    source: string;
  };
  lifecycle: "discovered" | "starting" | "ready" | "detached" | "ended" | "failed";
  createdAt: number;
  updatedAt: number;
}
```

Rules:

- `acpSessionId` is generated by the relay and opaque to clients.
- The registry verifies the current Herdr snapshot before binding or acting.
- One pane may have sequential native agent sessions; each gets a distinct ACP session binding or an explicitly documented replacement transition.
- A transcript path is stored privately and represented externally only by capability/state.
- Bindings are scoped to the authenticated principal and must not be enumerable by unrelated users/devices.
- On relay restart, reload persisted bindings, then revalidate them against the live Herdr snapshot and transcript roots before use.

---

## 7. ACP v2 contract

### 7.1 Initialization

First WebSocket application message must be JSON-RPC `initialize`.

The relay returns:

- negotiated ACP v2 protocol version;
- agent/session capabilities actually supported by this relay build;
- relay agent `name`, `title`, version;
- namespaced `_meta` capability data for relay-specific optional extensions.

The relay must not advertise a standard ACP capability merely because it could fake part of it. Capability advertisement is adapter-specific and based on currently available support.

Illustrative capability direction:

```json
{
  "protocolVersion": 2,
  "capabilities": {
    "session": {
      "resume": {},
      "prompt": {},
      "cancel": {},
      "close": {}
    },
    "_meta": {
      "herdr.dev": {
        "transport": "websocket",
        "hookProtocolVersion": 1,
        "herdrControlApi": true,
        "customInteractions": true
      }
    }
  },
  "info": {
    "name": "herdr-mobile-relay",
    "title": "Herdr Mobile Relay",
    "version": "0.1.0"
  }
}
```

Exact field names/types must be generated or validated against the selected ACP v2 schema/library before implementation.

### 7.2 Session discovery and list

Implement ACP session discovery from the validated registry:

- list only sessions visible to the authenticated principal;
- expose a client-safe title, agent kind, and current state;
- do not expose raw Herdr IDs or transcript paths unless a separately negotiated, explicitly documented `herdr.dev` extension needs them.

Use the exact v2 method names and schemas (`session/list`, `session/resume`, etc.) from the pinned ACP library/schema.

### 7.3 Session creation and Herdr backing resources

`session/new` is supported as a documented `herdr.dev` extension of standard ACP session creation. Standard ACP fields retain their normal meaning; relay-specific creation policy lives only under permitted `_meta` data.

Illustrative request shape:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/opt/workspaces/project",
    "mcpServers": [],
    "_meta": {
      "herdr.dev": {
        "agent": {
          "kind": "pi",
          "args": []
        }
      }
    }
  }
}
```

The first implementation must apply this deterministic workflow:

1. Validate the ACP connection, write authorization, absolute `cwd`, and `herdr.dev.agent.kind`.
2. Require an explicit agent kind. Reject absent or unsupported kinds; never silently select Pi, Claude, or a host-configured default.
3. Search the authoritative Herdr workspace snapshot for workspaces whose resolved checkout/root exactly equals `cwd`.
4. If exactly one exact-root match exists, select it.
5. If multiple exact-root matches exist, select the focused one. If none is focused, use an explicit deterministic stable tie-breaker and report it in audit metadata; do not use fuzzy parent/child path matching.
6. If no exact-root workspace exists, create a new Herdr workspace rooted at `cwd`.
7. Create a fresh tab/shell pane in the selected/new workspace.
8. Call Herdr `agent.start` with the explicit requested kind and validated optional arguments.
9. Wait for Herdr interactive readiness, then for native session/hook/transcript discovery.
10. Create the opaque relay ACP binding and return the ACP `sessionId` only when it is ready for session operations, or return an explicit bounded startup failure.

The result must not leak raw Herdr identifiers by default. Lifecycle/creation metadata may be surfaced to capable clients through namespaced `herdr.dev` `_meta` and is always recorded in audit logs.

### 7.4 Session resume and history replay

Implement `session/resume` exactly as v2 requires:

- validate ownership and the supplied working directory;
- attach the current ACP WebSocket connection to the existing relay session;
- if `replayFrom` is omitted: do not replay history; send an authoritative current `state_update` before the resume response;
- if `replayFrom: { type: "start" }`: replay retained transcript history as `session/update` notifications before current state and response;
- reject unsupported/malformed replay cursors with JSON-RPC `-32602`, never silently substitute behavior;
- preserve stable native user-message IDs when possible; document when agent/thought IDs are reconstructed;
- restore/re-emit any still-valid pending interaction or safely resolve/expire it.

Initial support may implement `{ type: "start" }` only; capability/schema behavior for other replay cursors must reject them explicitly.

### 7.5 Session prompt

`session/prompt` is supported only for a binding whose adapter can safely submit input to the currently live native agent.

Flow:

1. Validate ACP session ownership, agent binding freshness, and client write authorization.
2. Validate supported content types: first release accepts text and image blocks.
3. For every image block, enforce MIME, count, decoded byte, request-body, and aggregate prompt limits; persist it through the existing owner-only relay upload mechanism.
4. Give each accepted upload a bounded/single-use lifecycle and resolve it only through the selected adapter. Do not expose the private host path to the remote client.
5. The selected adapter converts the private uploaded image to its known safe native local-path reference syntax. If the adapter/agent version cannot safely accept an image reference, reject the ACP prompt with an explicit unsupported-content error; never paste a guessed path into a terminal.
6. Resolve whether the agent is idle, working, blocked, detached, or unavailable.
7. Prefer a new relay route/Herdr RPC wrapper for `agent.prompt` when the target is an agent pane.
8. Use raw terminal input only as a documented adapter fallback with explicit idempotency and delivery-ambiguity handling.
9. Wait for proof of native insertion:
   - hook `user_message.accepted`, or
   - newly appended matching transcript user entry, or
   - an adapter-defined authoritative event.
10. Only after insertion proof, respond successfully with the ACP `messageId`.
11. Emit user message and current state updates in required ACP order.
12. If insertion cannot be confirmed by a bounded deadline, return an error; do not claim ACP acceptance solely because text was written to a terminal.

When the native agent is already busy, adapter behavior must follow ACP and native-agent semantics. For Pi, steering/follow-up may be supported only where the adapter can map it faithfully; otherwise reject rather than silently changing meaning.

### 7.6 Live updates

Normalize these into standard ACP `session/update` variants where trustworthy:

```text
state_update
user_message / user_message_chunk
agent_message / agent_message_chunk
agent_thought / agent_thought_chunk
tool_call_update
tool_call_content_chunk
plan_update
available_commands_update
config_option_update
session_info_update
usage_update
notice
compaction_update / compaction_summary_chunk
terminal_update / terminal_output_chunk
```

Source precedence:

| Data | Preferred source | Fallback |
| --- | --- | --- |
| Pane/workspace ownership | Herdr snapshot | none |
| Basic working/blocked/idle | Herdr state + relay hook | terminal only displays, not inferred ACP state |
| Durable history | Native transcript parser | none |
| Live assistant deltas/tool lifecycle | Relay-owned agent hook | transcript tail producing full updates |
| Extension-requested approval/input | Relay-owned Pi event bridge | terminal or extension-local fallback |
| Terminal frames | Existing Herdr terminal observer | `terminal_*` only when adapter policy exposes it |

Do not emit token/chunk streams if the source only provides complete transcript entries. Complete `agent_message` updates are valid; fabricated chunks are not.

### 7.7 Cancellation and close

Implement `session/cancel` and `session/close` according to ACP v2:

- cancel requests stopping active foreground work;
- use the most reliable adapter-supported action first;
- fallback to a configured Herdr terminal key sequence only when safe and explicitly documented;
- update pending interactions as cancelled;
- emit the final `idle` state with `stopReason: "cancelled"` only after the native operation has actually reached/corroborated cancellation;
- `session/close` cancels work and releases ACP connection/adapter resources without implicitly destroying the Herdr pane unless a separate Herdr control request says so.

### 7.8 Pi extension interactions and future Claude native interactions

**Pi:** The relay provides an ACP interaction transport for Pi extensions that deliberately request remote input. It does **not** intercept, replace, configure, or resolve Pi/global permission systems.

```text
A Pi extension deliberately emits herdr-relay:request-permission or
herdr-relay:request-elicitation
  → relay authorization + interaction broker
  → ACP session/request_permission or elicitation/create
  → first authorized client response
  → private hook command
  → relay Pi bridge emits herdr-relay:interaction-result
  → originating extension decides its own host-side action
```

**Claude Code:** Claude is not treated as an extension-driven agent here. When the dedicated Claude hook adapter is implemented, it may translate Claude's own hook-reported permission, question, and plan requests into ACP and resolve them back into the exact active Claude interaction. This is conditional on proving a stable, versioned hook payload and a safe, unambiguous native response path. Until then those Claude interactions remain terminal-local.

Rules:

- A Pi originating extension owns the meaning and host-side effect of its interaction result.
- Pi native/global permission interception is intentionally out of scope.
- Claude native interaction interception is a future adapter capability, not a generic Pi event-bus capability.
- Responses are tied to one `interactionId`, native session, pane, and hook connection.
- A stale/dismissed/resolved interaction produces a deterministic no-op; it must never target a newer request.
- Every remote approval, denial, answer, cancellation, and failed/ambiguous delivery is audit logged.
- The relay’s remote user/device write gates apply before ACP interaction resolution.

### 7.9 Extensions

Follow ACP v2 extensibility:

- custom JSON-RPC method names begin with `_`;
- custom capability discovery is namespaced within `_meta`;
- custom entity metadata uses `_meta` where the ACP schema permits it;
- custom tagged-union values use `_` where allowed;
- never add arbitrary fields to standard ACP schema objects.

Examples:

```text
_herdr.dev/interaction
_example.dev/deployment_ready
_example.dev/review_gate
```

Clients need not implement custom extensions. They can ignore unknown custom notifications safely.

---

## 8. Herdr control plane additions

### 8.1 Expand `HerdrClient`

`bridge/herdr-client.ts` currently wraps core pane/workspace RPC calls. Add typed wrappers for stable supported Herdr methods:

```text
agent.list
agent.get
agent.start
agent.prompt
agent.send_keys
agent.focus
agent.wait
```

Before coding, derive their exact input/output wire shapes from the installed Herdr `api schema --json`, pin tests to fixtures, and keep all raw Herdr method/wire knowledge inside `bridge/herdr-client.ts`.

### 8.2 New control routes

Add explicit, authenticated REST routes rather than overloading ACP structural calls:

```text
POST /api/pane/:paneId/agent/start
POST /api/pane/:paneId/agent/prompt      (optional semantic control route)
POST /api/pane/:paneId/agent/cancel      (if safe/implemented)
GET  /api/pane/:paneId/agent             (sanitized adapter/binding state)
```

Exact route names may be refined during API design, but maintain these boundaries:

- structural creation uses existing workspace/tab/worktree routes;
- agent start is an explicit subsequent/optional action;
- ACP does not silently create a workspace or kill a pane;
- raw pane input/keys remain untouched.

### 8.3 Create + start lifecycle

Extend create responses/options with an optional agent launch request:

```json
{
  "label": "feature-mobile",
  "cwd": "/opt/workspaces/project",
  "agent": {
    "kind": "pi",
    "args": []
  }
}
```

or perform it as two explicit calls.

The implementation must expose a staged result, not promise a chat session too early:

```text
shell_created
agent_starting
agent_ready_in_terminal
native_session_discovered
acp_binding_ready
```

`agent.start` should use Herdr’s supported agent kinds and readiness timeout. The relay waits for hook/transcript mapping only after Herdr has confirmed that the agent is detected and ready for input.

---

## 9. Consume existing Herdr agent integrations first

Herdr already installs integrations for Pi and Claude Code that report:

```text
pane.report_agent_session
pane.report_agent
```

They provide native session references and state such as working/blocked/idle. The relay’s current `WirePane`/domain model omits `agent_session`; phase 1 must preserve it.

### 9.1 Required changes

1. Inspect current Herdr schema and snapshot response shape for `agent_session` fields.
2. Extend raw wire types in `bridge/herdr-client.ts`.
3. Extend internal `AgentView` or a private parallel binding input type.
4. Keep raw transcript paths private to the backend; add only sanitized capability/status fields to the public snapshot.
5. Feed this data into `AgentSessionRegistry`.
6. Detect mapping changes and invalidate stale transcript tailers/interactions.

### 9.2 Do not edit Herdr-managed files

Do not modify files generated/owned by Herdr, including paths like:

```text
~/.pi/agent/extensions/herdr-agent-state.ts
~/.claude/hooks/herdr-agent-state.sh
```

They may be overwritten by Herdr integration installation/upgrades.

The relay must install its own separate Pi extension and Claude hook entries alongside existing integrations.

---

## 10. Relay hook architecture

### 10.1 Purpose

Hooks solve the missing semantic layer that transcript tailing and Herdr state cannot safely provide:

- native session lifecycle;
- proof that a prompt was inserted;
- live assistant deltas;
- tool lifecycle/progress;
- exact permission prompt metadata;
- exact question schema/options;
- plan review metadata;
- interaction resolution/cancellation;
- extension-defined event publication.

### 10.2 Local IPC endpoint

The relay creates an owner-only Unix socket in its private state directory:

```text
<stateDir>/agent-hook.sock
```

Requirements:

- state directory mode `0700`; socket inaccessible to other OS users;
- unlink stale socket only after ownership/endpoint validation;
- do not bind any TCP port for hooks;
- relay startup starts the hook listener before declaring hook capability ready;
- relay shutdown stops accepting events, tells persistent peers it is closing, and unlinks safely;
- define maximum connection count, max frame/event bytes, per-agent queue limits, and event-rate limits.

### 10.3 Hook protocol

Versioned newline-delimited JSON over the Unix socket.

#### Handshake

A persistent hook first identifies itself:

```json
{
  "version": 1,
  "type": "hello",
  "adapter": {
    "kind": "pi",
    "name": "herdr-relay-pi",
    "version": "0.1.0"
  },
  "binding": {
    "herdrSession": "default",
    "paneId": "w1P:p1",
    "workspaceId": "w1P",
    "tabId": "w1P:t1",
    "agent": "pi",
    "nativeSessionId": "01a17736-...",
    "transcriptPath": "/absolute/path/session.jsonl"
  },
  "capabilities": {
    "messageDeltas": true,
    "toolEvents": true,
    "nativePermissions": true,
    "nativeElicitation": true,
    "customEvents": true,
    "customInteractions": true
  }
}
```

Relay response:

```json
{
  "version": 1,
  "type": "hello_ack",
  "hookConnectionId": "...",
  "binding": {
    "acpSessionId": "...",
    "accepted": true
  },
  "limits": {
    "maxEventBytes": 65536,
    "maxQueuedEvents": 256
  }
}
```

#### Event envelope

```json
{
  "version": 1,
  "type": "event",
  "eventId": "adapter-generated-id",
  "sequence": 42,
  "event": {
    "kind": "agent_message.delta",
    "payload": {}
  }
}
```

#### Relay command envelope

```json
{
  "version": 1,
  "type": "command",
  "commandId": "relay-generated-id",
  "command": {
    "kind": "interaction.resolve",
    "interactionId": "...",
    "outcome": {}
  }
}
```

#### Hook acknowledgement/result

```json
{
  "version": 1,
  "type": "result",
  "commandId": "...",
  "ok": true,
  "data": {}
}
```

All unknown versions, malformed envelopes, duplicate sequences, invalid state transitions, or over-limit frames are rejected without affecting the agent process.

### 10.4 Local hook validation

A local socket is not automatically a complete authorization system. Validate every hook binding against authoritative state:

- expected current OS user/socket permissions;
- `HERDR_ENV=1` and Herdr binding metadata supplied by the first-party adapter where applicable;
- current Herdr session snapshot has matching pane, workspace, tab, agent kind, and native session reference;
- transcript path is absolute, canonicalized, readable only under allowed configured agent transcript roots, and matches/validates native session identity;
- a hook cannot change pane/session binding after handshake without an explicit rebind protocol and registry revalidation;
- custom hooks cannot report on an unrelated pane merely by supplying its ID;
- event sequence/event ID deduplication protects retries;
- failed/unavailable relay hooks must never block or crash Pi/Claude normal operation.

### 10.5 Connection styles

Support both:

1. **Persistent connection:** first-party Pi extension and adapters requiring relay-to-hook interaction use a persistent socket connection.
2. **One-shot publisher:** simple third-party integrations can send one bounded event and receive an acknowledgement.

The public SDK hides framing/retries. It must never silently queue unbounded events or hang agent execution.

---

## 11. First-party Pi adapter

### 11.1 Installation

Ship a separate relay-owned Pi extension, for example:

```text
~/.pi/agent/extensions/herdr-relay-acp.ts
```

It coexists with:

```text
herdr-agent-state.ts       # owned by Herdr
moshi-hooks.ts             # owned by Moshi, if installed
```

Install it by adding only the relay’s own extension entry to Pi’s settings through an explicit `hooks-install` action. The installer must back up/atomically modify config, be idempotent, and remove only its own entry on uninstall.

### 11.2 Responsibilities

Use Pi’s documented extension API to report:

```text
session_start / session_shutdown
before_agent_start
agent_start / agent_end / agent_settled
message_start / message_update / message_end
tool_execution_start / tool_execution_update / tool_execution_end
compaction_start / compaction_end
session_info_changed
thinking_level_changed
```

The adapter obtains native session ID/path from Pi’s `sessionManager` and binds it to Herdr environment information.

### 11.3 Mapping to ACP

| Pi event | Hook event | ACP output |
| --- | --- | --- |
| `session_start` | `session.started` | session metadata/binding readiness |
| `before_agent_start` | `user_message.pending` | waits for insertion confirmation logic |
| Pi user message finalized | `user_message.accepted` | `user_message` + prompt response eligibility |
| `agent_start` | `state.running` | `state_update: running` |
| `message_update` text/thinking | delta events | message/thought chunks |
| `message_end` | completed message | full authoritative message update |
| `tool_execution_start` | tool started | `tool_call_update: in_progress` |
| `tool_execution_update` | tool partial | `tool_call_content_chunk` / update |
| `tool_execution_end` | tool complete | terminal tool update |
| `agent_settled` | settled | `state_update: idle` with mapped stop reason |
| compaction lifecycle | compaction events | compaction updates/chunks |

### 11.4 Native interaction support

The adapter should not invent permissions. It can only expose standard ACP `session/request_permission` and `elicitation/create` when Pi’s extension/UI APIs expose a real actionable pending interaction whose answer can be resumed safely through the extension.

If Pi does not offer a stable programmatic interception/resolution API for a given interaction, publish a terminal-only notice and retain raw Herdr terminal control.

### 11.5 Public Pi extension API

Expose a stable relay API to other Pi extensions. Prefer a typed module/global API registered by the relay extension rather than string-only event names.

Conceptual surface:

```ts
interface HerdrRelayHookApi {
  publish(event: NamespacedEvent): Promise<void>;
  requestElicitation(request: NamespacedElicitation): Promise<ElicitationResult>;
  requestApproval(request: NamespacedApproval): Promise<ApprovalResult>;
  getBinding(): Readonly<RelayBinding | null>;
}
```

A compatibility event bridge can exist but is secondary:

```text
herdr-relay:publish
```

The API must clearly state that custom interactions are namespaced and are not native Pi permission authority.

---

## 12. First-party Claude Code adapter

### 12.1 Installation

Install a relay-owned executable/script under relay-controlled configuration/state, then merge only relay-owned hook entries into the user’s Claude settings file.

Do not replace or edit:

```text
~/.claude/hooks/herdr-agent-state.sh
```

Do not replace Moshi hook entries.

### 12.2 Responsibilities

Use Claude’s supported hook events to report what it can reliably know:

```text
SessionStart / resume / clear / compact / fork
UserPromptSubmit
permission_prompt
AskUserQuestion
ExitPlanMode
resolution/stop lifecycle events where provided
```

Capture the native session ID and transcript path at session start. Maintain interaction IDs and revisions so events map to the exact prompt shown in the live terminal.

### 12.3 Capability realism

Claude adapter capabilities must be advertised independently from Pi. If a supported Claude hook only observes an interaction but cannot resolve it safely, report it as terminal-only rather than advertising ACP elicitation/permission support.

---

## 13. Public custom hook SDK

### 13.1 Goal

Let locally installed, trusted agent extensions communicate semantic application events through the relay to any capable ACP client.

Examples:

```text
review ready
preview deployed
workflow task changed
specialized tool progress
human gate requested
custom agent collaboration signal
```

### 13.2 Custom event contract

Custom events must have a reverse-DNS namespace:

```json
{
  "namespace": "example.dev",
  "name": "deployment_ready",
  "payload": {
    "url": "https://preview.example.test",
    "commit": "abc123"
  }
}
```

Relay behavior:

- validate namespace syntax, name, schema size/depth, and serializability;
- bind event to the authenticated hook connection’s validated ACP session;
- forward only to clients that advertised matching support;
- emit a JSON-RPC custom notification such as:

```json
{
  "jsonrpc": "2.0",
  "method": "_example.dev/deployment_ready",
  "params": {
    "sessionId": "opaque-acp-session",
    "payload": {}
  }
}
```

- unknown clients can ignore it;
- persist only if the event contract says it is durable; otherwise treat as live-only notice.

### 13.3 Custom elicitation and approvals

Third-party extensions can request a **namespaced** interaction:

```text
_example.dev/request_input
_example.dev/request_approval
```

Relay requirements:

- standard ACP interaction methods are used where the ACP schema/capability supports the interaction form, with the custom source/namespace included in permitted `_meta`;
- if ACP cannot represent the specific interaction safely, send a negotiated custom request beginning with `_`;
- clients must display the extension namespace/source prominently;
- default policy requires user/device write authorization to resolve an interaction;
- relay audits request, response, expiry, and delivery result;
- explicit timeout/default/deny behavior is mandatory;
- no custom extension can emit standard native `session/request_permission` for a Pi/Claude tool call;
- hook SDK custom approval does not grant the extension authority over arbitrary terminal input—its action is delivered only to the hook that created the matching interaction.

### 13.4 Capability advertisement

The relay advertises custom hook extension availability only via ACP `_meta`, for example:

```json
{
  "_meta": {
    "herdr.dev": {
      "hookProtocol": 1,
      "customEvents": true,
      "customInteractions": true,
      "namespaces": ["example.dev"]
    }
  }
}
```

No custom fields are added directly to standard ACP capability objects.

### 13.5 Trust policy

The SDK runs in an agent process and therefore has that process’s OS permissions. It must be treated as privileged local code.

Still, isolate authority:

| Producer | Permitted behavior |
| --- | --- |
| First-party Pi/Claude adapter | May report native events and create standard ACP requests only after adapter-specific validation. |
| Third-party custom extension | May publish namespaced events and custom interactions. |
| Third-party custom extension | May not impersonate Herdr, Pi, Claude, or relay-native standard permission/tool events. |
| Any hook | Cannot claim another pane/session after binding validation. |

---

## 14. Transcript adapters

### 14.1 General design

Add adapter interface:

```ts
interface AgentAdapter {
  readonly kind: string;
  discover(binding: AgentSessionBinding): Promise<AdapterDiscovery>;
  readHistory(binding: AgentSessionBinding, cursor?: ReplayCursor): AsyncIterable<NormalizedAgentEvent>;
  tail(binding: AgentSessionBinding, onEvent: (event: NormalizedAgentEvent) => void): Promise<Disposable>;
  submitPrompt?(...): Promise<SubmissionProof>;
  cancel?(...): Promise<CancelProof>;
  capabilities(binding: AgentSessionBinding): AdapterCapabilities;
}
```

Adapters parse only known safe local transcript formats; reject unexpected formats/unsafe paths; bound memory, line length, JSON depth, historical replay size, and tail buffers.

### 14.2 Pi transcript adapter

Pi JSONL is append-only, tree-based, and includes message, tool result, compaction, model/thinking change, usage, and custom entries.

Implement:

- header/session validation;
- active branch/history replay semantics;
- stable user message IDs derived from Pi entry IDs where appropriate;
- assistant/tool/usage/compaction normalization;
- incremental tailing from byte offsets with partial-line buffering;
- file rotation/replacement handling;
- transcript-to-hook reconciliation to prevent duplicate messages.

### 14.3 Claude transcript adapter

Implement only after collecting/redacting fixture transcripts for supported Claude versions. It must:

- use hook-provided exact session path/ID;
- parse only supported documented/observed records;
- tolerate unknown records and schema evolution;
- retain raw terminal fallback when an event cannot be normalized;
- map tool/question/plan information only when source schema is unambiguous.

### 14.4 No newest-file heuristic

Never select a transcript by modification time. The authoritative mapping is:

```text
live Herdr pane
  ↔ existing Herdr report / relay hook native session mapping
  ↔ exact transcript reference
```

---

## 15. Reconnection and durability

### 15.1 ACP connection loss

WebSocket loss does not stop the agent or destroy the Herdr pane. The client reconnects, initializes, and resumes its opaque ACP session.

### 15.2 Resume semantics

- Registry binding and transcript cursor supply durable history.
- `session/resume` with `replayFrom: start` rebuilds retained history.
- Resume without replay produces current state only.
- Persist only the minimum durable pending interaction metadata required to re-establish/expire it safely.
- Never replay live-only notices as history.

### 15.3 Events while disconnected

The initial WebSocket transport does not promise in-flight message replay. Durable transcript replay and session resume are the recovery mechanism. Document this clearly.

### 15.4 Ordering and concurrent clients

- Per ACP session, serialize state transitions and interaction transitions.
- Multiple authorized ACP clients may observe and attach to the same session.
- Any write-authorized attached client may submit a prompt or respond to a pending interaction.
- For a permission, elicitation, or custom interaction, the **first valid authorized response wins** atomically. Record and publish the terminal resolution; reject every later response as already resolved.
- Preserve adapter event sequence where possible.
- Use per-session queues/backpressure limits.
- Replace partial streamed entities with authoritative complete transcript/hook updates.
- Never allow a stale resume state snapshot to overwrite a newer live state.
- Controller leases are explicitly out of scope for the initial release; add them later only if observed client races require stronger ownership.

---

## 16. Authentication, authorization, and audit

### 16.1 Reuse current relay boundary

`/acp` must use the existing relay access model:

- loopback-only Bun bind;
- validated Host and same-origin rules;
- Tailscale trusted-user identity on remote/proxied traffic;
- optional device authorization;
- no Funnel/public endpoint;
- remote access disabled without explicit trusted identity configuration.

### 16.2 ACP authorization

Add ACP-specific checks:

- map ACP connection to authenticated principal/device;
- only list/load/resume sessions owned/visible to that principal;
- require write authorization for prompt/cancel/close and interaction responses;
- reject cross-session interaction responses;
- disconnect/revoke on auth/device policy changes where feasible;
- do not rely on ACP session IDs as authentication tokens.

### 16.3 Audit records

Extend append-only audit events to cover:

```text
acp.session.resume
acp.prompt.requested
acp.prompt.accepted
acp.prompt.rejected
acp.cancel.requested
acp.close.requested
acp.permission.requested
acp.permission.resolved
acp.elicitation.requested
acp.elicitation.resolved
acp.custom_interaction.requested
acp.custom_interaction.resolved
hook.connected
hook.rejected
hook.binding_changed
hook.custom_event
agent.start
agent.prompt
agent.cancel
```

Do not log complete sensitive message content by default. Record bounded metadata, event IDs, session/pane IDs, source/namespace, outcome, timing, and ambiguity flags. Existing audit sanitization/truncation rules apply.

### 16.4 Hook path safety

Transcript file reads must enforce:

- allowed configured roots for each adapter;
- canonical path containment;
- no symlink traversal outside allowed roots;
- regular-file requirement;
- owner/mode expectations where practical;
- size/line/event caps;
- failure closed to terminal-only rather than arbitrary file reads.

---

## 17. Configuration and lifecycle actions

### 17.1 Configuration

Add documented environment configuration only where essential, for example:

```dotenv
# Master switch for ACP endpoint (default off during initial rollout)
COLLIE_ACP=off

# Enable individual built-in adapters after hooks are installed
COLLIE_ACP_PI=on
COLLIE_ACP_CLAUDE=on

# Optional bounded limits
COLLIE_ACP_MAX_CONNECTIONS=16
COLLIE_ACP_MAX_HOOK_EVENT_BYTES=65536
COLLIE_ACP_MAX_REPLAY_BYTES=...
COLLIE_ACP_INTERACTION_TIMEOUT_MS=...
```

Exact names and defaults should be finalized with the config/security review. Preserve fail-closed behavior.

### 17.2 Plugin actions

Add explicit actions:

```text
hooks-install
hooks-status
hooks-uninstall
acp-status
```

Possibly adapter-specific forms:

```text
hooks-install --target pi
hooks-install --target claude
```

Actions must:

- show a dry-run/change summary before mutation where platform permits;
- make a timestamped/atomic backup before editing user config;
- merge only relay-owned entries using stable marker IDs/paths;
- be idempotent;
- never remove non-relay entries;
- detect that an agent needs restart before the new hook is active;
- verify hook socket connectivity with a non-sensitive probe;
- fully uninstall only relay-owned files/configuration.

### 17.3 Existing start behavior

`start` must not install hooks. It may warn:

```text
ACP enabled but Pi hook not installed; terminal control remains available.
Run: herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay
```

---

## 18. Code structure

Proposed backend modules:

```text
bridge/acp/
  protocol.ts                ACP schema/types, JSON-RPC validation, errors
  server.ts                  /acp WebSocket lifecycle and routing
  connection.ts              authenticated ACP connection state
  session-registry.ts        ACP session bindings and ownership
  dispatcher.ts              initialize/session methods dispatcher
  updates.ts                 ordered ACP update publisher
  interactions.ts            permission/elicitation/custom interaction broker
  adapters/
    types.ts
    pi.ts
    claude.ts
    transcript.ts
  hook/
    server.ts                private Unix-socket listener
    protocol.ts              local envelope validation/types
    binding.ts               hook-to-Herdr binding verifier
    interactions.ts          relay → hook command channel
    sdk/                     generated/shared SDK artifacts as appropriate
  persistence.ts             durable sanitized ACP metadata/cursors

bridge/herdr-client.ts       expanded typed Herdr agent methods/wire refs
bridge/state-engine.ts       capture agent session metadata
bridge/types.ts              sanitized agent capability/binding public types
bridge/server.ts             mount /acp and expanded management routes
bridge/audit.ts              ACP/hook action records
bridge/config.ts             ACP/hook feature flags and limits

scripts/
  collie-ctl.sh              hook action integration
  install-relay-hooks.*      config mutation helpers where appropriate

docs/
  ACP_HYBRID_RELAY_IMPLEMENTATION_PLAN.md
  ACP_API.md                 protocol reference once implemented
  HOOK_SDK.md                local hook SDK and trust model
```

Avoid putting ACP routing directly into the already-large `bridge/server.ts`; mount a tested dedicated ACP module through the existing Bun server.

---

## 19. Phased implementation plan

## Phase 0 — Contract freeze and fixtures

**Objective:** Lock decisions, schemas, threat model, and non-destructive test artifacts before code changes.

1. Pin an ACP v2 TypeScript schema/SDK version compatible with this project’s TypeScript/Bun stack.
2. Record the exact ACP remote WebSocket profile/version in `docs/ACP_API.md`.
3. Export and sanitize Herdr protocol schema fixtures for agent methods and snapshot `agent_session` fields.
4. Capture sanitized Pi/Claude transcript fixtures covering:
   - session start;
   - user/assistant turns;
   - tools;
   - compaction;
   - question/plan/permission cases;
   - session restart/resume;
   - malformed/partial JSONL lines.
5. Write hook protocol v1 document and JSON fixtures.
6. Threat-model custom hooks and write authorization invariants.
7. Add feature flags, defaulting ACP/hook endpoint features off until later phases are verified.

**Exit criteria:** no ambiguity about selected ACP schema, supported methods, fixture formats, or unsafe fallback behavior.

## Phase 1 — Herdr agent-session discovery

**Objective:** Build correct pane ↔ native session mapping without installing any relay hook.

1. Extend `WirePane`/snapshot model to retain Herdr-reported agent session metadata.
2. Add tests for Pi and Claude `agent_session` wire shapes.
3. Implement `AgentSessionRegistry` with in-memory binding lifecycle.
4. Add sanitized binding/capability fields to snapshots or a protected agent-info route.
5. Validate transcript path containment and disable unsafe/unknown bindings.
6. Implement non-mutating `acp-status` diagnostics showing discovered/usable adapters without exposing transcript paths.

**Exit criteria:** live Herdr Pi/Claude panes that already have Herdr integrations map to an internal native session binding reliably; no raw host paths leak to API clients.

## Phase 2 — ACP WebSocket foundation

**Objective:** Serve an authenticated, strict, WebSocket-only ACP v2 endpoint.

1. Implement `/acp` upgrade route using existing request access gate plus ACP connection state.
2. Add strict UTF-8 JSON-RPC framing, maximum frame sizes, malformed message behavior, and message rate limits.
3. Implement `initialize`, protocol version negotiation, capabilities, and agent info.
4. Implement `session/list`, session ownership filtering, `session/resume`, `session/close`, and current-state synchronization.
5. Implement transcript-backed replay from `{ type: "start" }` for a minimal Pi adapter.
6. Implement per-session ordered update publisher and connection cleanup.
7. Add WebSocket unit/integration tests with fake Herdr/adapter data.

**Exit criteria:** a generic ACP WebSocket client can initialize, enumerate authorized sessions, resume a Pi session, receive history/current state, disconnect, reconnect, and resume again.

## Phase 3 — Transcript adapters and read-only native chat

**Objective:** Make Pi and then Claude history readable as ACP without relying on terminal scraping.

1. Implement Pi JSONL parser/replayer/tailer with byte cursor persistence.
2. Normalize Pi messages, tool results, compaction, usage, model/thinking metadata into ACP updates.
3. Reconcile transcript tail events with Herdr state without duplicating messages.
4. Implement Claude parser from recorded versioned fixtures; begin read-only if lifecycle data is incomplete.
5. Bound replay/tail resource use and test corrupted/truncated/rotated files.
6. Document adapter fidelity/capabilities.

**Exit criteria:** history and completed updates render natively for mapped Pi/Claude sessions; unsupported records fail safely to terminal fallback.

## Phase 4 — Explicit hook installation and local hook server

**Objective:** Add the relay-owned local semantic event channel without surprising agent config changes.

1. Implement private owner-only hook Unix socket server and v1 protocol.
2. Implement binding handshake, validation, deduplication, event queueing, and relay-to-hook commands.
3. Implement hook SDK core (persistent and one-shot clients).
4. Implement explicit `hooks-install`, `hooks-status`, `hooks-uninstall` actions and transactional configuration modification helpers.
5. Build Pi extension installer/config merger.
6. Build Claude hook installer/config merger.
7. Test coexistence against existing Herdr/Moshi configuration fixtures.
8. Verify no relay start/restart mutates agent settings.

**Exit criteria:** hooks are opt-in, reversible, coexist with Herdr/Moshi, and can safely connect/bind only to their own active pane/session.

## Phase 5 — Pi live ACP adapter and interactions

**Objective:** Achieve full structured Pi experience where Pi exposes enough extension data.

1. Implement relay-owned Pi extension events for state, messages, deltas, tools, compaction, and session changes.
2. Implement Pi prompt insertion confirmation.
3. Implement `session/prompt` using Herdr semantic `agent.prompt` plus hook/transcript confirmation.
4. Implement `session/cancel` with proof-based completion.
5. Implement supported Pi native permission and elicitation mappings.
6. Implement plan/config/available-command updates where Pi exposes stable data.
7. Add duplicate/out-of-order/reconnect/failure tests.

**Exit criteria:** supported Pi session has correct structured live events; prompt/permission/question actions are audited, correlated, and no less safe than terminal fallback.

## Phase 6 — Claude live ACP adapter and interactions

**Objective:** Add the same capability progressively for Claude Code.

1. Implement relay Claude hook event parser/adapter.
2. Add precise SessionStart/user prompt/permission/AskUserQuestion/plan mappings where Claude hooks provide them.
3. Implement safe response injection only for recognized active prompts and exact answer formats.
4. Keep unsupported Claude UI flows terminal-only.
5. Test multiple Claude session/pane mappings, stale hooks, and agent restart.

**Exit criteria:** Claude capabilities are advertised honestly; only safe structured flows are ACP actions.

## Phase 7 — Public hook SDK and custom ACP extensions

**Objective:** Allow trusted local extensions to use the relay without compromising standard ACP semantics.

1. Publish SDK documentation/types/examples.
2. Implement namespaced event publication.
3. Implement namespaced custom elicitation and approval broker.
4. Advertise negotiated namespaces/capabilities in ACP `_meta`.
5. Add source labeling, expiry, replay protection, audit, rate limits, and explicit client behavior.
6. Provide a sample Pi extension using the public API.

**Exit criteria:** a sample third-party Pi extension can send a custom event and request a custom approval/question through a compliant client; it cannot impersonate native agent permissions or another pane.

## Phase 8 — UX, documentation, hardening, release

**Objective:** Make the capability operable and safe for real deployments.

1. Publish API reference, ACP support matrix, hook SDK guide, migration guide, and security model.
2. Add diagnostics to `status` and `/api/config` without leaking secrets/paths.
3. Add metrics/logging that record only metadata and byte/event counts.
4. Run compatibility tests against ACP SDKs where practical.
5. Perform security review: origin/auth, hook spoofing, stale interaction, transcript traversal, framing/backpressure, audit coverage.
6. Run release verification with Pi/Claude live sessions, relay restart, Herdr restart, and disconnected client tests.
7. Initially release behind opt-in ACP flags; promote defaults only after real-world validation.

---

## 20. Test plan

### 20.1 Unit tests

Add tests for:

- ACP JSON-RPC validation and error behavior;
- initialization/version/capability negotiation;
- WebSocket frame handling, limits, malformed/unexpected frames;
- session ownership/visibility checks;
- registry lifecycle and stale binding rejection;
- transcript parser normalization and partial-line handling;
- Pi branch/compaction replay correctness;
- path containment/symlink protection;
- hook handshake/envelope/version/sequence validation;
- interaction state machine, expiry, duplicate response, stale response;
- custom namespace validation and capability negotiation;
- audit entries/sanitization;
- agent start/prompt/cancel outcome mapping;
- existing APIs remain unchanged.

### 20.2 Integration tests

Use fake/local Herdr socket fixtures and an ACP test client to validate:

```text
initialize → session/list → session/resume(start replay)
prompt acceptance → running → messages/tools → idle
permission request → client response → hook result
elicitation request → client response → hook result
cancel while active
close while active
WebSocket disconnect → reconnect → resume
hook disconnect while interaction pending
Herdr session/pane disappears
agent native session changes in same pane
```

### 20.3 Live smoke tests

With explicit operator consent and dedicated disposable panes/workspaces:

- start Pi through Herdr;
- confirm binding/hook/session discovery;
- resume/replay from an ACP test client;
- send a harmless prompt;
- exercise a safe custom hook event;
- exercise a harmless custom elicitation/approval;
- verify terminal stays synchronized;
- test raw terminal fallback;
- repeat for Claude Code;
- restart relay and verify durable resume;
- restart Herdr and verify stale binding handling.

Do not run tests that type into unrelated active user panes.

### 20.4 Regression gates

Every phase must retain:

```bash
bun run typecheck
bun run test
bun run build
```

Also add ACP/hook test commands to package scripts once the modules exist.

---

## 21. Security checklist

- [ ] `/acp` has the same remote identity and Host/Origin protections as `/api/*`.
- [ ] Device authorization is required for ACP writes and interaction decisions.
- [ ] ACP session IDs are opaque, non-authorizing identifiers.
- [ ] ACP session list/resume cannot reveal sessions to another trusted but unauthorized user/device.
- [ ] Hook Unix socket/state dir are private and owner-only.
- [ ] Hook binding is matched against current Herdr state before use.
- [ ] Hook cannot redirect a session to another pane after handshake without revalidation.
- [ ] Transcript path is validated under adapter-specific allowed roots and no symlink escape occurs.
- [ ] No direct raw transcript path exposed remotely by default.
- [ ] Prompt/approval/elicitation result has idempotency and stale-request defenses.
- [ ] Interaction resolver never injects into a terminal after native interaction changed/resolved.
- [ ] Custom extension events/approvals are namespaced and visibly attributed.
- [ ] Custom extensions cannot impersonate first-party native permission flows.
- [ ] Frame/event/replay/queue limits prevent memory or file-read exhaustion.
- [ ] Backpressure disconnects or sheds safely rather than blocking Herdr or agents.
- [ ] Hook failures never block native agent execution.
- [ ] Remote write and interaction outcomes are audit logged with sensitive-content minimization.
- [ ] Tailscale Funnel remains unsupported and warned against.

---

## 22. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| ACP v2 remote transport is evolving | Pin a schema/SDK, version endpoint behavior, expose WebSocket only, retain feature flags, add compatibility tests. |
| Transcript formats change | Adapter version detection, fixtures, tolerant unknown-record handling, safe terminal fallback. |
| Native agent does not expose action resolution API | Advertise reduced capability; keep interaction terminal-only. |
| Duplicate hooks/events from Herdr/Moshi/relay | Relay owns only its own source/namespace, deduplicates event IDs and precedence rules. |
| Unsafe custom extension prompts | Namespaced source attribution, custom-only interactions, device/user auth, audit, timeout, no impersonation. |
| Prompt delivery ambiguity | Require hook/transcript insertion proof before ACP success; preserve existing ambiguous-delivery signals. |
| Stale terminal prompt gets a remote answer | Interaction IDs/revisions, hook confirmation, per-session serialization, expiry, terminal fallback. |
| Large/malicious transcript | strict roots, file size/line limits, incremental parsing, truncation/notice. |
| Relay restart loses state | private durable binding/interaction metadata plus transcript replay; revalidate everything after restart. |
| User config damage from hook installer | explicit action only, backup + atomic merge, stable markers, idempotency, exact uninstaller. |
| Client incompatibility with custom features | Standard ACP core remains usable; custom functionality requires negotiated `_meta` capabilities and has generic fallback. |

---

## 23. Open questions to resolve before implementation starts

These are not blockers for recording the plan, but they require an explicit answer during Phase 0/design.

1. **ACP library/version:** Which exact TypeScript ACP v2 SDK/schema revision will be vendored or depended on? It must match the current Bun/TypeScript toolchain and support the WebSocket transport profile.
2. **Authentication in ACP initializers:** Is the current Tailscale-header/device model sufficient as the only outer transport authentication, or should ACP also support an explicit application token for non-Tailscale trusted proxy deployments?
3. **Agent-start route ergonomics:** `session/new` now owns automatic Herdr backing-resource creation. Decide later whether existing REST create/worktree routes also accept an optional `agent` object or whether explicit `agent/start` remains their only launch operation.
4. **Image adapter syntax:** Text and images are in scope. Confirm exact safe image/local-path reference behavior for each supported Pi/Claude version before enabling the adapter capability.
5. **Native session persistence:** How long should orphaned/stopped ACP bindings be retained for historical resume? Recommendation: retain sanitized metadata for a configurable bounded TTL; transcript availability remains the final constraint.
6. **Custom hook package distribution:** Should the SDK be exported as a package, copied/generated standalone TypeScript, or both? Recommendation: start with generated/installed local adapter files and a documented TypeScript module; package later when API stabilizes.
7. **Claude hook fidelity:** Confirm exact installed Claude hook event schemas and which interactions can be safely resolved, rather than assuming all observed events are answerable.
8. **Pi permission/elicitation API:** Confirm whether Pi exposes a stable extension-level mechanism to intercept and resolve permission/question interactions in non-TUI contexts. Do not rely on terminal parsing for a structured ACP claim.
9. **System service semantics:** What should `hooks-install` do on systems where relay state location changes by plugin install/link mode? Recommendation: resolve through existing plugin config/state directory logic and include absolute generated paths in action output.

---

## 24. References and evidence

### Repository/local evidence

- `bridge/server.ts` — existing secured Bun HTTP/WebSocket entrypoint.
- `bridge/herdr-client.ts` — sole Herdr wire/RPC adapter boundary.
- `bridge/types.ts` — existing public relay domain model.
- `bridge/live-updates.ts` — current session-scoped WebSocket event hub.
- `bridge/terminal-observer.ts` — current terminal frame/control bridge.
- `~/.pi/agent/extensions/herdr-agent-state.ts` — Herdr-installed Pi integration reports pane/session references and state.
- `~/.claude/hooks/herdr-agent-state.sh` — Herdr-installed Claude hook reports session ID/transcript path.
- `~/.pi/agent/extensions/moshi-hooks.ts` — local example of Pi lifecycle/interactive hook forwarding to a Unix socket.
- Current `moshi-hook` installation demonstrates terminal-backed native chat architecture but is not a runtime dependency.

### ACP references

- ACP v2 overview: <https://agentclientprotocol.com/protocol/v2/overview>
- ACP v2 session setup: <https://agentclientprotocol.com/protocol/v2/session-setup>
- ACP v2 prompt lifecycle: <https://agentclientprotocol.com/protocol/v2/prompt-lifecycle>
- ACP v2 extensibility: <https://agentclientprotocol.com/protocol/v2/extensibility>
- ACP Streamable HTTP & WebSocket RFD: <https://agentclientprotocol.com/rfds/streamable-http-websocket-transport>
- ACP TypeScript HTTP/WebSocket example: <https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/examples/http-server.ts>

### Agent/multiplexer prior art

- Moshi Chat View: <https://getmoshi.app/docs/chat-view>
- Moshi hook architecture: <https://getmoshi.app/docs/hooks>
- Moshi Herdr integration: <https://getmoshi.app/docs/herdr>

---

## 25. Definition of done

The feature is complete when all of the following are true:

1. The relay remains a secure loopback-only Herdr control gateway with all existing functionality intact.
2. An authorized native/mobile/desktop/browser ACP client can open `/acp` over WebSocket, initialize ACP v2, list, resume, and replay a supported agent session.
3. A normally launched Pi agent in a Herdr pane can be viewed as both:
   - structured ACP chat/tool/session updates; and
   - its untouched raw terminal through existing relay interfaces.
4. Prompting and cancellation have proof-based semantics and never claim success merely because terminal bytes were sent.
5. Supported Pi permission/question/plan interactions round-trip through ACP with authorization, stale-request defense, and audit logging.
6. Claude Code is supported to the degree its hook/transcript contracts permit; unsupported flows cleanly fall back to terminal interaction.
7. Herdr structural creation and explicit agent start work independently of ACP and can result in an ACP binding once native session discovery completes.
8. Hook installation is explicit, reversible, idempotent, and does not overwrite Herdr/Moshi/user hooks.
9. A documented third-party hook SDK can publish namespaced events and request namespaced custom approval/elicitation flows without impersonating core agent permissions.
10. Tests cover protocol, hooks, registry, transcript safety, reconnect/replay, authorization, audit, and coexistence; typecheck, test, and build pass.
