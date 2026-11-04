import { createHash } from "node:crypto";

import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { AgentView } from "../types.ts";
import { AcpBindingStore, type PersistedAcpBinding } from "./binding-store.ts";
import type { AcpSessionDescriptor, AcpSessionProvider } from "./types.ts";

/** Derives opaque ACP IDs. Native identifiers never appear in the ID itself. */
export function acpSessionIdFor(input: {
  herdrSession: string; paneId: string; agent: string; nativeSource?: string; nativeValue?: string;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("base64url").slice(0, 32);
  return `herdr_${digest}`;
}

function titleFor(agent: AgentView): string { return `${agent.agent} · ${agent.workspaceLabel}`; }

type Pending = { runtime: SessionRuntime; agent: AgentView; descriptor: AcpSessionDescriptor; expiresAt?: number };

/**
 * Projects live panes plus persisted logical conversations into ACP. A durable record survives an
 * exited pane; it is deliberately not automatically launched. `session/resume` owns that mutation.
 */
export class LiveAcpSessionRegistry implements AcpSessionProvider {
  private readonly provisioned = new Map<string, Pending>();

  constructor(private readonly herdrSessions: SessionRegistry, private readonly bindingStore?: AcpBindingStore) {}

  remember(runtime: SessionRuntime, agent: AgentView): AcpSessionDescriptor {
    const descriptor = this.fromAgent(runtime.name, agent);
    this.provisioned.set(descriptor.id, { runtime, agent, descriptor, expiresAt: Date.now() + 30_000 });
    // Pi creates its JSONL only after its first turn. Persist it after the transcript has become
    // a real validated file (during prompt/replay), not from this early Herdr hint.
    return descriptor;
  }

  list(): AcpSessionDescriptor[] {
    this.restoreLiveBindings();
    this.reconcile();
    const result = new Map<string, AcpSessionDescriptor>();
    for (const runtime of this.herdrSessions.all()) {
      const snapshot = runtime.engine.current();
      if (snapshot.bridge !== "connected") continue;
      for (const agent of snapshot.agents) {
        const live = this.fromAgent(runtime.name, agent);
        // Persist a Pi binding only once its transcript is a real file; Claude becomes durable when
        // its validated hook supplies a transcript path. This avoids treating Herdr's early Pi
        // planned-path hint as a recoverable native conversation.
        // A restored durable binding retains the logical ID even when the live snapshot exposes
        // Claude's native ID while replay/prompting needs its private transcript path.
        const adopted = [...this.provisioned.values()].find((pending) =>
          pending.runtime.name === runtime.name && pending.agent.paneId === agent.paneId,
        );
        result.set(adopted?.descriptor.id ?? live.id, adopted?.descriptor ?? live);
      }
    }
    for (const pending of this.provisioned.values()) result.set(pending.descriptor.id, pending.descriptor);
    // Retain closed-but-resumable conversations in session/list. Public metadata is safe; all
    // native IDs/paths remain backend-only on the persisted binding.
    for (const durable of this.bindingStore?.values() ?? []) {
      if (!result.has(durable.id)) result.set(durable.id, this.fromPersisted(durable));
    }
    return [...result.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  find(id: string): AcpSessionDescriptor | undefined { return this.list().find((session) => session.id === id); }

  /** Durable private recovery handle; never serialize this directly to ACP. */
  durable(id: string): PersistedAcpBinding | undefined {
    const binding = this.bindingStore?.get(id);
    return binding?.workspaceId && binding.cwd ? binding : undefined;
  }

  /** Persist a live binding only after its transcript adapter has proven the file is safe/readable. */
  persistBinding(id: string): void {
    const binding = this.binding(id);
    if (binding) this.persist(id, binding.runtime, binding.agent);
  }

  /** Bind a hook-reported Claude transcript, retaining its original native-ID resume handle. */
  bindTranscript(id: string, transcriptPath: string): boolean {
    const binding = this.binding(id);
    if (!binding || binding.agent.agent !== "claude") return false;
    const native = binding.agent.nativeSession;
    if (!native || native.kind !== "id") return false;
    const updated: AgentView = { ...binding.agent, nativeSession: { source: native.source, agent: "claude", kind: "path", value: transcriptPath } };
    const descriptor = { ...this.fromAgent(binding.runtime.name, updated), id };
    this.provisioned.set(id, { runtime: binding.runtime, agent: updated, descriptor });
    this.persist(id, binding.runtime, updated, { nativeSource: native.source, nativeKind: "id", nativeValue: native.value, transcriptPath });
    return true;
  }

  /** Attach a recreated pane to the existing logical ACP ID after a proven native resume. */
  adoptRecovered(id: string, runtime: SessionRuntime, agent: AgentView): AcpSessionDescriptor | undefined {
    const durable = this.bindingStore?.get(id);
    if (!durable || agent.agent !== durable.agent) return undefined;
    const updated: AgentView = {
      ...agent,
      nativeSession: { source: durable.nativeSource, agent: durable.agent, kind: "path", value: durable.transcriptPath },
    };
    const descriptor = { ...this.fromAgent(runtime.name, updated), id };
    this.provisioned.set(id, { runtime, agent: updated, descriptor });
    this.persist(id, runtime, updated, durable);
    return descriptor;
  }

  /** Resolve current live binding, or a private durable descriptor when its pane has gone away. */
  binding(id: string): { runtime: SessionRuntime; agent: AgentView } | undefined {
    this.restoreLiveBindings();
    this.reconcile();
    const pending = this.provisioned.get(id);
    if (pending) return { runtime: pending.runtime, agent: pending.agent };
    for (const runtime of this.herdrSessions.all()) {
      const snapshot = runtime.engine.current();
      if (snapshot.bridge !== "connected") continue;
      for (const agent of snapshot.agents) if (this.fromAgent(runtime.name, agent).id === id) return { runtime, agent };
    }
    const durable = this.bindingStore?.get(id);
    const runtime = durable && this.herdrSessions.get(durable.herdrSession);
    return durable && runtime ? { runtime, agent: this.agentFromPersisted(durable) } : undefined;
  }

  private persist(id: string, runtime: SessionRuntime, agent: AgentView, prior?: Pick<PersistedAcpBinding, "nativeSource" | "nativeKind" | "nativeValue" | "transcriptPath">): void {
    const native = agent.nativeSession;
    const transcriptPath = prior?.transcriptPath ?? (native?.kind === "path" ? native.value : undefined);
    if (!this.bindingStore || (agent.agent !== "pi" && agent.agent !== "claude") || !native || !transcriptPath) return;
    this.bindingStore.upsert({
      id, herdrSession: runtime.name, paneId: agent.paneId, workspaceId: agent.workspaceId, cwd: agent.cwd,
      agent: agent.agent, nativeSource: prior?.nativeSource ?? native.source,
      nativeKind: prior?.nativeKind ?? native.kind, nativeValue: prior?.nativeValue ?? native.value, transcriptPath,
    });
  }

  private restoreLiveBindings(): void {
    for (const durable of this.bindingStore?.values() ?? []) {
      if (this.provisioned.has(durable.id)) continue;
      const runtime = this.herdrSessions.get(durable.herdrSession);
      if (!runtime || runtime.engine.current().bridge !== "connected") continue;
      const live = runtime.engine.current().agents.find((agent) => {
        const native = agent.nativeSession;
        return agent.paneId === durable.paneId && agent.agent === durable.agent && native?.source === durable.nativeSource &&
          (durable.agent === "claude" ? native.kind === "id" && native.value === durable.nativeValue : native.kind === "path" && native.value === durable.transcriptPath);
      });
      if (!live) continue; // Missing/mismatched pane is resumable; retain the durable record.
      const updated: AgentView = { ...live, nativeSession: { source: durable.nativeSource, agent: durable.agent, kind: "path", value: durable.transcriptPath } };
      this.provisioned.set(durable.id, { runtime, agent: updated, descriptor: { ...this.fromAgent(runtime.name, updated), id: durable.id } });
    }
  }

  private reconcile(): void {
    const now = Date.now();
    for (const [id, pending] of this.provisioned) {
      const runtime = this.herdrSessions.get(pending.runtime.name);
      const snapshot = runtime?.engine.current();
      if (!snapshot || snapshot.bridge !== "connected") continue;
      const live = snapshot.agents.find((agent) => agent.paneId === pending.agent.paneId);
      if (live) continue;
      // A durable record means this pane was positively bound already. Once its authoritative
      // snapshot entry disappears, expose the closed logical session immediately; the short grace
      // window is only for a freshly-created, not-yet-persisted pane to appear in StateEngine.
      if (!this.bindingStore?.get(id) && pending.expiresAt !== undefined && now < pending.expiresAt) continue;
      // Forget only the ephemeral/live attachment. The durable logical conversation stays resumable.
      this.provisioned.delete(id);
    }
  }

  private fromPersisted(binding: PersistedAcpBinding): AcpSessionDescriptor {
    return {
      id: binding.id, cwd: binding.cwd ?? "", title: `${binding.agent} · ${(binding.cwd ?? "workspace").split("/").filter(Boolean).at(-1) ?? "workspace"}`,
      agent: binding.agent, herdrSession: binding.herdrSession, paneId: binding.paneId,
      nativeStatus: "done", hasNativeSession: true, resumable: true,
      nativeSession: { source: binding.nativeSource, agent: binding.agent, kind: "path", value: binding.transcriptPath },
    };
  }

  private agentFromPersisted(binding: PersistedAcpBinding): AgentView {
    return {
      paneId: binding.paneId, workspaceId: binding.workspaceId ?? "", workspaceLabel: binding.workspaceId ?? "", workspaceNumber: 0,
      tabId: "", agent: binding.agent, status: "done", cwd: binding.cwd ?? "", focused: false, kind: "agent",
      nativeSession: { source: binding.nativeSource, agent: binding.agent, kind: "path", value: binding.transcriptPath },
    };
  }

  private fromAgent(herdrSession: string, agent: AgentView): AcpSessionDescriptor {
    const native = agent.nativeSession;
    const id = acpSessionIdFor({ herdrSession, paneId: agent.paneId, agent: agent.agent, nativeSource: native?.source, nativeValue: native?.value });
    return { id, cwd: agent.cwd, title: titleFor(agent), agent: agent.agent, herdrSession, paneId: agent.paneId, nativeStatus: agent.status, hasNativeSession: native !== undefined, ...(native ? { nativeSession: native } : {}) };
  }
}
