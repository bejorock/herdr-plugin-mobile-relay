import { LiveAcpSessionRegistry } from "./session-registry.ts";

/**
 * Pi's interactive TUI honors Escape as its documented interruption control. This is deliberately
 * only a cancellation request: ACP state remains running until Herdr's authoritative agent state
 * later reports idle (published by the bridge state engine).
 */
export class PiAcpCanceller {
  constructor(private readonly sessions: LiveAcpSessionRegistry) {}

  async cancel(sessionId: string): Promise<void> {
    const binding = this.sessions.binding(sessionId);
    if (!binding) throw new Error("Session not found");
    if (binding.agent.agent !== "pi") throw new Error("This session does not support safe ACP cancellation");
    if (binding.agent.status !== "working" && binding.agent.status !== "blocked") return;
    await binding.runtime.herdr.sendPaneKeys(binding.agent.paneId, ["Escape"]);
  }
}
