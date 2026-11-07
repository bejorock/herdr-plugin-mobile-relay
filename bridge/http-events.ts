import { randomUUID } from "node:crypto";
import { LifecycleError } from "./agents/conversations.ts";

export interface SseWriter { send(event: string, data: unknown, id?: string): boolean; close(): void; onClose(fn: () => void): void }

/** Bounded HTTP SSE lifetime, subscriber count and queue. No arbitrary transport framework. */
export class HttpStreams {
  private readonly active = new Map<SseWriter, string>();
  open(req: Request, resource: string, start: (writer: SseWriter) => void): Response {
    if (this.active.size >= 64 || [...this.active.values()].filter((key) => key === resource).length >= 8) throw new LifecycleError(429, "stream_capacity", "Too many active streams");
    const encoder = new TextEncoder();
    let writer!: SseWriter;
    let done = false;
    let heartbeat: ReturnType<typeof setInterval>;
    let expiry: ReturnType<typeof setTimeout>;
    const callbacks: Array<() => void> = [];
    const abort = () => writer?.close();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = () => {
          if (done) return;
          done = true; clearInterval(heartbeat); clearTimeout(expiry);
          req.signal.removeEventListener("abort", abort);
          this.active.delete(writer);
          for (const fn of callbacks) fn();
          try { controller.close(); } catch {}
        };
        const enqueue = (text: string) => {
          if (done) return false;
          const bytes = encoder.encode(text);
          if (bytes.byteLength > 600 * 1024 || (controller.desiredSize ?? 0) < bytes.byteLength) { close(); return false; }
          controller.enqueue(bytes); return true;
        };
        writer = {
          send: (event, data, id) => enqueue(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          close,
          onClose: (fn) => { if (done) fn(); else callbacks.push(fn); },
        };
        this.active.set(writer, resource);
        heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000); heartbeat.unref();
        expiry = setTimeout(close, 5 * 60_000); expiry.unref();
        req.signal.addEventListener("abort", abort, { once: true });
        if (req.signal.aborted) { close(); return; }
        try { start(writer); } catch { writer.send("stream.error", { code: "stream_failed", message: "Event stream failed" }); close(); }
      },
      cancel: () => writer.close(),
    }, { highWaterMark: 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }
  close(): void { for (const writer of [...this.active.keys()]) writer.close(); }
}

interface EventRecord { seq: number; event: string; data: unknown }
interface RuntimeEvents { seq: number; ring: EventRecord[]; listeners: Set<(event: EventRecord) => void>; healthy: boolean }
const SAFE_FIELDS = new Set(["pane_id", "workspace_id", "tab_id", "previous_pane_id", "previous_workspace_id", "previous_tab_id", "agent", "agent_status", "status", "name", "label", "revision", "focused", "completion_seq", "state_change_seq", "exit_status", "exit_code", "signal"]);
function safeData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (["pane", "agent_info", "workspace", "tab"].includes(key)) result[key] = safeData(entry);
    else if (SAFE_FIELDS.has(key) && (typeof entry === "boolean" || typeof entry === "number" || entry === null || (typeof entry === "string" && entry.length <= 512))) result[key] = entry;
  }
  return result;
}
/** Relay-local reconnect ring, not durable Herdr history. */
export class HerdrEventHub {
  private readonly epoch = randomUUID();
  private readonly runtimes = new Map<string, RuntimeEvents>();
  private runtime(session: string): RuntimeEvents {
    let value = this.runtimes.get(session);
    if (!value) { value = { seq: 0, ring: [], listeners: new Set(), healthy: false }; this.runtimes.set(session, value); }
    return value;
  }
  private publish(session: string, event: string, data: unknown): void {
    const runtime = this.runtime(session);
    const entry = { seq: ++runtime.seq, event, data };
    runtime.ring.push(entry); if (runtime.ring.length > 256) runtime.ring.shift();
    for (const listener of runtime.listeners) listener(entry);
  }
  event(session: string, event: string, data: unknown): void { this.publish(session, "herdr.event", { session, event, data: safeData(data) }); }
  health(session: string, live: boolean): void {
    this.runtime(session).healthy = live;
    this.publish(session, "source.status", { session, live });
    this.resync(session, live ? "upstream_connected" : "upstream_disconnected");
  }
  resync(session: string, reason: string): void { this.publish(session, "resync.required", { session, reason }); }
  subscribe(session: string, writer: SseWriter, cursor?: string): void {
    const runtime = this.runtime(session);
    const emit = (entry: EventRecord) => writer.send(entry.event, entry.data, `${this.epoch}:${Buffer.from(session).toString("base64url")}:${entry.seq}`);
    // Subscription and initial ring read are synchronous: no gap between them.
    runtime.listeners.add(emit);
    writer.onClose(() => runtime.listeners.delete(emit));
    const prefix = `${this.epoch}:${Buffer.from(session).toString("base64url")}:`;
    const sequence = cursor?.startsWith(prefix) && /^\d+$/.test(cursor.slice(prefix.length)) ? Number(cursor.slice(prefix.length)) : NaN;
    if (Number.isSafeInteger(sequence) && sequence <= runtime.seq && sequence >= (runtime.ring[0]?.seq ?? 1) - 1) {
      for (const entry of runtime.ring) if (entry.seq > sequence) emit(entry);
    } else {
      writer.send("source.status", { session, live: runtime.healthy });
      emit({ seq: runtime.seq, event: "resync.required", data: { session, reason: cursor ? "cursor_unavailable" : "initial_subscription" } });
    }
  }
}
