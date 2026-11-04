import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ACP_BINDING_STORE_FILE = "acp-bindings.json";

/**
 * Owner-only resume handle for one logical ACP conversation. It intentionally separates the stable
 * ACP id from the replaceable Herdr pane id. Native values and transcript paths never cross ACP.
 */
export interface PersistedAcpBinding {
  id: string;
  herdrSession: string;
  paneId: string;
  /** Missing only on migrated v1 Claude bindings; not recoverable until a live pane upgrades it. */
  workspaceId?: string;
  /** Missing only on migrated v1 Claude bindings; not recoverable until a live pane upgrades it. */
  cwd?: string;
  agent: "pi" | "claude";
  nativeSource: string;
  nativeKind: "id" | "path";
  nativeValue: string;
  /** Required for replay; Pi normally stores it as nativeValue too. */
  transcriptPath: string;
}

type BindingStoreFile = { version: 1 | 2; bindings: PersistedAcpBinding[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valid(binding: unknown): binding is PersistedAcpBinding {
  return isRecord(binding) &&
    typeof binding.id === "string" && /^herdr_[A-Za-z0-9_-]{32}$/.test(binding.id) &&
    typeof binding.herdrSession === "string" && binding.herdrSession.length > 0 && binding.herdrSession.length <= 128 &&
    typeof binding.paneId === "string" && binding.paneId.length > 0 && binding.paneId.length <= 256 &&
    (binding.workspaceId === undefined || (typeof binding.workspaceId === "string" && binding.workspaceId.length > 0 && binding.workspaceId.length <= 256)) &&
    (binding.cwd === undefined || (typeof binding.cwd === "string" && binding.cwd.startsWith("/") && binding.cwd.length <= 4096)) &&
    (binding.agent === "pi" || binding.agent === "claude") &&
    typeof binding.nativeSource === "string" && binding.nativeSource.length > 0 && binding.nativeSource.length <= 128 &&
    (binding.nativeKind === "id" || binding.nativeKind === "path") &&
    typeof binding.nativeValue === "string" && binding.nativeValue.length > 0 && binding.nativeValue.length <= 4096 &&
    typeof binding.transcriptPath === "string" && binding.transcriptPath.length > 0 && binding.transcriptPath.length <= 4096;
}

/** Owner-only, fail-closed store. Bad on-disk data is ignored rather than trusted. */
export class AcpBindingStore {
  readonly path: string;
  private readonly bindings = new Map<string, PersistedAcpBinding>();

  constructor(stateDir: string) {
    this.path = join(stateDir, ACP_BINDING_STORE_FILE);
    this.load();
  }

  values(): PersistedAcpBinding[] { return [...this.bindings.values()]; }
  get(id: string): PersistedAcpBinding | undefined { return this.bindings.get(id); }

  upsert(binding: PersistedAcpBinding): void {
    this.bindings.set(binding.id, binding);
    this.save();
  }

  delete(id: string): void {
    if (!this.bindings.delete(id)) return;
    this.save();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.bindings) || !parsed.bindings.every(valid)) {
        throw new Error("invalid binding store");
      }
      for (const binding of parsed.bindings) this.bindings.set(binding.id, binding);
    } catch (error) {
      console.warn(`[acp] ignoring invalid persisted binding store: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private save(): void {
    const data: BindingStoreFile = { version: 2, bindings: this.values() };
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      console.warn(`[acp] could not persist binding store: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
