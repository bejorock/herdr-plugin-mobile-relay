import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";

import type { AgentStatus } from "../types.ts";
import type { AuditLog } from "../audit.ts";
import { piHistoryUpdates, parsePiTranscript, readSafePiTranscript } from "./pi-transcript.ts";
import { claudeHistoryUpdates, parseClaudeTranscript, readSafeClaudeTranscript } from "./claude-transcript.ts";
import { type HerdrAcpProvisioner, parseHerdrNewSessionMeta } from "./provision.ts";
import type { PiAcpPromptSender } from "./prompt.ts";
import type { PiAcpCanceller } from "./cancel.ts";
import { tailPiTranscript, type PiTranscriptTailer } from "./tailer.ts";
import { tailClaudeTranscript, type ClaudeTranscriptTailer } from "./claude-tailer.ts";
import { AcpInteractionBroker } from "./interactions.ts";
import type { ElicitationSchema } from "./elicitation.ts";
import {
  HERDR_ACP_NAMESPACE,
  type AcpConnectionContext,
  type AcpSessionProvider,
  type AcpSocket,
} from "./types.ts";

const JSON_RPC = "2.0";
// The pinned SDK is the ACP v2 schema/protocol contract for this experimental transport slice.
const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;
const MAX_FRAME_BYTES = 256 * 1024;

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};
type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: unknown;
};

type Connection = {
  socket: AcpSocket;
  auth: AcpConnectionContext;
  initialized: boolean;
  tails: Map<string, PiTranscriptTailer | ClaudeTranscriptTailer>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC &&
    typeof value.method === "string" &&
    "id" in value &&
    isId(value.id)
  );
}

function isNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value) && value.jsonrpc === JSON_RPC && typeof value.method === "string" && !("id" in value);
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && value.jsonrpc === JSON_RPC && !("method" in value) && "id" in value && isId(value.id) && ("result" in value || "error" in value);
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ACP_IMAGES = 4;
const MAX_ACP_IMAGE_BYTES = 10 * 1024 * 1024;

function parsePrompt(value: unknown[]): { text: string; images: Array<{ mimeType: string; bytes: Uint8Array; base64: string }> } | null {
  const texts: string[] = [];
  const images: Array<{ mimeType: string; bytes: Uint8Array; base64: string }> = [];
  for (const block of value) {
    if (!isRecord(block)) return null;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      continue;
    }
    if (block.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string" && IMAGE_MIME_TYPES.has(block.mimeType) && images.length < MAX_ACP_IMAGES) {
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.fromBase64(block.data, { alphabet: "base64", lastChunkHandling: "strict" });
      } catch {
        return null;
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ACP_IMAGE_BYTES) return null;
      images.push({ mimeType: block.mimeType, bytes, base64: block.data });
      continue;
    }
    return null;
  }
  const text = texts.join("\n").trim();
  return text.length > 0 && text.length <= 65_536 ? { text, images } : null;
}

function statusUpdate(status: AgentStatus) {
  return {
    sessionUpdate: "state_update",
    state: status === "working" ? "running" : status === "blocked" ? "requires_action" : "idle",
  };
}

/**
 * Minimal ACP v2 WebSocket dispatcher. It deliberately starts read-only: only list/resume of
 * already-discovered Herdr-native sessions are available until the hook/transcript/prompt phases
 * prove their safety. Keeping this boundary explicit is safer than advertising unsupported ACP
 * session capabilities.
 */
export class AcpWebSocketServer {
  private readonly connections = new Set<Connection>();
  private readonly interactions = new AcpInteractionBroker();

  constructor(
    private readonly sessions: AcpSessionProvider,
    private readonly version: string,
    private readonly provisioner?: HerdrAcpProvisioner,
    private readonly promptSender?: PiAcpPromptSender,
    private readonly canceller?: PiAcpCanceller,
    private readonly audit?: AuditLog,
  ) {}

  open(socket: AcpSocket, auth: AcpConnectionContext): void {
    this.connections.add({ socket, auth, initialized: false, tails: new Map() });
  }

