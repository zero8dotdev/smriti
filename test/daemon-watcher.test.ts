/**
 * test/daemon-watcher.test.ts
 *
 * Unit tests for watchRecursive(). Uses temporary directories so they're
 * deterministic and don't depend on the user's real Claude/Codex state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchRecursive, type WatcherEvent } from "../src/daemon/watcher";

// Helpers ------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "smriti-watcher-test-"));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

/** Wait briefly for fs.watch events to flush. macOS FSEvents has a small delay. */
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// Tests --------------------------------------------------------------

// The daemon is deferred on Windows (see release notes); Bun's fs.watch on
// win32 hard-crashes the test process, so skip the suite there entirely.
describe.skipIf(process.platform === "win32")("watchRecursive", () => {
  test("throws if root does not exist", () => {
    expect(() =>
      watchRecursive(join(tmpRoot, "does-not-exist"), () => {}),
    ).toThrow(/root does not exist/);
  });

  test("fires events for direct-child file creation", async () => {
    const events: WatcherEvent[] = [];
    const w = watchRecursive(tmpRoot, (e) => events.push(e));

    await settle(50); // give the watcher a moment to attach
    writeFileSync(join(tmpRoot, "a.txt"), "hello");
    await settle();

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.path.endsWith("a.txt"))).toBe(true);

    w.close();
  });

  test("fires events for files in subdirectories (recursive)", async () => {
    const sub = join(tmpRoot, "subA", "subB");
    mkdirSync(sub, { recursive: true });

    const events: WatcherEvent[] = [];
    const w = watchRecursive(tmpRoot, (e) => events.push(e));
    await settle(50);

    writeFileSync(join(sub, "deep.txt"), "hello");
    await settle();

    expect(events.some((e) => e.path.endsWith("deep.txt"))).toBe(true);
    w.close();
  });

  test("fires events for content changes (not just creation)", async () => {
    const file = join(tmpRoot, "log.jsonl");
    writeFileSync(file, "first\n");

    const events: WatcherEvent[] = [];
    const w = watchRecursive(tmpRoot, (e) => events.push(e));
    await settle(50);

    writeFileSync(file, "first\nsecond\n");
    await settle();

    // Either 'rename' or 'change' is acceptable depending on backend
    // (macOS FSEvents tends to fire 'rename' even for content edits in
    // some cases). The important thing is *something* fired for this path.
    expect(events.some((e) => e.path.endsWith("log.jsonl"))).toBe(true);
    w.close();
  });

  test("emits absolute paths, not relative ones", async () => {
    const events: WatcherEvent[] = [];
    const w = watchRecursive(tmpRoot, (e) => events.push(e));
    await settle(50);

    writeFileSync(join(tmpRoot, "abs.txt"), "x");
    await settle();

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.path.startsWith("/")).toBe(true);
    }
    w.close();
  });

  test("close() stops further events", async () => {
    const events: WatcherEvent[] = [];
    const w = watchRecursive(tmpRoot, (e) => events.push(e));
    await settle(50);

    w.close();

    writeFileSync(join(tmpRoot, "after-close.txt"), "x");
    await settle();

    expect(events.find((e) => e.path.endsWith("after-close.txt"))).toBeUndefined();
  });

  test("watchedCount() reflects the watcher topology", async () => {
    // On macOS/Windows: native recursive = exactly 1 watcher.
    // On Linux: walk-and-watch produces one watcher per directory.
    mkdirSync(join(tmpRoot, "a", "b"), { recursive: true });
    mkdirSync(join(tmpRoot, "c"));

    const w = watchRecursive(tmpRoot, () => {});
    const count = w.watchedCount();

    if (process.platform === "darwin" || process.platform === "win32") {
      expect(count).toBe(1);
    } else {
      // Linux: root + a + a/b + c = 4 dirs
      expect(count).toBeGreaterThanOrEqual(4);
    }

    w.close();
    expect(w.watchedCount()).toBe(0);
  });
});
