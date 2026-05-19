/**
 * test/daemon-server.test.ts
 *
 * Unit tests for the daemon single-instance + lifecycle primitives.
 * Focused on detectRunningDaemon() and the startDaemon() happy path.
 *
 * The IPC socket and ingest wiring is covered in higher-level tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DAEMON_PID_FILE, DAEMON_SOCKET_FILE } from "../src/config";
import { detectRunningDaemon, startDaemon } from "../src/daemon/server";

// Helpers ------------------------------------------------------------

function cleanupDaemonState() {
  try { rmSync(DAEMON_PID_FILE, { force: true }); } catch {}
  try { rmSync(DAEMON_SOCKET_FILE, { force: true }); } catch {}
}

function ensureCacheDir() {
  mkdirSync(dirname(DAEMON_PID_FILE), { recursive: true });
}

// detectRunningDaemon -----------------------------------------------

describe("detectRunningDaemon", () => {
  beforeEach(cleanupDaemonState);
  afterEach(cleanupDaemonState);

  test("returns null when no PID file exists", () => {
    expect(detectRunningDaemon()).toBeNull();
  });

  test("returns null and cleans up when PID file holds a dead PID", () => {
    ensureCacheDir();
    // PID 1 is init/launchd on every Unix — we can't probe it without
    // permission, but PID 0 is reserved and always reports ESRCH. Picking
    // something high and unlikely:
    const deadPid = 999999;
    writeFileSync(DAEMON_PID_FILE, String(deadPid));
    expect(detectRunningDaemon()).toBeNull();
    expect(existsSync(DAEMON_PID_FILE)).toBe(false); // stale file cleaned
  });

  test("returns null and cleans up garbage PID files", () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, "not-a-number");
    expect(detectRunningDaemon()).toBeNull();
    expect(existsSync(DAEMON_PID_FILE)).toBe(false);
  });

  test("returns our own PID when the PID file points at us", () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, String(process.pid));
    expect(detectRunningDaemon()).toBe(process.pid);
    // Our PID file should still be there — it's a live PID.
    expect(existsSync(DAEMON_PID_FILE)).toBe(true);
  });

  test("returns null for an empty PID file", () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, "");
    expect(detectRunningDaemon()).toBeNull();
    expect(existsSync(DAEMON_PID_FILE)).toBe(false);
  });
});

// startDaemon -------------------------------------------------------

describe("startDaemon", () => {
  beforeEach(cleanupDaemonState);
  afterEach(cleanupDaemonState);

  test("writes PID file and binds socket, shutdown() reverses both", async () => {
    const logs: string[] = [];
    const handle = await startDaemon({ log: (m) => logs.push(m) });

    expect(handle.pid).toBe(process.pid);
    expect(existsSync(DAEMON_PID_FILE)).toBe(true);
    expect(existsSync(DAEMON_SOCKET_FILE)).toBe(true);
    expect(readFileSync(DAEMON_PID_FILE, "utf-8").trim()).toBe(String(process.pid));

    await handle.shutdown();

    expect(existsSync(DAEMON_PID_FILE)).toBe(false);
    expect(existsSync(DAEMON_SOCKET_FILE)).toBe(false);
  });

  test("throws when another live daemon owns the PID file", async () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, String(process.pid)); // pretend a live daemon
    await expect(startDaemon({ log: () => {} })).rejects.toThrow(/already running/i);
    // Our pre-seeded PID file should be untouched.
    expect(existsSync(DAEMON_PID_FILE)).toBe(true);
  });

  test("succeeds and overwrites when the existing PID file is stale", async () => {
    ensureCacheDir();
    writeFileSync(DAEMON_PID_FILE, "999999"); // dead pid
    const handle = await startDaemon({ log: () => {} });
    expect(readFileSync(DAEMON_PID_FILE, "utf-8").trim()).toBe(String(process.pid));
    await handle.shutdown();
  });

  test("shutdown() is idempotent", async () => {
    const handle = await startDaemon({ log: () => {} });
    await handle.shutdown();
    await handle.shutdown(); // second call should be a no-op, not throw
    expect(existsSync(DAEMON_PID_FILE)).toBe(false);
  });

  test("onPoke fires when a client connects to the socket", async () => {
    let pokes = 0;
    const handle = await startDaemon({
      log: () => {},
      onPoke: () => { pokes += 1; },
    });

    // Connect via Bun's net client and immediately close.
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(DAEMON_SOCKET_FILE, () => {
        conn.end();
      });
      conn.on("close", () => resolve());
      conn.on("error", reject);
    });

    // Allow the poke handler to run (it's invoked from the connection callback).
    await new Promise((r) => setTimeout(r, 50));
    expect(pokes).toBe(1);

    await handle.shutdown();
  });
});
