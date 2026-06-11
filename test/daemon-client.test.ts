/**
 * test/daemon-client.test.ts
 *
 * Unit tests for the daemon lifecycle client (getDaemonStatus + stopDaemon).
 * Tests work through the PID file rather than spawning real subprocesses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DAEMON_PID_FILE, DAEMON_SOCKET_FILE } from "../src/config";
import { getDaemonStatus, stopDaemon } from "../src/daemon/client";

function cleanupDaemonState() {
  try { rmSync(DAEMON_PID_FILE, { force: true }); } catch {}
  try { rmSync(DAEMON_SOCKET_FILE, { force: true }); } catch {}
}

function ensureCacheDir() {
  mkdirSync(dirname(DAEMON_PID_FILE), { recursive: true });
}

describe("getDaemonStatus", () => {
  beforeEach(cleanupDaemonState);
  afterEach(cleanupDaemonState);

  test("returns not-running when no PID file exists", () => {
    const s = getDaemonStatus();
    expect(s.running).toBe(false);
    expect(s.pid).toBeNull();
    expect(s.startedAt).toBeNull();
    expect(s.pidFile).toBe(DAEMON_PID_FILE);
  });

  test("returns not-running and cleans up when PID file is stale", () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, "999999");
    const s = getDaemonStatus();
    expect(s.running).toBe(false);
    // detectRunningDaemon should have removed the stale file
    expect(existsSync(DAEMON_PID_FILE)).toBe(false);
  });

  test("returns running with PID and startedAt when our own PID is in the file", () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, String(process.pid));
    const s = getDaemonStatus();
    expect(s.running).toBe(true);
    expect(s.pid).toBe(process.pid);
    expect(s.startedAt).toBeInstanceOf(Date);
    // PID file was just written; startedAt should be very recent.
    expect(Date.now() - s.startedAt!.getTime()).toBeLessThan(2000);
  });
});

describe("stopDaemon", () => {
  beforeEach(cleanupDaemonState);
  afterEach(cleanupDaemonState);

  test("returns not-running when no daemon is running", async () => {
    const r = await stopDaemon();
    expect(r.state).toBe("not-running");
  });

  test("returns not-running when PID file holds a dead PID", async () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, "999999"); // dead pid; detectRunningDaemon cleans + returns null
    const r = await stopDaemon();
    expect(r.state).toBe("not-running");
  });

  test("returns timeout when the daemon doesn't exit in the window", async () => {
    // Pin our own PID in the file. We won't actually receive SIGTERM in
    // this test process (the harness installs handlers), but the PID
    // file will keep saying we're alive, so stopDaemon will time out.
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, String(process.pid));

    // Disable any SIGTERM handler we may have inherited, just for this test.
    const sigtermListeners = process.listeners("SIGTERM");
    process.removeAllListeners("SIGTERM");
    // Reinstate a no-op so receiving SIGTERM doesn't kill the test runner.
    const noop = () => {};
    process.on("SIGTERM", noop);

    try {
      const r = await stopDaemon({ timeoutMs: 200, pollMs: 50 });
      expect(r.state).toBe("timeout");
      if (r.state === "timeout") {
        expect(r.pid).toBe(process.pid);
      }
    } finally {
      process.removeListener("SIGTERM", noop);
      for (const l of sigtermListeners) process.on("SIGTERM", l as any);
    }
  });
});