  close(socket: AcpSocket): void {
    for (const connection of this.connections) {
      if (connection.socket !== socket) continue;
      for (const tail of connection.tails.values()) tail.close();
      this.interactions.closeSocket(socket);
      this.connections.delete(connection);
    }
  }

  /** Deterministically resolve all pending local interactions when the relay is stopping. */
  stop(): void {
    for (const connection of this.connections) {
      for (const tail of connection.tails.values()) tail.close();
    }
    this.connections.clear();
    this.interactions.close();
  }

  /** Forward a validated local extension notification to every initialized ACP connection. */
  publishCustom(sessionId: string, event: { namespace: string; name: string; payload?: unknown }): void {
    for (const connection of this.connections) {
      if (!connection.initialized || !connection.auth.canRead) continue;
      this.notify(connection.socket, `_${event.namespace}/${event.name}`, {
        sessionId,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      });
    }
  }

  /** Publish a validated immediate hook state hint. Herdr polling remains the authoritative fallback. */
  publishState(sessionId: string, state: "running" | "idle" | "requires_action"): void {
    for (const connection of this.connections) {
      if (!connection.initialized || !connection.auth.canRead) continue;
      this.notify(connection.socket, "session/update", {
        sessionId,
        update: { sessionUpdate: "state_update", state },
      });
    }
  }

  publishDelta(sessionId: string, event: { messageId: string; channel: "assistant" | "thought"; delta: string }, agent = "pi"): void {
    for (const connection of this.connections) {
      if (!connection.initialized || !connection.auth.canRead) continue;
      this.notify(connection.socket, "session/update", {
        sessionId,
        update: {
          sessionUpdate: event.channel === "assistant" ? "agent_message_chunk" : "agent_thought_chunk",
          messageId: `${agent}:${event.channel}:${event.messageId}`,
          content: { type: "text", text: event.delta },
        },
      });
    }
  }

