import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type { SessionRegistry } from "../sessions.ts";
import { isValidElicitationSchema, type ElicitationSchema } from "./elicitation.ts";
import { acpSessionIdFor } from "./session-registry.ts";

export const HOOK_SOCKET_NAME = "agent-hook.sock";
export const MAX_HOOK_FRAME_BYTES = 64 * 1024;

type NativeSession = { source: string; agent: string; kind: "id" | "path"; value: string };

export interface HookHello {
  version: 1;
  type: "hello";
  adapter: { kind: string; name: string; version: string };
  binding: {
    herdrSession: string;
    paneId: string;
    agent: string;
    nativeSession: NativeSession;
    /** Claude exposes its transcript separately while Herdr currently identifies its session by ID. */
    transcriptPath?: string;
  };
  capabilities?: Record<string, boolean>;
}

export interface HookEvent {
  version: 1;
  type: "event";
  eventId: string;
  sequence: number;
  event:
    | {
        kind: "agent.state";
        state: "running" | "idle" | "requires_action";
      }
    | {
        kind: "tool.update";
        toolCallId: string;
        toolName: string;
        status: "in_progress" | "completed" | "failed" | "cancelled";
        title?: string;
        error?: string;
      }
    | {
        kind: "message.delta";
        messageId: string;
        channel: "assistant" | "thought";
        delta: string;
      }
    | {
        kind: "interaction.request";
        interactionId: string;
        interactionKind: "permission" | "elicitation";
        title: string;
        description?: string;
        options?: Array<{ optionId: string; name: string }>;
        schema?: ElicitationSchema;
        timeoutMs?: number;
        plan?: { planId: string; content: string };
      }
    | {
        kind: "custom.notification";
        namespace: string;
        name: string;
        payload?: unknown;
      };
}

export interface HookBinding {
  acpSessionId: string;
  agent: string;
  herdrSession: string;
  paneId: string;
  transcriptPath?: string;
}

export interface HookEventSink {
  /** Called only after the adapter binding exactly matches live Herdr native-session state. */
  bind?(binding: HookBinding): void;
  publish(binding: HookBinding, event: HookEvent["event"]): void;
  interaction?(binding: HookBinding, event: Extract<HookEvent["event"], { kind: "interaction.request" }>, resolve: (outcome: unknown) => void): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeSession(value: unknown): value is NativeSession {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.agent === "string" &&
    (value.kind === "id" || value.kind === "path") &&
    typeof value.value === "string"
  );
}

/** Validate the tiny public custom-event envelope before a hook connection can publish it. */
export function parseHookEvent(value: unknown): HookEvent | null {
  if (!isRecord(value) || value.version !== 1 || value.type !== "event") return null;
  if (typeof value.eventId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.eventId)) return null;
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
  if (!isRecord(value.event)) return null;
  if (value.event.kind === "agent.state") {
    if (value.event.state !== "running" && value.event.state !== "idle" && value.event.state !== "requires_action") return null;
    return value as unknown as HookEvent;
  }
  if (value.event.kind === "message.delta") {
    if (
      typeof value.event.messageId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.event.messageId) ||
      (value.event.channel !== "assistant" && value.event.channel !== "thought") ||
      typeof value.event.delta !== "string" || value.event.delta.length === 0 || value.event.delta.length > 65_536
    ) return null;
    return value as unknown as HookEvent;
  }
  if (value.event.kind === "interaction.request") {
    if (
      typeof value.event.interactionId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.event.interactionId) ||
      (value.event.interactionKind !== "permission" && value.event.interactionKind !== "elicitation") ||
      typeof value.event.title !== "string" || value.event.title.length === 0 || value.event.title.length > 512 ||
      (value.event.description !== undefined && (typeof value.event.description !== "string" || value.event.description.length > 2048)) ||
      (value.event.options !== undefined && (!Array.isArray(value.event.options) || value.event.options.length > 16 || !value.event.options.every((option) => isRecord(option) && typeof option.optionId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(option.optionId) && typeof option.name === "string" && option.name.length > 0 && option.name.length <= 128))) ||
      !isValidElicitationSchema(value.event.schema) ||
      (value.event.timeoutMs !== undefined && (typeof value.event.timeoutMs !== "number" || !Number.isSafeInteger(value.event.timeoutMs) || value.event.timeoutMs < 1_000 || value.event.timeoutMs > 300_000)) ||
      (value.event.plan !== undefined && (!isRecord(value.event.plan) || typeof value.event.plan.planId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.event.plan.planId) || typeof value.event.plan.content !== "string" || value.event.plan.content.length === 0 || value.event.plan.content.length > 48_000))
    ) return null;
    return value as unknown as HookEvent;
  }
  if (value.event.kind === "tool.update") {
    if (
      typeof value.event.toolCallId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.event.toolCallId) ||
      typeof value.event.toolName !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value.event.toolName) ||
      (value.event.status !== "in_progress" && value.event.status !== "completed" && value.event.status !== "failed" && value.event.status !== "cancelled") ||
      (value.event.title !== undefined && (typeof value.event.title !== "string" || value.event.title.length > 512)) ||
      (value.event.error !== undefined && (typeof value.event.error !== "string" || value.event.error.length > 2048))
    ) return null;
    return value as unknown as HookEvent;
  }
  if (value.event.kind !== "custom.notification") return null;
  if (
    typeof value.event.namespace !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value.event.namespace) ||
    typeof value.event.name !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value.event.name)
  ) return null;
  return value as unknown as HookEvent;
}

