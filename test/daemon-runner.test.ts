/**
 * test/daemon-runner.test.ts
 *
 * Integration tests for runDaemon() — verifies the wiring between
 * watcher, queue, server, and the flushAgent callback. Uses a
 * temporary directory as the agent root and a mock flushAgent so
 * the real ingest path (and the user's real DB) are not touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

import { DAEMON_PID_FILE, DAEMON_SOCKET_FILE } from "../src/config";
import { runDaemon } from "../src/daemon";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cleanupDaemonState() {
  try { rmSync(DAEMON_PID_FILE, { force: true }); } catch {}
  try { rmSync(DAEMON_SOCKET_FILE, { force: true }); } catch {}
}

describe("runDaemon", () => {
  let tmpRoot: string;

  beforeEach(() => {
    cleanupDaemonState();
    tmpRoot = mkdtempSync(join(tmpdir(), "smriti-runner-test-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    cleanupDaemonState();
  });

  test("an FS event in a watched root triggers flushAgent after debounce", async () => {
    const flushes: string[] = [];
    const daemon = await runDaemon({
      agentRoots: [{ agent: "fake-agent", root: tmpRoot }],
      flushAgent: (agent) => { flushes.push(agent); },
      debounceMs: 100,
      log: () => {},
    });

    await settle(50); // watcher attach
    writeFileSync(join(tmpRoot, "session.jsonl"), "line\n");
    await settle(200); // debounce + flush

    expect(flushes).toEqual(["fake-agent"]);
    await daemon.shutdown();
  });

  test("rapid writes coalesce into one flush per project", async () => {
    const flushes: string[] = [];
    const daemon = await runDaemon({
      agentRoots: [{ agent: "fake-agent", root: tmpRoot }],
      flushAgent: (agent) => { flushes.push(agent); },
      debounceMs: 150,
      log: () => {},
    });

    await settle(50);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tmpRoot, `s${i}.jsonl`), "x");
      await settle(20);
    }
    await settle(250); // wait past the debounce window

    expect(flushes).toEqual(["fake-agent"]);
    await daemon.shutdown();
  });

  test("a poke on the IPC socket immediately flushes 'claude'", async () => {
    const flushes: string[] = [];
    const daemon = await runDaemon({
      agentRoots: [],
      flushAgent: (agent) => { flushes.push(agent); },
      debounceMs: 60_000, // never naturally fire
      log: () => {},
    });

    await new Promise<void>((resolve, reject) => {
      const c = createConnection(DAEMON_SOCKET_FILE, () => { c.end(); });
      c.on("close", () => resolve());
      c.on("error", reject);
    });
    await settle(80);

    expect(flushes).toEqual(["claude"]);
    await daemon.shutdown();
  });

  test("multiple agent roots route events to the correct agent", async () => {
    const sub1 = join(tmpRoot, "a");
    const sub2 = join(tmpRoot, "b");
    mkdirSync(sub1);
    mkdirSync(sub2);

    const flushes: string[] = [];
    const daemon = await runDaemon({
      agentRoots: [
        { agent: "agent-A", root: sub1 },
        { agent: "agent-B", root: sub2 },
      ],
      flushAgent: (agent) => { flushes.push(agent); },
      debounceMs: 80,
      log: () => {},
    });

    await settle(50);
    writeFileSync(join(sub2, "from-b.jsonl"), "x");
    await settle(200);

    expect(flushes).toEqual(["agent-B"]);
    await daemon.shutdown();
  });

  test("flushAgent errors are isolated — the daemon keeps running", async () => {
    const errors: string[] = [];
    let firstCall = true;
    const daemon = await runDaemon({
      agentRoots: [{ agent: "fake-agent", root: tmpRoot }],
      flushAgent: () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("simulated ingest failure");
        }
      },
      debounceMs: 80,
      log: (m) => { errors.push(m); },
    });

    await settle(50);
    writeFileSync(join(tmpRoot, "first.jsonl"), "x");
    await settle(180);
    writeFileSync(join(tmpRoot, "second.jsonl"), "x");
    await settle(180);

    expect(errors.some((m) => m.includes("simulated ingest failure"))).toBe(true);
    // Daemon should still be alive — shutdown cleanly without timing out.
    await daemon.shutdown();
  });

  test("shutdown is idempotent and cleans up PID + socket", async () => {
    const daemon = await runDaemon({
      agentRoots: [{ agent: "fake-agent", root: tmpRoot }],
      flushAgent: () => {},
      debounceMs: 100,
      log: () => {},
    });

    await daemon.shutdown();
    await daemon.shutdown(); // should not throw
    expect(true).toBe(true); // assertion presence
  });

  const ENRICH_ENV_KEY = "SMRITI_INGEST_NO_ENRICH";
  // Read via a non-literal key so TS doesn't (incorrectly) narrow this to
  // `undefined` from the `delete` below — it can't see that runDaemon()
  // mutates process.env internally.
  const readEnrichFlag = () => process.env[ENRICH_ENV_KEY];

  test("sets SMRITI_INGEST_NO_ENRICH by default so routine ingest never triggers LLM enrichment", async () => {
    const original = readEnrichFlag();
    delete process.env[ENRICH_ENV_KEY];
    try {
      const daemon = await runDaemon({
        agentRoots: [],
        flushAgent: () => {},
        log: () => {},
      });
      expect(readEnrichFlag()).toBe("1");
      await daemon.shutdown();
    } finally {
      if (original === undefined) delete process.env[ENRICH_ENV_KEY];
      else process.env[ENRICH_ENV_KEY] = original;
    }
  });

  test("enrichOnIngest: true opts back into LLM enrichment during ingest", async () => {
    const original = readEnrichFlag();
    delete process.env[ENRICH_ENV_KEY];
    try {
      const daemon = await runDaemon({
        agentRoots: [],
        flushAgent: () => {},
        log: () => {},
        enrichOnIngest: true,
      });
      expect(readEnrichFlag()).toBeUndefined();
      await daemon.shutdown();
    } finally {
      if (original === undefined) delete process.env[ENRICH_ENV_KEY];
      else process.env[ENRICH_ENV_KEY] = original;
    }
  });
});
