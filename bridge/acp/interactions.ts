import { isValidElicitationResponse, type ElicitationSchema } from "./elicitation.ts";
import type { AcpSocket } from "./types.ts";

type InteractionKind = "permission" | "elicitation";

type PendingInteraction = {
  id: string;
  sessionId: string;
  kind: InteractionKind;
  resolveHook: (outcome: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  schema?: ElicitationSchema;
  sockets: Set<AcpSocket>;
};

/** First-authorized-response-wins broker for native hook interactions. */
export class AcpInteractionBroker {
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(private readonly timeoutMs = 5 * 60_000) {}

  request(input: {
    sockets: AcpSocket[];
    sessionId: string;
    id: string;
    kind: InteractionKind;
    title: string;
    description?: string;
    options?: Array<{ optionId: string; name: string }>;
    schema?: ElicitationSchema;
    resolveHook: (outcome: unknown) => void;
    timeoutMs?: number;
  }): void {
    if (this.pending.has(input.id)) return;
    const timeoutMs = Math.min(this.timeoutMs, input.timeoutMs ?? this.timeoutMs);
    const expire = () => this.resolve(input.id, { outcome: "cancelled", reason: "timed_out" });
    const timer = setTimeout(expire, timeoutMs);
    timer.unref?.();
    this.pending.set(input.id, { id: input.id, sessionId: input.sessionId, kind: input.kind, resolveHook: input.resolveHook, timer, schema: input.schema, sockets: new Set(input.sockets) });
    const message = input.kind === "permission"
      ? {
          jsonrpc: "2.0",
          id: input.id,
          method: "session/request_permission",
          params: {
            sessionId: input.sessionId,
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            options: (input.options?.length ? input.options : [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject_once", name: "Deny", kind: "reject_once" },
            ]).map((option) => ({ ...option, kind: option.optionId.startsWith("allow") ? "allow_once" : "reject_once" })),
          },
        }
      : {
          jsonrpc: "2.0",
          id: input.id,
          method: "elicitation/create",
          params: {
            sessionId: input.sessionId,
            mode: "form",
            message: input.description ?? input.title,
            requestedSchema: { type: "object", properties: input.schema?.properties ?? {}, ...(input.schema?.required?.length ? { required: input.schema.required } : {}) },
            _meta: { "herdr.dev": { interactionId: input.id, title: input.title } },
          },
        };
    for (const socket of input.sockets) socket.send(JSON.stringify(message));
  }

  resolve(id: string, outcome: unknown): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    // Do not let a malformed client response consume a local interaction. This makes the policy
    // genuinely first-*valid*-authorized-response-wins for form elicitations.
    if (pending.kind === "elicitation" && !isValidElicitationResponse(pending.schema, outcome)) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolveHook(outcome);
    return true;
  }

  /** Remove a disconnected client; cancel only when no eligible recipient remains. */
  closeSocket(socket: AcpSocket): void {
    for (const [id, pending] of this.pending) {
      pending.sockets.delete(socket);
      if (pending.sockets.size === 0) this.resolve(id, { outcome: "cancelled", reason: "all_clients_disconnected" });
    }
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolveHook({ outcome: "cancelled", reason: "connection_closed" });
    }
    this.pending.clear();
  }
}
