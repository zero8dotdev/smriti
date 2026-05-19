/**
 * daemon/index.ts - Top-level daemon entry point.
 *
 * Wires the five core modules into one process:
 *
 *   FS event ─► resolveAgentForPath ─► queue.schedule ─┐
 *                                                       ├─► onFlush ─► fresh DB ─► ingest() ─► close DB
 *   hook poke ─► server.onPoke ─► queue.flush("claude")─┘
 *
 * Open a fresh SQLite handle per flush (not once at boot) per smoke-test
 * finding 3 — repeatedly calling ingest() against a single long-lived
 * connection segfaulted Bun 1.3.6. See docs/internal/daemon-prd.md.
 *
 * The runDaemon function is dependency-injectable: tests pass a mock
 * flushAgent so they can verify the wiring without touching the user's
 * real DB or spawning real agent log files.
 */

import { QMD_DB_PATH } from "../config";
import { initSmriti } from "../db";
import { ingest } from "../ingest";
import { startDaemon as startServer, type DaemonHandle } from "./server";
import { watchRecursive, type WatcherHandle } from "./watcher";
import { createDebounceQueue, type DebounceQueueHandle } from "./queue";
import {
  getDefaultAgentRoots,
  resolveAgentForPath,
  type AgentRoot,
} from "./handlers";

export type RunDaemonOptions = {
  /** Override the agent roots to watch. Defaults to getDefaultAgentRoots(). */
  agentRoots?: AgentRoot[];
  /**
   * Override the per-flush callback. Defaults to opening a fresh DB
   * handle, calling ingest(db, agent), and closing the handle. Tests
   * use this to verify wiring without invoking the real ingest path.
   */
  flushAgent?: (agent: string) => void | Promise<void>;
  /** Optional logger. Defaults to console.error (so stderr, not stdout). */
  log?: (msg: string) => void;
  /** Override the per-project debounce window in ms. */
  debounceMs?: number;
};

export type RunningDaemon = {
  /** Daemon PID. */
  pid: number;
  /** Number of agent roots being watched. */
  watchedAgents: string[];
  /** Stop the daemon and release all resources. Idempotent. */
  shutdown(): Promise<void>;
};

/**
 * Default per-flush behavior: open SQLite, call ingest(), close SQLite.
 * Errors are logged but not rethrown — one bad flush should not crash
 * the daemon.
 */
async function defaultFlushAgent(agent: string, log: (m: string) => void): Promise<void> {
  let db;
  try {
    db = await initSmriti(QMD_DB_PATH);
  } catch (err) {
    log(`[flush ${agent}] failed to open DB: ${(err as Error).message}`);
    return;
  }
  try {
    const r = await ingest(db, agent);
    log(
      `[flush ${agent}] ingested=${r.sessionsIngested}/${r.sessionsFound}, ` +
      `msgs=${r.messagesIngested}, errs=${r.errors.length}`,
    );
  } catch (err) {
    log(`[flush ${agent}] ingest failed: ${(err as Error).message}`);
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Start the daemon. Returns once everything is wired and the IPC
 * socket is bound. Throws if another daemon is already running.
 *
 * Caller is responsible for keeping the process alive. Typical usage
 * is to call this from `smriti daemon` and never return — the daemon
 * process lives until SIGTERM / SIGINT, at which point the installed
 * signal handlers from server.ts trigger a graceful shutdown.
 */
export async function runDaemon(opts: RunDaemonOptions = {}): Promise<RunningDaemon> {
  const log = opts.log ?? ((msg: string) => console.error(`[smriti] ${msg}`));
  const agentRoots = opts.agentRoots ?? getDefaultAgentRoots();

  if (agentRoots.length === 0) {
    log(
      "no agent roots found — none of ~/.claude/projects, ~/.codex, ~/.cline/tasks " +
      "exist on this machine. Daemon will still run but won't capture anything.",
    );
  }

  const flushAgent = opts.flushAgent ?? ((agent: string) => defaultFlushAgent(agent, log));

  const queue: DebounceQueueHandle = createDebounceQueue({
    debounceMs: opts.debounceMs,
    onFlush: flushAgent,
    log,
  });

  let server: DaemonHandle;
  try {
    server = await startServer({
      log,
      onPoke: () => {
        // The Claude Stop hook is the only thing that pokes today, so we
        // route every poke to a Claude flush. If we ever grow other-agent
        // hooks, the protocol gets a one-byte agent id.
        void queue.flush("claude");
      },
    });
  } catch (err) {
    queue.close();
    throw err;
  }

  const watchers: WatcherHandle[] = [];
  for (const { agent, root } of agentRoots) {
    try {
      const w = watchRecursive(root, (event) => {
        const resolved = resolveAgentForPath(event.path, agentRoots);
        if (resolved === null) return; // event not under any watched root (shouldn't happen)
        queue.schedule(resolved);
      });
      watchers.push(w);
      log(`watching ${agent} at ${root}`);
    } catch (err) {
      log(`failed to watch ${agent} at ${root}: ${(err as Error).message}`);
    }
  }

  let shutdownPromise: Promise<void> | null = null;
  return {
    pid: server.pid,
    watchedAgents: agentRoots.map((r) => r.agent),
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        for (const w of watchers) {
          try { w.close(); } catch {}
        }
        queue.close();
        await server.shutdown();
      })();
      return shutdownPromise;
    },
  };
}
