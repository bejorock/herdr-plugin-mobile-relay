import { randomUUID } from "node:crypto";
import { ConversationService, LifecycleError } from "./conversations.ts";
import type { HookBinding, HookEvent } from "./hook.ts";
import { InteractionBroker, type InteractionRequest } from "./interactions.ts";
import { publicTranscriptContent } from "./transcripts.ts";
import type { HerdrEventHub } from "../http-events.ts";

export interface PublicInteraction extends Omit<InteractionRequest, "sessionId"> {
  conversationId: string; session: string; agent: string; expiresAt: number;
  toolCallId?: string; parentToolCallId?: string; executionId?: string;
  plan?: { planId: string; content: string };
}
type Pending = { item: PublicInteraction; binding: HookBinding; nativeId: string };
/** Native wait ownership; public IDs never double as tool/session or callback IDs. */
export class InteractionService {
  private readonly broker = new InteractionBroker();
  private readonly pending = new Map<string, Pending>();
  private readonly responding = new Set<string>();
  private stopped = false;
  constructor(private readonly conversations: ConversationService, private readonly events: HerdrEventHub) {}
  async request(binding: HookBinding, event: Extract<HookEvent["event"], { kind: "interaction.request" }>, resolve: (response: unknown) => void): Promise<void> {
    const cancelled = (reason: string) => resolve({ outcome: "cancelled", reason });
    if (this.stopped || !binding.ownerId || !binding.connected?.()) { cancelled("owner_disconnected"); return; }
    if ([...this.pending.values()].some((p) => p.binding.ownerId === binding.ownerId && p.nativeId === event.interactionId)) return;
    if (this.pending.size >= 256) { cancelled("capacity_exceeded"); return; }
    let conversation;
    try { conversation = await this.conversations.attachNative(binding.herdrSession, binding.paneId, binding.agent, binding.nativeSession); }
    catch { cancelled("native_identity_unavailable"); return; }
    if (this.stopped || !binding.connected()) { cancelled("owner_disconnected"); return; }
    if ([...this.pending.values()].some((p) => p.binding.ownerId === binding.ownerId && p.nativeId === event.interactionId)) return;
    if (this.pending.size >= 256) { cancelled("capacity_exceeded"); return; }
    const safe = publicTranscriptContent({ title: event.title, description: event.description, options: event.options, schema: event.schema, plan: event.plan }, binding.nativeSession.value) as Pick<PublicInteraction, "title" | "description" | "options" | "schema" | "plan">;
    // Options/schema are protocol data too: IDs and enum values must retain their exact values.
    // Reject credential/path transformations inside schemas rather than misrouting modified answers.
    if (JSON.stringify(safe.options) !== JSON.stringify(event.options) || JSON.stringify(safe.schema) !== JSON.stringify(event.schema)) { cancelled("unsafe_response_schema"); return; }
    const id = `interaction_${randomUUID()}`;
    const timeoutMs = Math.min(300_000, event.timeoutMs ?? 225_000);
    const item: PublicInteraction = { id, conversationId: conversation.id, session: binding.herdrSession, agent: binding.agent,
      kind: event.interactionKind, ...safe, expiresAt: Date.now() + timeoutMs,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}), ...(event.executionId ? { executionId: event.executionId } : {}),
    };
    if (item.kind === "permission" && !item.options?.length) { cancelled("missing_options"); return; }
    this.pending.set(id, { item, binding, nativeId: event.interactionId });
    this.broker.request({ id, sessionId: conversation.id, kind: item.kind, title: item.title, options: item.options, schema: item.schema, timeoutMs,
      resolveHook: (response) => {
        this.pending.delete(id);
        const reason = response && typeof response === "object" && "reason" in response ? String(response.reason) : "answered";
        const eventName = reason === "timed_out" ? "interaction.expired" : reason === "answered" ? "interaction.resolved" : "interaction.cancelled";
        this.events.interaction(item.session, eventName, { session: item.session, conversationId: item.conversationId, id, reason });
        resolve(response);
      },
    });
    this.events.interaction(item.session, "interaction.requested", { interaction: item });
  }
  async sweep(): Promise<void> {
    for (const [id, pending] of [...this.pending]) {
      try {
        if (!pending.binding.connected?.()) throw new Error();
        await this.conversations.verifyNative(pending.binding.herdrSession, pending.binding.paneId, pending.binding.agent, pending.binding.nativeSession);
      } catch { if (this.pending.get(id) === pending) this.broker.cancel(id, "native_identity_unavailable"); }
    }
  }
  list(session?: string, conversationId?: string): { session: string; interactions: PublicInteraction[] } {
    const runtime = this.conversations.runtime(session);
    return { session: runtime.name, interactions: structuredClone([...this.pending.values()].filter((p) => p.item.session === runtime.name && (!conversationId || p.item.conversationId === conversationId)).map((p) => p.item)) };
  }
  async respond(id: string, response: unknown, session?: string): Promise<{ ok: true }> {
    const pending = this.pending.get(id);
    if (!pending || (session !== undefined && pending.item.session !== session)) throw new LifecycleError(404, "interaction_unknown", "Unknown or no longer pending interaction");
    if (this.responding.has(id)) throw new LifecycleError(409, "interaction_busy", "Another response is being validated");
    this.responding.add(id);
    try {
      if (!pending.binding.connected?.() || pending.item.expiresAt <= Date.now()) { this.broker.cancel(id, "owner_disconnected"); throw new LifecycleError(409, "interaction_stale", "Native request is no longer waiting"); }
      try { await this.conversations.verifyNative(pending.binding.herdrSession, pending.binding.paneId, pending.binding.agent, pending.binding.nativeSession); }
      catch { this.broker.cancel(id, "native_identity_changed"); throw new LifecycleError(409, "interaction_stale", "Native requester is unavailable or changed"); }
      if (this.pending.get(id) !== pending || !pending.binding.connected?.()) throw new LifecycleError(409, "interaction_stale", "Native request is no longer waiting");
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new LifecycleError(400, "invalid_response", "Invalid interaction response");
      const keys = Object.keys(response);
      const answer = response as { action?: string; content?: unknown };
      if (keys.some((key) => !(pending.item.kind === "permission" ? ["optionId"] : ["action", "content"]).includes(key)) ||
          (pending.item.kind === "elicitation" && answer.action !== "accept" && Object.hasOwn(response, "content")) || !this.broker.resolve(id, response)) {
        throw new LifecycleError(400, "invalid_response", "Response does not match the pending request");
      }
      return { ok: true };
    } finally { this.responding.delete(id); }
  }
  cancelNative(binding: HookBinding, nativeId: string): void {
    for (const [id, p] of this.pending) if (p.binding.ownerId === binding.ownerId && p.nativeId === nativeId) this.broker.cancel(id, "owner_cancelled");
  }
  closeOwner(binding: HookBinding): void {
    for (const [id, p] of this.pending) if (p.binding.ownerId === binding.ownerId) this.broker.cancel(id, "owner_disconnected");
  }
  close(): void { this.stopped = true; this.broker.close(); }
}
