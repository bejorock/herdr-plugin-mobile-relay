import { watch, type FSWatcher } from "node:fs";

import { parsePiTranscript, piEntryUpdates, readSafePiTranscript } from "./pi-transcript.ts";

export interface PiTranscriptTailerFs {
  read(path: string): Promise<string>;
  watch(path: string, listener: () => void): { close(): void };
}

const nodeFs: PiTranscriptTailerFs = {
  read: async (path) => await readSafePiTranscript(path),
  watch: (path, listener) => {
    // Watch the containing directory so atomic replace/rename writes are also observed. Debouncing
    // below coalesces noisy editors/filesystems into one safe full-file re-read.
    const watcher: FSWatcher = watch(path, { persistent: false }, () => listener());
    return watcher;
  },
};

export interface PiTranscriptTailer {
  close(): void;
}

/**
 * Bounded full-file Pi tailer. Pi session JSONL is append-only but may be atomically rewritten by
 * session operations, so avoiding byte-offset assumptions is safer in the initial implementation.
 * Already-emitted Pi entry IDs suppress duplicate updates after every re-read.
 */
export async function tailPiTranscript(input: {
  path: string;
  sessionId: string;
  onUpdate: (params: unknown) => void;
  fs?: PiTranscriptTailerFs;
  debounceMs?: number;
}): Promise<PiTranscriptTailer> {
  const fs = input.fs ?? nodeFs;
  const emitted = new Set<string>();
  const seed = parsePiTranscript(await fs.read(input.path));
  for (const entry of seed) if (entry.id) emitted.add(entry.id);

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rereading = false;
  let queued = false;
  const debounceMs = input.debounceMs ?? 75;

  const refresh = async () => {
    if (closed) return;
    if (rereading) {
      queued = true;
      return;
    }
    rereading = true;
    try {
      const entries = parsePiTranscript(await fs.read(input.path));
      const fresh = entries.filter((entry) => entry.id && !emitted.has(entry.id));
      for (const entry of fresh) emitted.add(entry.id!);
      if (fresh.length) {
        for (const entry of fresh) {
          for (const update of piEntryUpdates(input.sessionId, entry)) input.onUpdate(update);
        }
      }
    } catch {
      // A transient half-write, rename, or relay shutdown must not tear down the whole ACP session.
      // The next filesystem event retries; resuming can also recover durable history.
    } finally {
      rereading = false;
      if (queued) {
        queued = false;
        void refresh();
      }
    }
  };

  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
    timer.unref?.();
  };
  const watcher = fs.watch(input.path, schedule);
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
