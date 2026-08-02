/**
 * test/daemon-queue.test.ts
 *
 * Unit tests for the per-project debounce queue. Uses short debounce
 * windows so the suite runs quickly.
 */

import { describe, expect, test } from "bun:test";
import { createDebounceQueue } from "../src/daemon/queue";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createDebounceQueue", () => {
  test("schedule + wait fires onFlush exactly once", async () => {
    const calls: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 50,
      onFlush: (id) => { calls.push(id); },
    });

    q.schedule("proj-a");
    await settle(100);

    expect(calls).toEqual(["proj-a"]);
    expect(q.pending()).toBe(0);
    q.close();
  });

  test("schedule N times within the window coalesces to one onFlush", async () => {
    const calls: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 100,
      onFlush: (id) => { calls.push(id); },
    });

    q.schedule("proj-a");
    await settle(20);
    q.schedule("proj-a");
    await settle(20);
    q.schedule("proj-a");
    await settle(150);

    expect(calls).toEqual(["proj-a"]);
    q.close();
  });

  test("different projects have independent timers", async () => {
    const calls: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 50,
      onFlush: (id) => { calls.push(id); },
    });

    q.schedule("proj-a");
    q.schedule("proj-b");
    q.schedule("proj-c");
    expect(q.pending()).toBe(3);
    await settle(100);

    expect(calls.sort()).toEqual(["proj-a", "proj-b", "proj-c"]);
    expect(q.pending()).toBe(0);
    q.close();
  });

  test("flush() fires immediately and cancels the debounce", async () => {
    const calls: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 10_000, // very long; would never naturally fire
      onFlush: (id) => { calls.push(id); },
    });

    q.schedule("proj-a");
    expect(q.pending()).toBe(1);
    await q.flush("proj-a");

    expect(calls).toEqual(["proj-a"]);
    expect(q.pending()).toBe(0);
    q.close();
  });

  test("flush() with no pending timer still fires onFlush", async () => {
    const calls: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 100,
      onFlush: (id) => { calls.push(id); },
    });

    await q.flush("proj-fresh");

    expect(calls).toEqual(["proj-fresh"]);
    q.close();
  });

  test("close() prevents pending timers from firing", async () => {
    const calls: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 50,
      onFlush: (id) => { calls.push(id); },
    });

    q.schedule("proj-a");
    q.schedule("proj-b");
    q.close();
    await settle(100);

    expect(calls).toEqual([]);
  });

  test("close() prevents subsequent schedule() from registering", async () => {
    const calls: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 50,
      onFlush: (id) => { calls.push(id); },
    });

    q.close();
    q.schedule("proj-a");
    await settle(100);

    expect(calls).toEqual([]);
    expect(q.pending()).toBe(0);
  });

  test("onFlush errors are logged but don't crash the queue", async () => {
    const logs: string[] = [];
    const q = createDebounceQueue({
      debounceMs: 30,
      onFlush: () => { throw new Error("simulated"); },
      log: (m) => logs.push(m),
    });

    q.schedule("proj-a");
    await settle(80);

    expect(logs.some((m) => m.includes("simulated"))).toBe(true);

    // Queue still works after the error.
    const calls: string[] = [];
    const q2 = createDebounceQueue({
      debounceMs: 30,
      onFlush: (id) => { calls.push(id); },
    });
    q2.schedule("proj-b");
    await settle(80);
    expect(calls).toEqual(["proj-b"]);

    q.close();
    q2.close();
  });

  test("isPending() reflects per-project state", async () => {
    const q = createDebounceQueue({
      debounceMs: 200,
      onFlush: () => {},
    });

    expect(q.isPending("proj-a")).toBe(false);
    q.schedule("proj-a");
    expect(q.isPending("proj-a")).toBe(true);
    expect(q.isPending("proj-b")).toBe(false);

    await q.flush("proj-a");
    expect(q.isPending("proj-a")).toBe(false);

    q.close();
  });
});
