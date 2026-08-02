/**
 * daemon/queue.ts - Per-project debounce queue.
 *
 * The daemon receives a stream of filesystem events from the watcher and
 * a stream of pokes from the Stop hook. Both feed into this queue, which
 * coalesces bursts and triggers a single ingest per project per quiet
 * window.
 *
 * Why per-project, not global: a busy session in project A shouldn't
 * delay project B's ingest. Each project gets its own timer; resetting
 * one doesn't affect the others.
 *
 * The queue is intentionally decoupled from the ingest call itself.
 * Callers wire `onFlush` to whatever should happen when a project goes
 * quiet — typically: open a fresh SQLite handle, call ingest(),
 * close the handle. (Per smoke-test finding 3, we do not reuse a
 * single DB connection across flushes.)
 */

import { DAEMON_DEBOUNCE_MS } from "../config";

export type DebounceQueueOptions = {
  /** Debounce window in ms. Defaults to DAEMON_DEBOUNCE_MS (30s). */
  debounceMs?: number;
  /** Called when a project's debounce timer fires. May be async. */
  onFlush: (projectId: string) => void | Promise<void>;
  /** Optional logger. Defaults to a no-op. */
  log?: (msg: string) => void;
};

export type DebounceQueueHandle = {
  /**
   * Reset the debounce timer for this project. If a timer is already
   * running, it's cleared and restarted. Otherwise a new timer is
   * scheduled.
   */
  schedule(projectId: string): void;
  /**
   * Immediately invoke onFlush for this project, canceling any pending
   * debounce. Returns once onFlush resolves (or throws — errors are
   * propagated, the caller decides how to handle them).
   */
  flush(projectId: string): Promise<void>;
  /** Number of projects with a pending debounce timer. */
  pending(): number;
  /** Whether this project has a pending timer. */
  isPending(projectId: string): boolean;
  /** Cancel all pending timers. Pending onFlush callbacks are NOT executed. */
  close(): void;
};

export function createDebounceQueue(opts: DebounceQueueOptions): DebounceQueueHandle {
  const debounceMs = opts.debounceMs ?? DAEMON_DEBOUNCE_MS;
  const log = opts.log ?? (() => {});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const runFlush = async (projectId: string) => {
    timers.delete(projectId);
    try {
      await opts.onFlush(projectId);
    } catch (err) {
      log(`onFlush error for ${projectId}: ${(err as Error).message}`);
    }
  };

  return {
    schedule(projectId: string) {
      if (closed) return;
      const existing = timers.get(projectId);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => { void runFlush(projectId); }, debounceMs);
      // Don't keep Node alive solely for this timer — daemon process lifetime
      // is owned by the server, not the queue.
      if (typeof handle.unref === "function") handle.unref();
      timers.set(projectId, handle);
    },

    async flush(projectId: string) {
      if (closed) return;
      const existing = timers.get(projectId);
      if (existing) clearTimeout(existing);
      timers.delete(projectId);
      await opts.onFlush(projectId);
    },

    pending() {
      return timers.size;
    },

    isPending(projectId: string) {
      return timers.has(projectId);
    },

    close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
