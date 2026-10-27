import type { AgentStatus } from "../types.ts";

/** ACP v2 relay namespace for Herdr-specific optional metadata and methods. */
export const HERDR_ACP_NAMESPACE = "herdr.dev";

/** A client-safe, opaque relay mapping for one native agent currently owned by Herdr. */
export interface AcpSessionDescriptor {
  id: string;
  cwd: string;
  title: string;
  agent: string;
  herdrSession: string;
  paneId: string;
  nativeStatus: AgentStatus;
  hasNativeSession: boolean;
  /** Backend-only native reference. Never serialize this to an ACP client. */
  nativeSession?: {
    source: string;
    agent: string;
    kind: "id" | "path";
    value: string;
  };
}

export interface AcpSessionProvider {
  list(): AcpSessionDescriptor[];
  find(id: string): AcpSessionDescriptor | undefined;
}

export interface AcpSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface AcpConnectionContext {
  /** The authenticated relay principal; null is the on-host loopback operator. */
  user: string | null;
  /** Device identity supplied by the trusted proxy where configured. */
  device: string | null;
  /** ACP reads are permitted after transport access checks. */
  canRead: boolean;
  /** ACP mutations are permitted only for an authorised relay device. */
  canWrite: boolean;
}
