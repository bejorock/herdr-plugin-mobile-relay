# Lean relay architecture

## Active services

One Bun process binds IPv4 loopback. It owns the HTTP routes and optional `/api/live` terminal WebSocket. Each discovered Herdr runtime has a socket client, a snapshot state engine and an event subscription. Events invalidate cached state; snapshots reconcile it. Client-provided runtime names are registry keys, never socket paths.

Herdr remains responsible for terminals, workspace/tab/pane identity, lifecycle and reported agent status. The relay retains its current management routes rather than introducing a second conversation protocol. Not every Herdr socket operation is publicly exposed; extending that coverage is separate work.

Security includes Host/Origin validation, proxy identity policies, optional device write allowlists, private filesystem storage, bounded bodies, mutation serialization/deduplication and write audit logs. Delivery-ambiguous errors are not safe to retry blindly.

## Separate data purposes

- Terminal frames reproduce the Herdr pane and use the existing terminal WebSocket.
- Native transcripts contain conversation/tool records for client-owned native rendering.
- Actionable requests represent real pending questions/permissions, including integrated extension/workflow requests that might never enter a transcript.

Terminal and transcript channels are public, along with selected Herdr event delivery; see [HTTP streams](HTTP_STREAMS.md). HTTP discovery and conversation create/read/resume are implemented separately; see [HTTP lifecycle](HTTP_LIFECYCLE.md). Native interaction services under `bridge/agents/` instantiate an owner-only hook listener, publish actionable events and expose pending/response HTTP endpoints. Pi/Claude adapter installation is explicit; see [HTTP interactions](HTTP_INTERACTIONS.md). There is no ACP negotiation or replacement general agent protocol.

## Retained agent foundations

- Pi transcript root/path/size guards, JSONL parsing and active-branch selection.
- Claude exact native-UUID transcript discovery and safe parsing.
- Legacy private binding-storage foundation (inactive), plus a separate active conversation journal (`conversations.json`) for the HTTP lifecycle.
- Owner-only local hook protocol with exact Herdr/native binding checks.
- Transport-neutral interaction broker: pending requests, validated one-shot responses, expiry and cancellation. Authorization belongs to the future HTTP boundary.

The old hook binding identifier remains internal and pane-scoped. HTTP lifecycle IDs are independently random and persisted with native identity and replaceable live attachment. The previous ACP binding file is not automatically migrated or erased. Interrupted initial creation without saved native identity fails closed; native restoration with saved identity can reconcile a lost acknowledgement. No public attach-existing operation is implemented yet.

## Agreed revamp (not implemented here)

See [Lean Relay Revamp](LEAN_RELAY_REVAMP.md) for the agreed boundaries, injected Pi/Claude integration changes, nested-request strategy, implementation increments and acceptance criteria. It separates transcript delivery from live actionable events and leaves rendering/correlation policy to clients.

HTTP transcripts, Herdr events and the first native interaction/adapter increment are implemented. Owner-configured Linux folder operations are implemented ([directory contract](HTTP_DIRECTORIES.md)); macOS folder support and discovery executable verification remain pending; public attach-existing is pending even though hook registration can privately attach a proven live conversation. Clients own rendering and whether to associate an event with a transcript tool call. Adapters must forward actual pending requests and route replies to the originating callback, not infer approvals from historical tool names. Nested workflow/subagent support requires explicit parent forwarding or an authenticated native adapter; it is not automatic.

No PWA, browser push service, notification preferences/snooze, remote model probes, or ACP lifecycle dispatcher remains in the active process. Existing deployment/user data is not deleted during source cleanup.
