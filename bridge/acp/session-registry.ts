import { createHash } from "node:crypto";

import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { AgentView } from "../types.ts";
import { AcpBindingStore, type PersistedAcpBinding } from "./binding-store.ts";
import type { AcpSessionDescriptor, AcpSessionProvider } from "./types.ts";

/**
 * Derives opaque, stable-within-a-relay-build ACP identifiers from the internal Herdr/native
 * binding. The raw Herdr pane ID and transcript path are never placed in the ACP session ID.
 */
export function acpSessionIdFor(input: {
  herdrSession: string;
  paneId: string;
  agent: string;
  nativeSource?: string;
  nativeValue?: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("base64url")
    .slice(0, 32);
  return `herdr_${digest}`;
}

function titleFor(agent: AgentView): string {
  return `${agent.agent} · ${agent.workspaceLabel}`;
}

/**
 * Projects live Herdr agent panes into ACP sessions. This is intentionally an in-memory discovery
 * registry for the first ACP slice: a relay restart recomputes it from Herdr's authoritative live
 * snapshot, and future transcript persistence/hook binding layers can replace this implementation
 * without changing ACP routing.
 */
export class LiveAcpSessionRegistry implements AcpSessionProvider {
  private readonly provisioned = new Map<string, { runtime: SessionRuntime; agent: AgentView; descriptor: AcpSessionDescriptor; persisted: boolean; expiresAt?: number }>();

  constructor(
    private readonly herdrSessions: SessionRegistry,
    private readonly bindingStore?: AcpBindingStore,
  ) {}

  /** Make a just-started agent immediately addressable before StateEngine's next authoritative poll. */
  remember(runtime: SessionRuntime, agent: AgentView): AcpSessionDescriptor {
    const descriptor = this.fromAgent(runtime.name, agent);
    // A just-created pane may take one StateEngine poll to appear. Keep that temporary mapping only
    // long enough for discovery; durable bindings are restricted to validated Claude hook paths.
    this.provisioned.set(descriptor.id, { runtime, agent, descriptor, persisted: false, expiresAt: Date.now() + 30_000 });
    return descriptor;
  }

  list(): AcpSessionDescriptor[] {
    this.restorePersistedBindings();
    this.reconcile();
    const result: AcpSessionDescriptor[] = [];
    for (const runtime of this.herdrSessions.all()) {
      const snapshot = runtime.engine.current();
      if (snapshot.bridge !== "connected") continue;
      for (const agent of snapshot.agents) {
        const live = this.fromAgent(runtime.name, agent);
        // A Claude hook can safely augment a live native-ID binding with a private transcript path.
        // Keep the opaque ID and live visibility, but route ACP replay/prompts through that binding.
        result.push(this.provisioned.get(live.id)?.descriptor ?? live);
      }
    }
    for (const pending of this.provisioned.values()) {
      if (!result.some((session) => session.id === pending.descriptor.id)) result.push(pending.descriptor);
    }
    return result.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  find(id: string): AcpSessionDescriptor | undefined {
    this.restorePersistedBindings();
    this.reconcile();
    return this.provisioned.get(id)?.descriptor ?? this.list().find((session) => session.id === id);
  }

  /** Bind a Claude hook-reported, path-contained transcript to its exact live Herdr native session. */
  bindTranscript(id: string, transcriptPath: string): boolean {
    const binding = this.binding(id);
    if (!binding || binding.agent.agent !== "claude") return false;
    const native = binding.agent.nativeSession;
    if (!native || native.kind !== "id") return false;
    const updated: AgentView = { ...binding.agent, nativeSession: { source: native.source, agent: native.agent, kind: "path", value: transcriptPath } };
    const descriptor = this.fromAgent(binding.runtime.name, updated);
    const stable = { ...descriptor, id };
    // The public ACP ID must stay stable when a private hook augments a Herdr native ID binding.
    this.provisioned.set(id, { runtime: binding.runtime, agent: updated, descriptor: stable, persisted: Boolean(this.bindingStore) });
    this.bindingStore?.upsert({
      id,
      herdrSession: binding.runtime.name,
      paneId: binding.agent.paneId,
      agent: "claude",
      nativeSource: native.source,
      nativeKind: "id",
      nativeValue: native.value,
      transcriptPath,
    });
    return true;
  }

  /** Resolve the live Herdr runtime and pane for a previously-issued opaque ACP session id. */
  binding(id: string): { runtime: ReturnType<SessionRegistry["get"]> & {}; agent: AgentView } | undefined {
    this.restorePersistedBindings();
    this.reconcile();
    const pending = this.provisioned.get(id);
    if (pending) return { runtime: pending.runtime, agent: pending.agent };
    for (const runtime of this.herdrSessions.all()) {
      const snapshot = runtime.engine.current();
      if (snapshot.bridge !== "connected") continue;
      for (const agent of snapshot.agents) {
        if (this.fromAgent(runtime.name, agent).id === id) return { runtime, agent };
      }
    }
    return undefined;
  }

  private restorePersistedBindings(): void {
    for (const persisted of this.bindingStore?.values() ?? []) {
      if (this.provisioned.has(persisted.id)) continue;
      const runtime = this.herdrSessions.get(persisted.herdrSession);
      // At boot StateEngine has not necessarily completed its first authoritative snapshot. Retain
      // encrypted-by-permissions metadata until the target Herdr session becomes observable.
      if (!runtime || runtime.engine.current().bridge !== "connected") continue;
      const live = this.liveClaudeBinding(persisted);
      if (!live) {
        this.bindingStore?.delete(persisted.id);
        continue;
      }
      const updated: AgentView = {
        ...live.agent,
        nativeSession: { source: persisted.nativeSource, agent: "claude", kind: "path", value: persisted.transcriptPath },
      };
      this.provisioned.set(persisted.id, { runtime: live.runtime, agent: updated, descriptor: { ...this.fromAgent(live.runtime.name, updated), id: persisted.id }, persisted: true });
    }
  }

  private reconcile(): void {
    const now = Date.now();
    for (const [id, pending] of this.provisioned) {
      const runtime = this.herdrSessions.get(pending.runtime.name);
      const snapshot = runtime?.engine.current();
      if (!snapshot || snapshot.bridge !== "connected") continue;
      const live = snapshot.agents.find((agent) => agent.paneId === pending.agent.paneId);
      const persisted = pending.persisted ? this.bindingStore?.values().find((binding) => binding.id === id) : undefined;
      const current = live && (!pending.persisted || Boolean(persisted &&
        live.agent === "claude" &&
        live.nativeSession?.source === persisted.nativeSource &&
        live.nativeSession.kind === "id" &&
        live.nativeSession.value === persisted.nativeValue
      ));
      if (current || (!pending.persisted && pending.expiresAt !== undefined && now < pending.expiresAt)) continue;
      this.provisioned.delete(id);
      if (pending.persisted) this.bindingStore?.delete(id);
    }
  }

  private liveClaudeBinding(persisted: PersistedAcpBinding): { runtime: SessionRuntime; agent: AgentView } | undefined {
    const runtime = this.herdrSessions.get(persisted.herdrSession);
    if (!runtime || runtime.engine.current().bridge !== "connected") return undefined;
    const agent = runtime.engine.current().agents.find((candidate) => {
      const native = candidate.nativeSession;
      return candidate.paneId === persisted.paneId && candidate.agent === "claude" && native?.source === persisted.nativeSource && native.kind === "id" && native.value === persisted.nativeValue;
    });
    return agent ? { runtime, agent } : undefined;
  }

  private fromAgent(herdrSession: string, agent: AgentView): AcpSessionDescriptor {
    const native = agent.nativeSession;
    const id = acpSessionIdFor({
      herdrSession,
      paneId: agent.paneId,
      agent: agent.agent,
      nativeSource: native?.source,
      nativeValue: native?.value,
    });
    // Herdr snapshots do not yet expose a timestamp per pane, so revision is a stable change
    // signal rather than wall-clock activity. A later durable binding registry will provide one.
    return {
      id,
      cwd: agent.cwd,
      title: titleFor(agent),
      agent: agent.agent,
      herdrSession,
      paneId: agent.paneId,
      nativeStatus: agent.status,
      hasNativeSession: native !== undefined,
      ...(native ? { nativeSession: native } : {}),
    };
  }
}
