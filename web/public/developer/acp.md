# ACP WebSocket API

**Status:** Experimental / opt-in
**Endpoint:** `GET /acp` WebSocket upgrade
**Protocol:** ACP v2-style JSON-RPC 2.0 over WebSocket text frames

This relay exposes two complementary client interfaces:

```text
/api/*       Herdr workspace/pane/worktree/raw-terminal management
/api/live    existing terminal/control WebSocket
/acp         structured agent-session ACP channel
```

The relay is an ACP adapter; Herdr, Pi, and Claude Code do not need to natively speak ACP.

## Enablement and access

ACP is enabled by default. To deliberately disable it:

```dotenv
COLLIE_ACP=off
```

The endpoint uses the relay's existing security boundary:

- relay binds loopback only;
- direct local development: `ws://127.0.0.1:8787/acp`;
- remote deployment: Tailscale Serve/private proxy `wss://.../acp`;
- trusted-user, Host, same-origin, and optional device authorization checks apply;
- prompt/cancel/session creation/interaction responses require an authorized write device;
- never publish the relay with Tailscale Funnel.

## Transport

One WebSocket carries all JSON-RPC requests, responses, notifications, and server-to-client requests.

- Payloads are UTF-8 JSON text frames.
- Maximum inbound frame size is 256 KiB.
- JSON-RPC batches are currently rejected.
- `initialize` must be the first request and may occur once per connection.
- On reconnect, clients should initialize again and resume known sessions.

## Initialization

Client request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 2,
    "info": {
      "name": "example-acp-client",
      "version": "1.0.0"
    },
    "capabilities": {}
  }
}
```

The response advertises standard `session` capabilities and `herdr.dev` metadata. The relay validates the required ACP v2 client `info` object (`name`, `version`) before initialization; legacy `clientCapabilities` alone is not accepted.

## Sessions

### `session/list`

Lists ACP sessions projected from currently connected Herdr agent panes. IDs are opaque and do not expose Herdr pane IDs or transcript paths.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/list",
  "params": {}
}
```

Each result includes agent/status metadata under:

```json
{
  "_meta": {
    "herdr.dev": {
      "agent": "pi",
      "nativeStatus": "working",
      "nativeSessionBound": true
    }
  }
}
```

### `session/resume`

Resumes a listed session. The `cwd` must exactly match the listed session `cwd`.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/resume",
  "params": {
    "sessionId": "herdr_...",
    "cwd": "/absolute/project/path",
    "replayFrom": { "type": "start" }
  }
}
```

With `replayFrom: {"type":"start"}`:

- Pi adapter replays safe, active-branch JSONL user/assistant/thought history.
- Claude adapter replays safe non-sidechain user/assistant text history.
- then the relay emits the current `state_update`;
- then it responds to `session/resume`.

The relay starts a transcript tailer after resume. New durable transcript records appear as complete ACP updates. Pi hooks may additionally deliver lower-latency best-effort chunks.

### `session/new`

Creates a Herdr-backed agent session. The client must explicitly name an agent in `herdr.dev` metadata:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/new",
  "params": {
    "cwd": "/absolute/project/path",
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

Behavior:

1. reuse an exact-root Herdr workspace, preferring a focused exact match;
2. otherwise create a Herdr workspace at `cwd`;
3. create a fresh tab/shell pane;
4. call Herdr `agent.start` for the requested supported agent;
5. wait for native agent-session discovery;
6. return the opaque ACP session ID.

The client must never rely on a default agent. Relative `cwd` values and unsupported kinds are rejected.

### `session/prompt`

Text prompts are supported for Pi and hook-mapped Claude sessions:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/prompt",
  "params": {
    "sessionId": "herdr_...",
    "prompt": [{ "type": "text", "text": "Review the current diff." }]
  }
}
```

The relay submits through Herdr `agent.prompt`, then waits for a **new matching native transcript user entry** before returning the ACP `messageId`. A Herdr transport acknowledgement alone is not treated as acceptance proof.

Pi image blocks are supported:

```json
{
  "type": "image",
  "mimeType": "image/png",
  "data": "base64..."
}
```

Limits:

- maximum four images per prompt;
- PNG, JPEG, WebP, GIF only;
- maximum 10 MB decoded data per image.

The relay stores images in owner-only state storage. Pi receives an `@absolute-path` attachment reference; Claude receives a documented absolute-path image instruction. It does not expose the host path to the remote client, and transcript replay redacts a relay upload path if it appears in native text.

### `session/cancel` and `session/close`

`session/cancel` is a notification. For working/blocked Pi sessions, the relay asks Herdr to send one Escape key. It does not claim cancellation completed until later native/Herdr state confirms it.

`session/close` releases the ACP session attachment and may request the same safe Pi cancellation. It does **not** close the durable Herdr pane; pane/workspace closing stays on `/api/*`.

## Live updates

The relay emits ACP `session/update` notifications from three layers:

```text
Herdr state engine       authoritative agent/pane state fallback
Native transcript        durable history and complete messages
Pi relay hook            low-latency state/tool/message/thought updates
```

Pi hook update types include:

```text
state_update
agent_message_chunk
agent_thought_chunk
tool_call_update
```

The optional Claude hook also emits best-effort assistant line-batch chunks, tool state updates, and an idle state hint. Its durable replay remains Claude transcript-based.

Clients should treat transcript replay as durable recovery after reconnect. Live chunks are best-effort and can be repeated or followed by a complete transcript-backed message update.

## Local Pi extension bridge

Install explicitly:

```bash
herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay
```

Other Pi extensions can publish events and request remote interactions over Pi's shared event bus. See [`PI_RELAY_HOOK_EVENTS.md`](PI_RELAY_HOOK_EVENTS.md).

The bridge supports namespaced notifications, permission requests, and bounded form elicitations: primitive fields, string enums, and multi-select string arrays. The original extension owns the local action after it receives the relay result. The relay does not take over global Pi or third-party permission systems.

## Current limitations

- ACP remote transport and v2 protocol surface are experimental.
- Batches are not supported.
- Pi hook interactions are generic extension-driven requests; the relay does not intercept all Pi tool permissions.
- Claude supports transcript replay/tailing and proof-based text prompts. Private-path image prompting is implemented: the relay stores an ACP image in owner-only upload storage and inserts a native absolute-path instruction; transcript replay redacts that host path before it reaches ACP clients. Its final live Claude smoke test is pending quota availability.
- The optional Claude hook reports the exact native session/transcript binding, relays native `PermissionRequest` allow/deny decisions, maps Claude `AskUserQuestion` through ACP `elicitation/create`, and maps `ExitPlanMode` through a plan update plus ACP approval request. Question support is limited to documented option-label answers (single select and multi-select); both adapters preserve the exact native input and fall back to Claude's terminal-local UI for invalid, cancelled, disconnected, or expired remote interactions.
- The optional Claude hook also emits best-effort assistant line-batch deltas, tool started/completed/failed updates, and an idle state hint through `MessageDisplay`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop`. Transcript replay remains authoritative.
- Native/global **Pi** permission, question, and plan interception is intentionally out of scope. Pi extensions that want remote interaction must deliberately use the documented `herdr-relay:*` event-bus bridge.
- A future **Claude** hook adapter may map additional safe Claude-native interactions only where the hook payload and native response path can be proven safe.
- Pi extension-provided elicitation supports bounded primitive form fields. The internal Claude question adapter additionally supports bounded multi-select option fields. URL and custom modes are not implemented.
- Existing REST/WebSocket terminal APIs remain the fallback for all unsupported interactions.
