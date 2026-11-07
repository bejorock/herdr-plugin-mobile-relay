# Lean relay API

See [OpenAPI](openapi.json) for retained HTTP operations and [README](../README.md) for deployment and security.

Requests may select a discovered runtime with `?session=<name>`; absent selects the primary, unknown returns 404.

REST responses acknowledge Herdr operations, not model completion. A `textDelivered` or `deliveryAmbiguous` error must not be blindly retried. Read the pane first.

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
