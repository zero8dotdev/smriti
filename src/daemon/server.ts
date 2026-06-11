/**
 * daemon/server.ts - Smriti daemon server core.
 *
 * Owns:
 *   - Single-instance enforcement via PID file + kill(pid, 0) liveness probe.
 *     We use this pattern instead of Unix-socket bind contention because Bun's
 *     net.createServer().listen(path) silently succeeds on duplicate binds and
 *     steals connections from the original — verified during pre-impl smoke
 *     tests. See docs/internal/daemon-prd.md.
 *   - The IPC Unix socket for hook pokes (one server, many short-lived clients).
 *   - SIGTERM / SIGINT graceful shutdown with PID-file and socket-file cleanup.
 *
 * Out of scope (handled in other modules):
 *   - FS watching (watcher.ts)
 *   - Per-project debounce queue (queue.ts)
 *   - Ingest dispatch
 *   - Stop / status CLI client (client.ts)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type Server } from "node:net";

import {
  DAEMON_PID_FILE,
  DAEMON_SOCKET_FILE,
} from "../config";

export type DaemonHandle = {
  /** PID of the running daemon (this process). */
  pid: number;
  /** Path of the bound IPC socket. */
  socketPath: string;
  /** Path of the PID file. */
  pidFile: string;
  /** Graceful shutdown — close socket, remove PID + socket files. Idempotent. */
  shutdown(): Promise<void>;
};

export type DaemonOptions = {
  /** Called when a poke is received on the IPC socket. */
  onPoke?: () => void | Promise<void>;
  /** Override the default console logger. */
  log?: (msg: string) => void;
};

/**
 * Return the PID of the currently running daemon, or null if none is running.
 *
 * Reads DAEMON_PID_FILE. If it exists and the named process is alive
 * (probed via kill(pid, 0)), returns that PID. If the PID file exists but
 * the process is gone (ESRCH), the stale PID file is unlinked and null is
 * returned. Garbage PID files are likewise cleaned and treated as absent.
 */
export function detectRunningDaemon(): number | null {
  if (!existsSync(DAEMON_PID_FILE)) return null;

  let raw: string;
  try {
    raw = readFileSync(DAEMON_PID_FILE, "utf-8").trim();
  } catch {
    return null;
  }

  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    // Garbage PID file — clean it up so the next start succeeds.
    try { unlinkSync(DAEMON_PID_FILE); } catch {}
    return null;
  }

  try {
    process.kill(pid, 0); // signal 0 is a liveness probe; throws if no such process
    return pid;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // Process is gone. Stale PID file — clean and report not-running.
      try { unlinkSync(DAEMON_PID_FILE); } catch {}
      return null;
    }
    // EPERM means the process exists but is owned by someone else. Treat as
    // running — we should not start a second daemon on top of it.
    if (code === "EPERM") return pid;
    throw err;
  }
}

/**
 * Start the daemon in the current process. Returns a handle whose shutdown()
 * cleans up the PID file and IPC socket. Throws if another daemon is already
 * running (its PID is included in the error message).
 *
 * Caller is responsible for keeping the process alive — startDaemon itself
 * returns once the socket is bound. Typical usage is to call this from a
 * long-running entry point (`smriti daemon`) and never return.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const existing = detectRunningDaemon();
  if (existing !== null) {
    throw new Error(`Smriti daemon already running (PID ${existing})`);
  }

  const pid = process.pid;
  const log = opts.log ?? ((msg: string) => console.log(`[daemon ${pid}] ${msg}`));

  // Ensure the cache directory exists (creates both pid and socket parents).
  mkdirSync(dirname(DAEMON_PID_FILE), { recursive: true });

  // Write our PID. From this point on, anyone calling detectRunningDaemon()
  // will see us as the running daemon.
  writeFileSync(DAEMON_PID_FILE, `${pid}\n`);
  log(`started, pid=${pid}`);

  // Clean any stale socket file from a previous crash. We've already
  // established (via PID-file check above) that no live daemon owns it.
  try { unlinkSync(DAEMON_SOCKET_FILE); } catch {}

  const onPoke = opts.onPoke ?? (() => log("got poke"));

  const server: Server = createServer((conn) => {
    // Drain any incoming bytes (the poke protocol is "any connection wakes us").
    conn.on("data", () => {});
    conn.on("error", () => {});
    conn.on("end", () => {});
    Promise.resolve(onPoke()).catch((e: Error) => log(`poke handler error: ${e.message}`));
    conn.end();
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => { server.removeListener("listening", onOk); reject(err); };
    const onOk = () => { server.removeListener("error", onErr); resolve(); };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(DAEMON_SOCKET_FILE);
  });

  log(`bound socket at ${DAEMON_SOCKET_FILE}`);

  let shutdownPromise: Promise<void> | null = null;
  const handle: DaemonHandle = {
    pid,
    socketPath: DAEMON_SOCKET_FILE,
    pidFile: DAEMON_PID_FILE,
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        log("shutting down");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try { unlinkSync(DAEMON_SOCKET_FILE); } catch {}
        try { unlinkSync(DAEMON_PID_FILE); } catch {}
        log("stopped");
      })();
      return shutdownPromise;
    },
  };

  // Install signal handlers for graceful shutdown. Exit with conventional
  // signal-derived status (128 + signo) so process supervisors can tell.
  const installSignal = (sig: "SIGINT" | "SIGTERM", signo: number) => {
    process.on(sig, () => {
      log(`received ${sig}`);
      handle.shutdown()
        .then(() => process.exit(128 + signo))
        .catch((e: Error) => { console.error("shutdown error:", e); process.exit(1); });
    });
  };
  installSignal("SIGINT", 2);
  installSignal("SIGTERM", 15);

  return handle;
}
