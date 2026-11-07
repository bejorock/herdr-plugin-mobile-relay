import { isValidElicitationResponse, type ElicitationSchema } from "./elicitation.ts";

export interface InteractionRequest {
  id: string;
  sessionId: string;
  kind: "permission" | "elicitation";
  title: string;
  description?: string;
  options?: Array<{ optionId: string; name: string }>;
  schema?: ElicitationSchema;
}
type Pending = { request: InteractionRequest; resolve: (outcome: unknown) => void; timer: ReturnType<typeof setTimeout> };

/** Internal native-request routing only. No network protocol or rendering policy. */
export class InteractionBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly timeoutMs = 5 * 60_000) {}

  request(input: InteractionRequest & { resolveHook: (outcome: unknown) => void; timeoutMs?: number }): boolean {
    if (this.pending.has(input.id)) return false;
    const { resolveHook, timeoutMs, ...request } = input;
    const timer = setTimeout(() => this.finish(input.id, { outcome: "cancelled", reason: "timed_out" }), Math.min(this.timeoutMs, timeoutMs ?? this.timeoutMs));
    timer.unref?.();
    this.pending.set(input.id, { request, resolve: resolveHook, timer });
    return true;
  }
  list(): InteractionRequest[] { return structuredClone([...this.pending.values()].map((entry) => entry.request)); }
  resolve(id: string, outcome: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (entry.request.kind === "elicitation" && !isValidElicitationResponse(entry.request.schema, outcome)) return false;
    if (entry.request.kind === "permission") {
      if (typeof outcome !== "object" || outcome === null || !("optionId" in outcome) ||
          !(entry.request.options ?? []).some((option) => option.optionId === outcome.optionId)) return false;
    }
    return this.finish(id, outcome);
  }
  private finish(id: string, outcome: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    return true;
  }
  close(): void {
    for (const id of this.pending.keys()) this.finish(id, { outcome: "cancelled", reason: "connection_closed" });
  }
}
