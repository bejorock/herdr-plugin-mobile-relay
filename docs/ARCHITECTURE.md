# Lean relay architecture

## Active services

One Bun process binds IPv4 loopback. It owns the HTTP routes and optional `/api/live` terminal WebSocket. Each discovered Herdr runtime has a socket client, a snapshot state engine and an event subscription. Events invalidate cached state; snapshots reconcile it. Client-provided runtime names are registry keys, never socket paths.

Herdr remains responsible for terminals, workspace/tab/pane identity, lifecycle and reported agent status. The relay retains its current management routes rather than introducing a second conversation protocol. Not every Herdr socket operation is publicly exposed; extending that coverage is separate work.

Security includes Host/Origin validation, proxy identity policies, optional device write allowlists, private filesystem storage, bounded bodies, mutation serialization/deduplication and write audit logs. Delivery-ambiguous errors are not safe to retry blindly.

## Separate data purposes

- Terminal frames reproduce the Herdr pane and use the existing terminal WebSocket.
- Native transcripts contain conversation/tool records for client-owned native rendering.
- Actionable requests represent real pending questions/permissions, including integrated extension/workflow requests that might never enter a transcript.

The pruning baseline exposes only the first publicly. It retains safe native adapter foundations under `bridge/agents/`, but does not instantiate their listener, publish agent events, install hooks, or expose transcript/response endpoints. There is no replacement conversation protocol hidden behind the removal of ACP.

## Retained agent foundations

- Pi transcript root/path/size guards, JSONL parsing and active-branch selection.
- Claude exact native-UUID transcript discovery and safe parsing.
- Native private binding storage (not loaded by the active server).
- Owner-only local hook protocol with exact Herdr/native binding checks.
- Transport-neutral interaction broker: pending requests, validated one-shot responses, expiry and cancellation. Authorization belongs to the future HTTP boundary.

The binding identifier is internal and pane-scoped; it does not claim durable public conversation identity. The previous ACP binding file is not automatically migrated or erased.

## Next design step (not implemented here)

Agree a small HTTP contract for transcript reads and actionable events/responses. Clients own rendering and whether to associate an event with a transcript tool call. Adapters must forward actual pending requests and route replies to the originating callback, not infer approvals from historical tool names. Nested workflow/subagent support requires explicit parent forwarding or an authenticated native adapter; it is not automatic.

No PWA, browser push service, notification preferences/snooze, remote model probes, or ACP lifecycle dispatcher remains in the active process. Existing deployment/user data is not deleted during source cleanup.
