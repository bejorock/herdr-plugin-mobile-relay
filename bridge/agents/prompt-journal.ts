import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LifecycleError, REQUEST_ID } from "./conversations.ts";
export interface PromptResult { ok: true; conversationId: string; requestId: string; delivered: true; completion: "unknown" }
interface Entry { conversationId: string; requestId: string; hash: string; status: "reserved" | "delivered" | "failed"; error?: { status: number; code: string; message: string } }
export class PromptJournal {
  private records = new Map<string, Entry>();
  private readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "prompt-requests.json");
    if (!existsSync(this.path)) return;
    try {
      const info = lstatSync(this.path); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error();
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.requests) || data.requests.length > 10_000) throw new Error();
      for (const e of data.requests) {
        if (typeof e.conversationId !== "string" || typeof e.requestId !== "string" || typeof e.hash !== "string" || !/^conversation_[0-9a-f-]{36}$/.test(e.conversationId) || !REQUEST_ID.test(e.requestId) || !/^[A-Za-z0-9_-]{43}$/.test(e.hash) || !["reserved", "delivered", "failed"].includes(e.status) ||
          (e.status === "failed" && (!e.error || !Number.isInteger(e.error.status) || typeof e.error.code !== "string" || typeof e.error.message !== "string"))) throw new Error();
        const key = JSON.stringify([e.conversationId, e.requestId]); if (this.records.has(key)) throw new Error(); this.records.set(key, e);
      }
    } catch { throw new LifecycleError(500, "persistence_failed", "Prompt journal is invalid; operator inspection required"); }
  }
  static hash(text: string): string { return createHash("sha256").update(text).digest("base64url"); }
  prior(conversationId: string, requestId: string, hash: string): PromptResult | undefined {
    const record = this.records.get(JSON.stringify([conversationId, requestId]));
    if (!record) return undefined;
    if (record.hash !== hash) throw new LifecycleError(409, "request_id_conflict", "requestId was used with different prompt text");
    if (record.status === "reserved") throw new LifecycleError(409, "prompt_delivery_unconfirmed", "Earlier prompt delivery is unresolved; inspect transcript before any new request");
    if (record.status === "failed") throw new LifecycleError(record.error!.status, record.error!.code, record.error!.message);
    return { ok: true, conversationId, requestId, delivered: true, completion: "unknown" };
  }
  reserve(conversationId: string, requestId: string, hash: string): void { this.save({ conversationId, requestId, hash, status: "reserved" }); }
  delivered(conversationId: string, requestId: string, hash: string): PromptResult {
    this.save({ conversationId, requestId, hash, status: "delivered" });
    return { ok: true, conversationId, requestId, delivered: true, completion: "unknown" };
  }
  failed(conversationId: string, requestId: string, hash: string, error: LifecycleError): void {
    this.save({ conversationId, requestId, hash, status: "failed", error: { status: error.status, code: error.code, message: error.message } });
  }
  private save(entry: Entry): void {
    const key = JSON.stringify([entry.conversationId, entry.requestId]);
    if (!this.records.has(key) && this.records.size >= 10_000) throw new LifecycleError(503, "capacity_exceeded", "Prompt journal is full");
    const next = new Map(this.records); next.set(key, entry);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const text = JSON.stringify({ version: 1, requests: [...next.values()] }) + "\n";
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("Prompt journal size limit");
      writeFileSync(temp, text, { flag: "wx", mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, this.path);
    }
    catch { try { unlinkSync(temp); } catch {} throw new LifecycleError(500, "persistence_failed", "Could not persist prompt delivery state"); }
    this.records = next;
  }
}
