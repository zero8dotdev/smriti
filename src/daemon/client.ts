/**
 * daemon/client.ts - Socket-less client primitives for `smriti daemon stop`
 * and `smriti daemon status`.
 *
 * Both commands work entirely through the PID file. They don't need to
 * connect to the IPC socket. This keeps the lifecycle commands working
 * even if the socket file is stale or the daemon is wedged in a way
 * that makes it unresponsive on the socket.
 *
 * - stop: read the PID, send SIGTERM, poll for exit.
 * - status: read the PID, probe liveness via kill(pid, 0), surface
 *   the PID-file mtime as a coarse "running since" indicator.
 */

import { statSync } from "node:fs";

import { DAEMON_PID_FILE } from "../config";
import { detectRunningDaemon } from "./server";

export type DaemonStatus = {
  /** True if a live daemon process owns the PID file. */
  running: boolean;
  /** Daemon PID, or null if not running. */
  pid: number | null;
  /**
   * When the PID file was written, as a Date. Used as a proxy for
   * "when the daemon started." Null if no PID file exists.
   */
  startedAt: Date | null;
  /** Path of the PID file inspected. Useful for error messages. */
  pidFile: string;
};

export function getDaemonStatus(): DaemonStatus {
  const pid = detectRunningDaemon();
  if (pid === null) {
    return { running: false, pid: null, startedAt: null, pidFile: DAEMON_PID_FILE };
  }
  let startedAt: Date | null = null;
  try {
    const stat = statSync(DAEMON_PID_FILE);
    // birthtime is set on macOS and most modern Linux filesystems. Fall
    // back to ctime if birthtime is the epoch.
    startedAt = stat.birthtime.getTime() === 0 ? stat.ctime : stat.birthtime;
  } catch {
    // PID file vanished between the detect call and statSync; the daemon
    // is racing us out of existence. Report as not-running for safety.
    return { running: false, pid: null, startedAt: null, pidFile: DAEMON_PID_FILE };
  }
  return { running: true, pid, startedAt, pidFile: DAEMON_PID_FILE };
}

export type StopResult =
  | { state: "stopped"; pid: number }
  | { state: "not-running" }
  | { state: "timeout"; pid: number };

/**
 * Stop the running daemon by sending SIGTERM and waiting for the PID
 * file to disappear (which the daemon's signal handler does as part of
 * graceful shutdown).
 *
 * Returns:
 *   - { state: "stopped", pid } if the daemon exited within the timeout.
 *   - { state: "not-running" } if no daemon was running to begin with.
 *   - { state: "timeout", pid } if the daemon didn't exit in time.
 *     Caller may want to escalate (SIGKILL) or surface to the user.
 */
export async function stopDaemon(opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<StopResult> {
  const pid = detectRunningDaemon();
  if (pid === null) return { state: "not-running" };

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "not-running" };
    throw err;
  }

  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (detectRunningDaemon() === null) return { state: "stopped", pid };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { state: "timeout", pid };
}
