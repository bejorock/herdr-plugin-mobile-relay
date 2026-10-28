# Architecture

## Ownership

```text
browser / native app
        |
        | REST + session-scoped WebSocket
        v
Herdr Mobile Relay bridge (Bun, loopback only)
        |
        | RPC over Unix socket + native terminal controller stream
        v
Herdr server -> workspaces -> tabs -> terminal panes -> agents
```

Herdr remains the source of truth for process lifetime, pane state, workspace structure, and agent status. The browser is a client and can disappear without affecting running work.

## ACP adapter plane

Unless explicitly disabled with `COLLIE_ACP=off`, the same Bun process also serves an experimental ACP v2 JSON-RPC WebSocket at `/acp`. It adapts normal interactive Pi and Claude Code processes running in Herdr panes; agents do not need to run in headless, RPC, or ACP mode.

```text
ACP client
  │ WebSocket /acp (JSON-RPC 2.0)
  v
relay ACP adapter
  ├─ safe native transcript replay/tailing
  ├─ proof-confirmed Herdr semantic prompts
  ├─ opaque ACP session IDs
  └─ owner-only local agent-hook.sock
       ├─ Pi relay extension / pi.events bridge
       └─ Claude Code command hooks
```

The ACP adapter never serializes Herdr pane IDs, native agent IDs, transcript paths, or private upload paths to ACP clients. It distinguishes Herdr identities, native identities, and opaque `herdr_…` ACP IDs. Existing REST and `/api/live` terminal interfaces remain the universal fallback.

### Hook lifecycle and security

Hook installation is an explicit operator lifecycle action, never a relay-start side effect. The installer writes only relay-owned Pi/Claude entries and preserves user, Herdr, and Moshi configuration. The private hook listener is an owner-only Unix socket that validates each binding against live Herdr pane/native-session state.

Pi interactions are deliberately extension-driven through documented `herdr-relay:*` events; the relay does not take over Pi global/native permission systems. Claude's documented native hook request/response paths are adapted where a safe exact resolution exists. Pending interactions go only to write-authorized ACP clients; first valid response wins, and local Claude UI remains available if remote interaction cannot complete.

### Durability

Transcript replay is the durable recovery mechanism for both agents. Claude's validated native-ID to transcript-path binding is stored owner-only in the relay state directory and restored only if it still exactly matches a connected live Herdr pane. Pending interactions are cancelled on relay shutdown rather than resumed ambiguously.

## Client mapping

| T3 Code concept | Herdr concept |
| --- | --- |
| Project | Workspace |
| Thread | Agent-bearing pane or shell pane |
| Environment | Named Herdr session / host bridge |
| Conversation timeline | Recent pane output |
| Composer send | `pane.send_text` followed by `pane.send_keys` |
| New thread | New tab with a shell pane |

## Transport

The bridge uses Collie's adapter boundary. `bridge/herdr-client.ts` is the only client-facing service module that knows Herdr RPC method names. Clients consume bounded snapshots and pane reads over REST, with a session-scoped WebSocket carrying structural change notifications and native terminal frames.

Navigation is event-poked: `events.subscribe` accelerates authoritative `session.snapshot` refreshes. An authorized native client drives the selected terminal through `herdr terminal session control --takeover` at that device's measured columns and rows. The bridge forwards ANSI redraw frames over the WebSocket and sends native `terminal.resize` and `terminal.scroll` commands back through the same controller process. This gives a smaller tablet viewport the same live TUI navigation semantics as an attached Herdr CLI instead of relying on local terminal scrollback. Read-only clients use `herdr terminal session observe`; bounded pane reads remain as startup, older-version, and reconnect recovery.

## Security

- Run Herdr Mobile Relay only on a single-user workstation (or inside an owner-isolated VM/container).
  Loopback prevents network ingress; it does not authenticate separate OS accounts on a shared host.
- Bind the bridge to loopback only.
- Expose it with `tailscale serve`; do not use public funneling.
- Treat every write endpoint as remote shell access.
- Configure `COLLIE_TRUSTED_USER` for every remote deployment; remote API access fails closed when
  it is absent. Device checks remain optional and add finer-grained write authorization.
- Remote per-device authorization requires both an allowlisted device header and the configured
  trusted-user identity header. Non-Tailscale proxies must strip/inject that header and set
  `COLLIE_TRUSTED_USER_HEADER` to its name.
- Render terminal output as React text nodes; never inject pane output as HTML.
- Keep the append-only audit log for every write action.

## Native client path

The browser types in `web/src/lib/types.ts` mirror the bridge domain types, not raw Herdr wire records. A native client can implement the same REST contract without emulating the web UI or knowing the Unix socket protocol.
