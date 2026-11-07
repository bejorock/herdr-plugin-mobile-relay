// Relay-owned native interaction bridge. No status/token/tool observers and no ACP.
// Intentionally depends only on Node builtins; Pi supplies the extension runtime.
import { createConnection, type Socket } from "node:net";

type Pi = { on(name: string, handler: (...args: any[]) => unknown): void; events: { on(name: string, handler: (value: any) => void): unknown; emit(name: string, value: unknown): void } };
export default function interactions(pi: Pi) {
  let socket: Socket | undefined;
  let ready = false;
  let nativePath = "";
  let sequence = 0;
  let buffer = "";
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let sessionContext: any;
  const pending = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const result = (id: string, outcome: unknown) => {
    if (!pending.delete(id)) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    pi.events.emit("herdr-relay:interaction-result", { requestId: id, outcome });
  };
  const stop = () => {
    clearTimeout(reconnect); reconnect = undefined;
    ready = false;
    const old = socket; socket = undefined; old?.destroy(); buffer = "";
    for (const id of [...pending]) result(id, { outcome: "cancelled", reason: "bridge_disconnected" });
  };
  const send = (event: unknown) => {
    if (!ready || !socket || socket.destroyed) return false;
    const data = JSON.stringify({ version: 1, type: "event", eventId: `pi:${++sequence}`, sequence, event }) + "\n";
    if (Buffer.byteLength(data) > 64 * 1024) return false;
    socket.write(data); return true;
  };
  const connect = (ctx: any) => {
    const file = ctx?.sessionManager?.getSessionFile?.();
    const path = process.env.HERDR_RELAY_HOOK_SOCKET;
    if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !path || typeof file !== "string") return;
    if (nativePath === file && socket && !socket.destroyed) return;
    stop(); nativePath = file;
    const current = createConnection(path); socket = current;
    current.setTimeout(5000, () => current.destroy());
    current.on("connect", () => current.write(JSON.stringify({ version: 1, type: "hello", adapter: { kind: "pi", name: "herdr-relay", version: "2" }, binding: {
      herdrSession: process.env.HERDR_SESSION || "default", paneId: process.env.HERDR_PANE_ID, agent: "pi", nativeSession: { source: "herdr:pi", agent: "pi", kind: "path", value: file },
    } }) + "\n"));
    current.on("data", (data) => {
      if (socket !== current) return;
      buffer += data.toString("utf8");
      if (Buffer.byteLength(buffer) > 64 * 1024) { current.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === "hello_ack") { ready = true; current.setTimeout(0); }
          if (value.type === "command" && value.command?.kind === "interaction.resolve") result(value.command.interactionId, value.command.outcome);
        } catch { current.destroy(); }
      }
    });
    current.on("error", () => {});
    current.on("close", () => {
      if (socket !== current) return;
      stop();
      if (sessionContext) reconnect = setTimeout(() => connect(sessionContext), 1000);
    });
  };
  const request = (kind: "permission" | "elicitation", value: any) => {
    if (!value || typeof value.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId) || pending.has(value.requestId)) return;
    if (pending.size >= 64) { pi.events.emit("herdr-relay:interaction-result", { requestId: value.requestId, outcome: { outcome: "cancelled", reason: "capacity_exceeded" } }); return; }
    pending.add(value.requestId);
    const event = { kind: "interaction.request", interactionId: value.requestId, interactionKind: kind, title: value.title, description: value.description,
      options: value.options, schema: value.schema, toolCallId: value.toolCallId, parentToolCallId: value.parentToolCallId, executionId: value.executionId,
      timeoutMs: 225000 };
    if (!send(event)) { result(value.requestId, { outcome: "cancelled", reason: "bridge_unavailable" }); return; }
    timers.set(value.requestId, setTimeout(() => { send({ kind: "interaction.cancel", interactionId: value.requestId }); result(value.requestId, { outcome: "cancelled", reason: "timed_out" }); }, 230000));
  };
  pi.events.on("herdr-relay:request-permission", (value) => request("permission", value));
  pi.events.on("herdr-relay:request-elicitation", (value) => request("elicitation", value));
  pi.events.on("herdr-relay:cancel-interaction", (value) => {
    if (!pending.has(value?.requestId)) return;
    send({ kind: "interaction.cancel", interactionId: value.requestId }); result(value.requestId, { outcome: "cancelled", reason: "owner_cancelled" });
  });
  pi.on("session_start", (_event, ctx) => { sessionContext = ctx; connect(ctx); });
  pi.on("input", (_event, ctx) => { sessionContext = ctx; connect(ctx); });
  pi.on("session_shutdown", () => { sessionContext = undefined; stop(); });
}
