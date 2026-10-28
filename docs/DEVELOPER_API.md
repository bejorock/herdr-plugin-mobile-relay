# Developer API Reference

Herdr Mobile Relay has three client interfaces, all served by the same loopback-only Bun process:

| Interface | Endpoint | Best for |
| --- | --- | --- |
| REST control plane | `/api/*` | snapshots, workspace/pane control, file/Git inspection, notifications |
| Raw terminal WebSocket | `/api/live` | terminal rendering and interactive terminal control |
| ACP WebSocket | `/acp` | structured coding-agent sessions, prompts, replay, and semantic updates |

The running relay includes a visual **Redoc** reference at:

```text
http://127.0.0.1:8787/developer.html
```

It also serves the machine-readable OpenAPI 3.1 document at:

```text
http://127.0.0.1:8787/developer/openapi.json
```

When the relay is privately published through Tailscale Serve, use the same paths under its tailnet HTTPS origin. The OpenAPI document covers HTTP routes and summarizes WebSocket upgrades; this guide supplies the complete `/api/live` protocol, while [ACP_API.md](ACP_API.md) is authoritative for `/acp`.

## Connection and security

The relay **always binds only to loopback**:

```text
http://127.0.0.1:8787
ws://127.0.0.1:8787/api/live
ws://127.0.0.1:8787/acp
```

A normal remote deployment uses Tailscale Serve as an HTTPS/WSS reverse proxy. Do not bind the relay to a LAN address and do not use Tailscale Funnel.

### Remote requests

For a Serve-backed request to pass, all of these apply:

1. Its public `Host` must be allowed by the relay configuration.
2. Tailscale Serve injects `Tailscale-User-Login`; it must equal `COLLIE_TRUSTED_USER` (unless the request is a direct loopback call).
3. Browser mutations must be same-origin. A native non-browser client making a mutation without an `Origin` header must send:

   ```http
   X-Herdr-Client: herdr-mobile-v1
   ```

4. If optional per-device policy is configured, only an allowlisted device may execute mutations. Other authorized Tailscale users/devices may receive read responses but mutation routes return `403`.

The identity header is injected and spoofing-protected by Tailscale Serve. It is trustworthy only because the backend listens on loopback.

### Sessions and IDs

Most REST paths accept this optional query parameter:

```text
?session=<known-session-name>
```

Omit it for the primary session. A session name is only a registry lookup; it is never used as a filesystem path. Snapshot IDs (`paneId`, `workspaceId`, `tabId`) are opaque. Preserve and URL encode them rather than attempting to construct them.

Every mutation may cause a durable terminal or workspace change. Mutations supporting `requestId` accept a client-generated string matching `[A-Za-z0-9._:-]{1,128}`; reuse the same ID only to safely retry the same logical operation.

## REST conventions

- API reads and successful structured mutations return JSON.
- Route/validation errors may be JSON `{ "error": "…" }` or legacy plain text; clients must rely on HTTP status, not a single error shape.
- A missing/unknown `session` is `404`.
- A rejected identity, Host, origin, or device policy is `403`.
- `GET /api/pane/{paneId}` returns ANSI/SGR terminal text, not HTML.
- `GET /api/pane/{paneId}/reply` does not exist: terminal writes are POST-only.

For every REST route, schema, request body, and response example, open `/developer.html` on a running relay or inspect [`web/public/developer/openapi.json`](../web/public/developer/openapi.json) in source.

### Safe mutation retry behavior

`ActionResponse` has this form:

```json
{ "ok": true }
```

or:

```json
{
  "ok": false,
  "error": "typed into the pane but not submitted — check the pane before resending",
  "textDelivered": true,
  "deliveryAmbiguous": false
}
```

If `textDelivered` or `deliveryAmbiguous` is true, **do not blindly resend text**. Herdr may have received it even though the relay did not receive an acknowledgement. Refresh/read the pane first.

## `/api/live` WebSocket

Upgrade the route with a standard WebSocket client:

```js
const socket = new WebSocket("ws://127.0.0.1:8787/api/live?session=default");
```

The upgrade follows the same Host, Tailscale identity, and device authorization checks as REST. A socket opened by a read-only device receives status and terminal frames but cannot drive an observed terminal.

### Server → client messages

All frames are JSON text messages.

| Type | Payload | Meaning |
| --- | --- | --- |
| `connected` | `{ "type": "connected" }` | The relay registered the connection. |
| `source_status` | `{ "type": "source_status", "live": true }` | Herdr event-source health changed. |
| `snapshot_changed` | `{ "type": "snapshot_changed" }` | Refetch `/api/snapshot`; no snapshot is embedded. |
| `pane_output_changed` | `paneId`, `revision` | Refetch the pane output if not using a live terminal stream. |
| `pane_stream_status` | `paneId`, `live`, optional `reason` | Live terminal observation began/ended. |
| `pane_frame` | `paneId`, `seq`, `full`, `width`, `height`, `bytes` | ANSI terminal frame from the selected observed pane. |

A `pane_frame` example:

```json
{
  "type": "pane_frame",
  "paneId": "w1P:p1",
  "seq": 17,
  "full": false,
  "width": 120,
  "height": 40,
  "bytes": "\u001b[2J..."
}
```

`bytes` is terminal data. Interpret it with a proper ANSI terminal emulator; never inject it into the DOM as HTML. `full: true` is a complete redraw. Apply later incremental frames in sequence order and request a new watch after loss/reconnect.

### Client → server commands

Start/replace the pane observation with `watch_pane`:

```json
{
  "type": "watch_pane",
  "paneId": "w1P:p1",
  "cols": 120,
  "rows": 40
}
```

- `paneId` may be `null` to stop watching.
- `cols` is an integer from 20 to 400; default is 120.
- `rows` is an integer from 5 to 200; default is 40.

Scroll the currently watched pane:

```json
{
  "type": "scroll_pane",
  "paneId": "w1P:p1",
  "direction": "up",
  "lines": 10
}
```

`direction` is `up` or `down`; `lines` is an integer from 1 to 200. Commands that are malformed, target a different pane, or originate from a read-only socket are ignored. There is intentionally no general terminal-input WebSocket command: use the explicit REST pane mutation routes instead.

## `/acp` WebSocket

`/acp` is an ACP v2-style JSON-RPC 2.0 channel for coding-agent-aware clients. It is not a raw terminal protocol. Use it when a client needs agent sessions, prompts, transcript replay, semantic updates, and compatible Pi/Claude interactions.

Key requirements:

- UTF-8 JSON text frames; maximum inbound frame size is 256 KiB.
- JSON-RPC batches are rejected.
- `initialize` is the first request and can occur once per connection.
- Reconnects initialize again, then resume known opaque `herdr_…` session IDs.
- ACP session IDs deliberately do not disclose Herdr pane IDs, native agent IDs, transcript paths, or relay upload paths.

Read **[ACP_API.md](ACP_API.md)** before building an ACP client. It defines initialization, capabilities, session lifecycle, prompt image limits, cancellation semantics, replay, interaction behavior, and recovery expectations.

## Development and validation

Start a local relay, then browse:

```bash
herdr plugin action invoke start --plugin rad.herdr-mobile-relay
xdg-open http://127.0.0.1:8787/developer.html
```

Fetch the spec for code generators or API tooling:

```bash
curl http://127.0.0.1:8787/developer/openapi.json > herdr-mobile-relay.openapi.json
```

The specification is intentionally served from the same origin as the API so browser-based tooling inherits the relay's Host/origin/Tailscale security boundary.
