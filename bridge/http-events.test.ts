import { describe, expect, test } from "bun:test";
import { HerdrEventHub, HttpStreams, type SseWriter } from "./http-events.ts";
class Writer implements SseWriter {
  events: Array<{ event: string; data: unknown; id?: string }> = [];
  callbacks: Array<() => void> = [];
  send(event: string, data: unknown, id?: string) { this.events.push({ event, data, id }); return true; }
  onClose(fn: () => void) { this.callbacks.push(fn); }
  close() { for (const fn of this.callbacks) fn(); }
}
describe("Herdr HTTP event delivery", () => {
  test("scopes runtime events, projects private metadata out, signals resync", () => {
    const hub = new HerdrEventHub(); const writer = new Writer(); hub.subscribe("default", writer);
    expect(writer.events.at(-1)).toMatchObject({ event: "resync.required", data: { reason: "initial_subscription" } });
    hub.event("other", "pane.created", { pane_id: "other" });
    hub.event("default", "pane.created", { pane: { pane_id: "p1", agent_session: { value: "/private" }, cwd: "/private", agent_status: "idle" }, token: "secret" });
    expect(writer.events.at(-1)).toMatchObject({ event: "herdr.event", data: { session: "default", event: "pane.created", data: { pane: { pane_id: "p1", agent_status: "idle" } } } });
    expect(JSON.stringify(writer.events)).not.toContain("/private"); expect(JSON.stringify(writer.events)).not.toContain("secret");
    writer.close(); const length = writer.events.length; hub.health("default", false); expect(writer.events).toHaveLength(length);
  });
  test("replays only retained relay ring, resyncs expired/wrong-runtime/restarted cursors", () => {
    const hub = new HerdrEventHub(); const first = new Writer(); hub.subscribe("default", first);
    hub.event("default", "pane.created", { pane_id: "p1" }); const cursor = first.events.at(-1)!.id!; first.close();
    hub.event("default", "pane.closed", { pane_id: "p1" });
    const second = new Writer(); hub.subscribe("default", second, cursor);
    expect(second.events).toHaveLength(1); expect(second.events[0]?.event).toBe("herdr.event");
    const other = new Writer(); hub.subscribe("other", other, cursor); expect(other.events.at(-1)?.event).toBe("resync.required");
    for (let i = 0; i < 300; i++) hub.event("default", "pane.created", { pane_id: `p${i}` });
    const expired = new Writer(); hub.subscribe("default", expired, cursor); expect(expired.events.at(-1)).toMatchObject({ event: "resync.required", data: { reason: "cursor_unavailable" } });
    const restart = new Writer(); new HerdrEventHub().subscribe("default", restart, cursor); expect(restart.events.at(-1)?.event).toBe("resync.required");
  });
  test("HTTP streams release slots on cancel/abort and enforce per-resource cap", async () => {
    const streams = new HttpStreams(); const abort = new AbortController();
    const response = streams.open(new Request("http://localhost/api/events", { signal: abort.signal }), "one", (writer) => writer.send("ready", { ok: true }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    abort.abort(); expect((await reader.read()).done).toBe(true);
    const responses = Array.from({ length: 8 }, () => streams.open(new Request("http://localhost/events"), "two", () => {}));
    expect(() => streams.open(new Request("http://localhost/events"), "two", () => {})).toThrow("Too many active streams");
    await responses[0]!.body!.cancel();
    streams.open(new Request("http://localhost/events"), "two", () => {});
    streams.close();
  });
  test("slow readers close rather than grow an unbounded queue", async () => {
    const streams = new HttpStreams(); let closed = false;
    const response = streams.open(new Request("http://localhost/events"), "one", (writer) => {
      writer.onClose(() => { closed = true; });
      for (let i = 0; i < 10; i++) writer.send("batch", { value: "x".repeat(400 * 1024) });
    });
    expect(closed).toBe(true); await response.body!.cancel(); streams.close();
  });
});
