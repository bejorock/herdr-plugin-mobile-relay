import { watch, type FSWatcher } from "node:fs";

import { claudeHistoryUpdates, parseClaudeTranscript, readSafeClaudeTranscript } from "./claude-transcript.ts";

export interface ClaudeTranscriptTailer {
  close(): void;
}

/** Bounded Claude JSONL tailer. Durable transcript updates are complete messages, never fabricated chunks. */
export async function tailClaudeTranscript(input: {
  path: string;
  sessionId: string;
  onUpdate: (params: unknown) => void;
  debounceMs?: number;
}): Promise<ClaudeTranscriptTailer> {
  const seen = new Set<string>();
  for (const entry of parseClaudeTranscript(await readSafeClaudeTranscript(input.path))) {
    if (entry.uuid) seen.add(entry.uuid);
  }
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let queued = false;
  const refresh = async () => {
    if (closed || reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      const entries = parseClaudeTranscript(await readSafeClaudeTranscript(input.path));
      const fresh = entries.filter((entry) => entry.uuid && !seen.has(entry.uuid));
      for (const entry of fresh) seen.add(entry.uuid!);
      if (fresh.length) {
        for (const update of claudeHistoryUpdates(input.sessionId, fresh)) input.onUpdate(update);
      }
    } catch {
      // A partial/rotated writer is retried on the next filesystem event or ACP resume.
    } finally {
      reading = false;
      if (queued) {
        queued = false;
        void refresh();
      }
    }
  };
  const watcher: FSWatcher = watch(input.path, { persistent: false }, () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, input.debounceMs ?? 75);
    timer.unref?.();
  });
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
