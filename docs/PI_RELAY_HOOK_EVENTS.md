# Pi Relay Hook Event Bridge

The relay-owned Pi extension installed by:

```bash
herdr plugin action invoke hooks-install --plugin rad.herdr-mobile-relay
```

bridges selected Pi extension events to the Herdr Mobile Relay private hook socket. It is not a separate SDK package. Other installed Pi extensions communicate with it through Pi's shared `pi.events` bus.

The bridge is active only inside a Herdr pane after Pi has restarted and the relay is running with `COLLIE_ACP=on`. Events emitted immediately at session startup are bounded and queued until the verified private-socket handshake completes, so the first interaction is not lost.

## Automatic Pi events

The bridge itself forwards:

- Pi lifecycle states as ACP `state_update` events (`running`, `idle`);
- tool execution start/end as ACP `tool_call_update` events;
- streamed assistant text and thinking deltas as ACP `agent_message_chunk` and `agent_thought_chunk` events.

Transcript tailing remains the durable replay source. Live chunks are best-effort and a reconnect should resume/replay the persisted transcript rather than assume every chunk was retained.

## Publish a custom notification

```ts
pi.events.emit("herdr-relay:publish", {
  namespace: "example.dev",
  name: "preview_ready",
  payload: {
    url: "https://preview.example.test"
  }
});
```

Constraints:

- `namespace` must be a reverse-domain name such as `example.dev`.
- `name` must match `[a-z][a-z0-9_-]{0,63}`.
- The relay forwards it to ACP clients as `_example.dev/preview_ready`.
- Clients that do not support the custom notification may ignore it.

## Request a remote approval

```ts
const requestId = crypto.randomUUID();

pi.events.emit("herdr-relay:request-permission", {
  requestId,
  title: "Deploy preview?",
  description: "Deploy the current branch to the preview environment.",
  options: [
    { optionId: "allow_once", name: "Deploy" },
    { optionId: "reject_once", name: "Cancel" }
  ]
});

const off = pi.events.on("herdr-relay:interaction-result", (event) => {
  if (event.requestId !== requestId) return;
  off();
  // event.outcome is the ACP client response.
});
```

The relay sends `session/request_permission` to every attached, write-authorized ACP client. The first authorized response wins. The request expires after five minutes or is cancelled if no authorized client is attached.

## Request user input

```ts
pi.events.emit("herdr-relay:request-elicitation", {
  requestId: crypto.randomUUID(),
  title: "Choose deployment environment",
  description: "Select the target environment.",
  schema: {
    properties: {
      environment: {
        type: "string",
        title: "Environment",
        enum: ["staging", "production"]
      }
    },
    required: ["environment"]
  }
});
```

The response arrives through the same `herdr-relay:interaction-result` event. Supported schema properties are bounded `string`, `number`, `integer`, and `boolean` fields; string fields may include a bounded `enum`. A bounded multi-select field is also supported as `type: "array"` with `items.type: "string"` and an `items.enum` or `items.oneOf` choice list. Array responses contain unique selected strings and obey `minItems`/`maxItems` (each at most 32). The relay validates the schema and response before sending/resolving an ACP form request.

## Security model

- The bridge never opens a network listener.
- It uses the relay's owner-only Unix socket.
- The relay validates the active Herdr pane, Pi identity, and native session reference before accepting hook traffic.
- Only remote ACP clients passing the relay's normal write authorization can resolve an interaction.
- The original extension owns the host-side action after it receives the result. The relay does not deploy, edit, or execute anything on its behalf.
