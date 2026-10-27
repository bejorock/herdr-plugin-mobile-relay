import { isAbsolute } from "node:path";

const NATIVE_SESSION_DISCOVERY_TIMEOUT_MS = 5_000;
const NATIVE_SESSION_DISCOVERY_POLL_MS = 100;

import type { AgentInfo, HerdrClient } from "../herdr-client.ts";
import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { AgentView, WorkspaceView } from "../types.ts";
import { acpSessionIdFor, LiveAcpSessionRegistry } from "./session-registry.ts";
import type { AcpSessionDescriptor } from "./types.ts";

export const SUPPORTED_ACP_AGENT_KINDS = new Set([
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode",
  "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli",
  "qwen", "letta", "maki", "muse",
]);

export interface NewAcpAgentRequest {
  cwd: string;
  agent: { kind: string; args: string[] };
}

export function parseHerdrNewSessionMeta(value: unknown): { kind: string; args: string[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const ext = root["herdr.dev"];
  if (typeof ext !== "object" || ext === null || Array.isArray(ext)) return null;
  const agent = (ext as Record<string, unknown>).agent;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return null;
  const record = agent as Record<string, unknown>;
  if (typeof record.kind !== "string" || !SUPPORTED_ACP_AGENT_KINDS.has(record.kind)) return null;
  if (record.args !== undefined && (!Array.isArray(record.args) || record.args.length > 32 || !record.args.every((arg) => typeof arg === "string" && arg.length <= 4096))) return null;
  return { kind: record.kind, args: (record.args as string[] | undefined) ?? [] };
}

function exactWorkspace(runtime: SessionRuntime, cwd: string): WorkspaceView | undefined {
  const snapshot = runtime.engine.current();
  const panes = [...snapshot.agents, ...snapshot.shellPanes];
  const candidates = snapshot.workspaces.filter((workspace) =>
    workspace.worktree?.checkoutPath === cwd ||
    // A workspace without worktree metadata can still be rooted at an exact pane CWD. The
    // workspace itself is authoritative once this equality holds; do not fuzzy-match descendants.
    panes.some((pane) => pane.workspaceId === workspace.workspaceId && pane.cwd === cwd),
  );
  return candidates.find((workspace) => workspace.focused) ?? candidates[0];
}

function descriptor(input: {
  runtime: SessionRuntime;
  pane: { paneId: string; workspaceId: string; tabId: string; cwd: string };
  agent: { agent: string | null; status: AgentView["status"]; agentSession?: { source: string; agent: string; kind: "id" | "path"; value: string } };
}): AcpSessionDescriptor {
  const native = input.agent.agentSession;
  const agent = input.agent.agent ?? "unknown";
  return {
    id: acpSessionIdFor({
      herdrSession: input.runtime.name,
      paneId: input.pane.paneId,
      agent,
      nativeSource: native?.source,
      nativeValue: native?.value,
    }),
    cwd: input.pane.cwd,
    title: `${agent} · ${input.pane.cwd.split("/").filter(Boolean).at(-1) ?? "workspace"}`,
    agent,
    herdrSession: input.runtime.name,
    paneId: input.pane.paneId,
    nativeStatus: input.agent.status,
    hasNativeSession: native !== undefined,
    ...(native ? { nativeSession: native } : {}),
  };
}

/** Implements the agreed `session/new` policy: exact workspace reuse, fresh tab/pane, explicit agent. */
export class HerdrAcpProvisioner {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly acpSessions?: LiveAcpSessionRegistry,
  ) {}

  async create(input: NewAcpAgentRequest): Promise<AcpSessionDescriptor> {
    if (!isAbsolute(input.cwd)) throw new Error("cwd must be absolute");
    const runtime = this.sessions.get();
    if (!runtime || runtime.engine.current().bridge !== "connected") throw new Error("primary Herdr session is unavailable");

    const match = exactWorkspace(runtime, input.cwd);
    const created = match
      ? await runtime.herdr.createTab(match.workspaceId, { cwd: input.cwd })
      : await runtime.herdr.createWorkspace({ cwd: input.cwd });
    const started = await runtime.herdr.startAgent({
      paneId: created.paneId,
      kind: input.agent.kind,
      name: input.agent.kind,
      args: input.agent.args,
    });
    if (!started.interactiveReady || !started.agent) {
      throw new Error("Herdr did not confirm the requested agent is ready");
    }
    const ready = await this.waitForNativeSession(runtime.herdr, created, started);
    const agent: AgentView = {
      paneId: ready.paneId,
      workspaceId: ready.workspaceId,
      workspaceLabel: created.workspaceLabel ?? created.workspaceId,
      workspaceNumber: 0,
      tabId: ready.tabId,
      agent: ready.agent ?? input.agent.kind,
      status: ready.status,
      cwd: ready.cwd,
      focused: ready.focused,
      kind: "agent",
      ...(ready.agentSession ? { nativeSession: ready.agentSession } : {}),
    };
    return this.acpSessions?.remember(runtime, agent) ?? descriptor({ runtime, pane: created, agent: ready });
  }

  private async waitForNativeSession(
    herdr: HerdrClient,
    pane: { paneId: string; workspaceId: string; tabId: string; cwd: string },
    started: AgentInfo,
  ) {
    if (started.agentSession) return started;
    const deadline = Date.now() + NATIVE_SESSION_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, NATIVE_SESSION_DISCOVERY_POLL_MS));
      const current = await herdr.getAgent(pane.paneId);
      if (current.agentSession) return current;
    }
    throw new Error("Native agent session discovery timed out");
  }
}