  requestInteraction(sessionId: string, event: {
    interactionId: string;
    interactionKind: "permission" | "elicitation";
    title: string;
    description?: string;
    options?: Array<{ optionId: string; name: string }>;
    schema?: ElicitationSchema;
    timeoutMs?: number;
    plan?: { planId: string; content: string };
  }, resolveHook: (outcome: unknown) => void): void {
    const sockets = [...this.connections]
      .filter((connection) => connection.initialized && connection.auth.canWrite)
      .map((connection) => connection.socket);
    if (!sockets.length) {
      const session = this.sessions.find(sessionId);
      this.audit?.record({ action: `acp.interaction.${event.interactionKind}`, paneId: session?.paneId, session: session?.herdrSession, detail: { interaction: event.title, outcome: "no_authorized_client" } });
      resolveHook({ outcome: "cancelled", reason: "no_authorized_client" });
      return;
    }
    {
      const session = this.sessions.find(sessionId);
      this.audit?.record({ action: `acp.interaction.${event.interactionKind}`, paneId: session?.paneId, session: session?.herdrSession, detail: { interaction: event.title, outcome: "requested" } });
    }
    if (event.plan) {
      for (const socket of sockets) this.notify(socket, "session/update", {
        sessionId,
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "markdown", planId: event.plan.planId, content: event.plan.content },
        },
      });
    }
    this.interactions.request({
      sockets,
      sessionId,
      id: event.interactionId,
      kind: event.interactionKind,
      title: event.title,
      description: event.description,
      options: event.options,
      schema: event.schema,
      timeoutMs: event.timeoutMs,
      resolveHook: (outcome) => {
        const session = this.sessions.find(sessionId);
        this.audit?.record({ action: `acp.interaction.${event.interactionKind}`, paneId: session?.paneId, session: session?.herdrSession, detail: { interaction: event.title, outcome: this.interactionOutcome(outcome) } });
        resolveHook(outcome);
      },
    });
  }

  publishTool(sessionId: string, event: {
    toolCallId: string;
    toolName: string;
    status: "in_progress" | "completed" | "failed" | "cancelled";
    title?: string;
    error?: string;
  }, agent = "pi"): void {
    for (const connection of this.connections) {
      if (!connection.initialized || !connection.auth.canRead) continue;
      this.notify(connection.socket, "session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `${agent}:tool:${event.toolCallId}`,
          title: event.title ?? event.toolName,
          kind: "other",
          status: event.status,
          ...(event.error ? { content: [{ type: "content", content: { type: "text", text: event.error } }] } : {}),
        },
      });
    }
  }

  async message(socket: AcpSocket, raw: string): Promise<void> {
    const connection = [...this.connections].find((candidate) => candidate.socket === socket);
    if (!connection) return;
    if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) {
      socket.close(1009, "ACP frame too large");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.error(socket, null, -32700, "Parse error");
      return;
    }
    // ACP v2 permits JSON-RPC batches, but the first relay slice does not implement their ordering
    // semantics. Reject instead of accepting a shape we cannot route correctly.
    if (Array.isArray(message)) {
      this.error(socket, null, -32600, "Batch messages are not supported");
      return;
    }
    if (isResponse(message)) {
      // Only an ACP connection already authorised for writes may resolve a native interaction.
      // The broker removes the interaction before invoking the hook, so simultaneous responses are
      // deterministic: the first valid authorised response wins.
      if (connection.auth.canWrite) {
        this.interactions.resolve(String(message.id), "result" in message ? message.result : { outcome: "cancelled", error: message.error });
      }
      return;
    }
    if (isRequest(message)) {
      await this.request(connection, message);
      return;
    }
    if (isNotification(message)) {
      await this.notification(connection, message);
      return;
    }
    this.error(socket, null, -32600, "Invalid Request");
  }

  private async request(connection: Connection, request: JsonRpcRequest): Promise<void> {
    if (!connection.initialized && request.method !== "initialize") {
      this.error(connection.socket, request.id, -32600, "ACP connection must be initialized first");
      return;
    }
    if (connection.initialized && request.method === "initialize") {
      this.error(connection.socket, request.id, -32600, "ACP initialize may only be requested once per connection");
      return;
    }

    switch (request.method) {
      case "initialize": {
        const params = request.params;
        if (!isRecord(params) || params.protocolVersion !== ACP_PROTOCOL_VERSION || !isRecord(params.info) || typeof params.info.name !== "string" || typeof params.info.version !== "string") {
          this.error(connection.socket, request.id, -32002, `Unsupported protocol version; expected ${ACP_PROTOCOL_VERSION}`);
          return;
        }
        connection.initialized = true;
        this.result(connection.socket, request.id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          info: {
            name: "herdr-mobile-relay",
            title: "Herdr Mobile Relay",
            version: this.version,
          },
          capabilities: {
            session: { prompt: { image: true } },
            _meta: {
              [HERDR_ACP_NAMESPACE]: {
                transport: "websocket",
                phase: "experimental",
                sessionList: true,
                sessionResume: true,
                sessionNew: Boolean(this.provisioner),
                sessionPrompt: Boolean(this.promptSender),
                sessionCancel: Boolean(this.canceller),
                hooks: true,
                claudeAskUserQuestion: true,
                claudeExitPlanMode: true,
              },
            },
          },
        });
        return;
      }
      case "session/new": {
        if (!connection.auth.canWrite) {
          this.error(connection.socket, request.id, -32000, "Device is not authorised for ACP writes");
          return;
        }
        const params = request.params;
        if (!isRecord(params) || typeof params.cwd !== "string") {
          this.error(connection.socket, request.id, -32602, "cwd is required");
          return;
        }
        const agent = parseHerdrNewSessionMeta(params._meta);
        if (!agent) {
          this.error(connection.socket, request.id, -32602, "herdr.dev agent kind is required or unsupported");
          return;
        }
        if (!this.provisioner) {
          this.error(connection.socket, request.id, -32000, "ACP session provisioning is unavailable");
          return;
        }
        try {
          const session = await this.provisioner.create({ cwd: params.cwd, agent });
          this.notify(connection.socket, "session/update", {
            sessionId: session.id,
            update: statusUpdate(session.nativeStatus),
          });
          this.audit?.record({ action: "acp.session.new", paneId: session.paneId, session: session.herdrSession, device: connection.auth.device, detail: { agent: session.agent, outcome: "confirmed" } });
          this.result(connection.socket, request.id, {
            sessionId: session.id,
            _meta: { [HERDR_ACP_NAMESPACE]: { agent: session.agent, nativeSessionBound: session.hasNativeSession } },
          });
        } catch (error) {
          this.audit?.record({ action: "acp.session.new", device: connection.auth.device, detail: { agent, outcome: "failed" } });
          this.error(connection.socket, request.id, -32000, error instanceof Error ? error.message : "Could not provision agent session");
        }
        return;
      }
      case "session/prompt": {
        if (!connection.auth.canWrite) {
          this.error(connection.socket, request.id, -32000, "Device is not authorised for ACP writes");
          return;
        }
        const params = request.params;
        if (!isRecord(params) || typeof params.sessionId !== "string" || !Array.isArray(params.prompt)) {
          this.error(connection.socket, request.id, -32602, "sessionId and prompt are required");
          return;
        }
        const prompt = parsePrompt(params.prompt);
        if (!prompt) {
          this.error(connection.socket, request.id, -32602, "Prompt must contain non-empty text and up to four supported images");
          return;
        }
        if (!this.promptSender) {
          this.error(connection.socket, request.id, -32000, "ACP prompt delivery is unavailable");
          return;
        }
        try {
          const delivered = await this.promptSender.send({
            sessionId: params.sessionId,
            text: prompt.text,
            images: prompt.images,
          });
          this.notify(connection.socket, "session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "user_message",
              messageId: delivered.messageId,
              content: [
                { type: "text", text: prompt.text },
                ...prompt.images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.base64 })),
              ],
            },
          });
          const session = this.sessions.find(params.sessionId);
          this.audit?.record({ action: "acp.prompt", paneId: session?.paneId, session: session?.herdrSession, device: connection.auth.device, detail: { agent: session?.agent, textChars: prompt.text.length, imageCount: prompt.images.length, outcome: "confirmed" } });
          this.result(connection.socket, request.id, { messageId: delivered.messageId });
        } catch (error) {
          this.audit?.record({ action: "acp.prompt", device: connection.auth.device, detail: { textChars: prompt.text.length, imageCount: prompt.images.length, outcome: "failed" } });
          this.error(connection.socket, request.id, -32000, error instanceof Error ? error.message : "Prompt delivery failed");
        }
        return;
      }
      case "session/close": {
        if (!connection.auth.canWrite) {
          this.error(connection.socket, request.id, -32000, "Device is not authorised for ACP writes");
          return;
        }
        const params = request.params;
        if (!isRecord(params) || typeof params.sessionId !== "string") {
          this.error(connection.socket, request.id, -32602, "sessionId is required");
          return;
        }
        const session = this.sessions.find(params.sessionId);
        if (!session) {
          this.error(connection.socket, request.id, -32000, "Session not found");
          return;
        }
        try {
          await this.canceller?.cancel(session.id);
          // ACP close releases this transport's session attachment; it does NOT close the durable
          // Herdr pane. Pane/workspace destruction remains an explicit Herdr control-plane action.
          this.result(connection.socket, request.id, {});
        } catch (error) {
          this.error(connection.socket, request.id, -32000, error instanceof Error ? error.message : "Could not close session");
        }
        return;
      }
      case "session/list": {
        const listed = this.sessions.list().map((session) => ({
          sessionId: session.id,
          cwd: session.cwd,
          title: session.title,
          _meta: {
            [HERDR_ACP_NAMESPACE]: {
              agent: session.agent,
              nativeStatus: session.nativeStatus,
              nativeSessionBound: session.hasNativeSession,
            },
          },
        }));
        this.result(connection.socket, request.id, { sessions: listed });
        return;
      }
      case "session/resume": {
        const params = request.params;
        if (!isRecord(params) || typeof params.sessionId !== "string" || typeof params.cwd !== "string") {
          this.error(connection.socket, request.id, -32602, "sessionId and cwd are required");
          return;
        }
        const session = this.sessions.find(params.sessionId);
        if (!session) {
          this.error(connection.socket, request.id, -32000, "Session not found");
          return;
        }
        if (params.cwd !== session.cwd) {
          this.error(connection.socket, request.id, -32602, "cwd does not match the session");
          return;
        }
        const replayFrom = params.replayFrom;
        if (replayFrom !== undefined && replayFrom !== null && (!isRecord(replayFrom) || replayFrom.type !== "start")) {
          this.error(connection.socket, request.id, -32602, "Unsupported replay cursor");
          return;
        }
        if (isRecord(replayFrom) && replayFrom.type === "start") {
          try {
            const replay = await this.replayHistory(session.id, session.nativeSession);
            for (const params of replay) this.notify(connection.socket, "session/update", params);
          } catch (error) {
            this.error(connection.socket, request.id, -32000, "Session history is unavailable");
            return;
          }
        }
        // ACP v2 requires the current foreground state after any requested replay and before the
        // resume response. This is a snapshot, not a historical completion event.
        await this.startTail(connection, session.id, session.nativeSession);
        this.notify(connection.socket, "session/update", {
          sessionId: session.id,
          update: statusUpdate(session.nativeStatus),
        });
        this.result(connection.socket, request.id, {});
        return;
      }
      default:
        this.error(connection.socket, request.id, -32601, "Method not found");
    }
  }

  private async notification(connection: Connection, notification: JsonRpcNotification): Promise<void> {
    if (!connection.initialized) return;
    if (notification.method !== "session/cancel") return;
    if (!connection.auth.canWrite) return;
    const params = notification.params;
    if (!isRecord(params) || typeof params.sessionId !== "string" || !this.canceller) return;
    try {
      await this.canceller.cancel(params.sessionId);
      const session = this.sessions.find(params.sessionId);
      this.audit?.record({ action: "acp.cancel", paneId: session?.paneId, session: session?.herdrSession, device: connection.auth.device, detail: { outcome: "requested" } });
    } catch {
      // ACP cancellation is a notification: there is no response channel. The following
      // authoritative Herdr state update remains the only claim that cancellation completed.
    }
  }

  private async startTail(
    connection: Connection,
    sessionId: string,
    native: { source: string; agent: string; kind: "id" | "path"; value: string } | undefined,
  ): Promise<void> {
    if (connection.tails.has(sessionId) || !native || native.kind !== "path") return;
    const onUpdate = (params: unknown) => this.notify(connection.socket, "session/update", params);
    if (native.agent === "pi") {
      connection.tails.set(sessionId, await tailPiTranscript({ path: native.value, sessionId, onUpdate }));
    } else if (native.agent === "claude") {
      connection.tails.set(sessionId, await tailClaudeTranscript({ path: native.value, sessionId, onUpdate }));
    }
  }

  private async replayHistory(
    sessionId: string,
    native: { source: string; agent: string; kind: "id" | "path"; value: string } | undefined,
  ): Promise<unknown[]> {
    if (!native || native.kind !== "path") throw new Error("no supported transcript adapter");
    if (native.agent === "pi") {
      const text = await readSafePiTranscript(native.value);
      return piHistoryUpdates(sessionId, parsePiTranscript(text));
    }
    if (native.agent === "claude") {
      const text = await readSafeClaudeTranscript(native.value);
      return claudeHistoryUpdates(sessionId, parseClaudeTranscript(text));
    }
    throw new Error("no supported transcript adapter");
  }

  private interactionOutcome(outcome: unknown): string {
    if (!isRecord(outcome)) return "unknown";
    if (typeof outcome.action === "string") return outcome.action;
    if (isRecord(outcome.outcome) && typeof outcome.outcome.optionId === "string") return outcome.outcome.optionId;
    if (typeof outcome.outcome === "string") return outcome.outcome;
    return "unknown";
  }

  private result(socket: AcpSocket, id: JsonRpcId, result: unknown): void {
    socket.send(JSON.stringify({ jsonrpc: JSON_RPC, id, result }));
  }

  private error(socket: AcpSocket, id: JsonRpcId, code: number, message: string): void {
    socket.send(JSON.stringify({ jsonrpc: JSON_RPC, id, error: { code, message } }));
  }

  private notify(socket: AcpSocket, method: string, params: unknown): void {
    socket.send(JSON.stringify({ jsonrpc: JSON_RPC, method, params }));
  }
}