/**
 * Bind an extension to exactly one currently-running Herdr agent pane. Matching the existing
 * Herdr-reported native session prevents a local extension from claiming another terminal merely
 * by supplying its pane ID.
 */
export function resolveHookHello(registry: SessionRegistry, value: unknown): HookBinding | null {
  if (!isRecord(value) || value.version !== 1 || value.type !== "hello") return null;
  if (!isRecord(value.adapter) || typeof value.adapter.kind !== "string" || typeof value.adapter.name !== "string" || typeof value.adapter.version !== "string") return null;
  if (!isRecord(value.binding) || typeof value.binding.herdrSession !== "string" || typeof value.binding.paneId !== "string" || typeof value.binding.agent !== "string" || !isNativeSession(value.binding.nativeSession) || (value.binding.transcriptPath !== undefined && (typeof value.binding.transcriptPath !== "string" || value.binding.transcriptPath.length === 0 || value.binding.transcriptPath.length > 4096))) return null;
  const binding = {
    herdrSession: value.binding.herdrSession,
    paneId: value.binding.paneId,
    agent: value.binding.agent,
    nativeSession: value.binding.nativeSession,
  };
  const runtime = registry.get(binding.herdrSession);
  if (!runtime || runtime.engine.current().bridge !== "connected") return null;
  const pane = runtime.engine.current().agents.find((candidate) => candidate.paneId === binding.paneId);
  const native = pane?.nativeSession;
  if (!pane || pane.agent !== binding.agent || !native) return null;
  if (
    native.source !== binding.nativeSession.source ||
    native.agent !== binding.nativeSession.agent ||
    native.kind !== binding.nativeSession.kind ||
    native.value !== binding.nativeSession.value
  ) return null;
  return {
    acpSessionId: acpSessionIdFor({
      herdrSession: runtime.name,
      paneId: pane.paneId,
      agent: pane.agent,
      nativeSource: native.source,
      nativeValue: native.value,
    }),
    agent: pane.agent,
    herdrSession: runtime.name,
    paneId: pane.paneId,
    ...(typeof value.binding.transcriptPath === "string" ? { transcriptPath: value.binding.transcriptPath } : {}),
  };
}

/** Owner-only newline JSON hook listener. Hooks are best-effort clients: a bad hook is disconnected. */
export class AgentHookServer {
  private server: Server | null = null;
  private readonly socketPath: string;

  constructor(
    stateDir: string,
    private readonly registry: SessionRegistry,
    private readonly sink: HookEventSink,
  ) {
    this.socketPath = join(stateDir, HOOK_SOCKET_NAME);
  }

  get path(): string {
    return this.socketPath;
  }

  async start(): Promise<void> {
    try {
      const existing = await lstat(this.socketPath);
      if (!existing.isSocket()) throw new Error(`refusing to replace non-socket hook path: ${this.socketPath}`);
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const existing = await lstat(this.socketPath);
      if (existing.isSocket()) await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private accept(socket: Socket): void {
    let buffer = "";
    let binding: HookBinding | null = null;
    let highestSequence = -1;
    const eventIds = new Set<string>();
    const close = () => socket.destroy();
    socket.setTimeout(5_000, close);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_HOOK_FRAME_BYTES) return close();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return close();
        }
        if (!binding) {
          binding = resolveHookHello(this.registry, value);
          if (!binding) return close();
          this.sink.bind?.(binding);
          // The short timeout is only a handshake deadline. A verified hook is a deliberately
          // persistent local connection, so it must not be killed merely for being idle.
          socket.setTimeout(0);
          socket.write(`${JSON.stringify({ version: 1, type: "hello_ack", acpSessionId: binding.acpSessionId })}\n`);
          continue;
        }
        const event = parseHookEvent(value);
        if (!event || event.sequence <= highestSequence || eventIds.has(event.eventId)) return close();
        highestSequence = event.sequence;
        eventIds.add(event.eventId);
        if (event.event.kind === "interaction.request") {
          const interaction = event.event;
          this.sink.interaction?.(binding, interaction, (outcome) => {
            socket.write(`${JSON.stringify({ version: 1, type: "command", command: { kind: "interaction.resolve", interactionId: interaction.interactionId, outcome } })}\n`);
          });
        } else {
          this.sink.publish(binding, event.event);
        }
        socket.write(`${JSON.stringify({ version: 1, type: "event_ack", eventId: event.eventId })}\n`);
      }
    });
  }
}
