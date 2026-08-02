/**
 * test/store.test.ts
 *
 * Verifies closeDb()/closeQmdStore() dispose the QMD store's LlamaCpp/Llama
 * backend, not just the SQLite handle — otherwise a fresh Store created on
 * the next initSmriti() call (e.g. the daemon's per-flush open) can overlap
 * with the still-loaded previous instance and leak memory between flushes.
 */
import { test, expect } from "bun:test";
import { initSmriti, closeDb } from "../src/db";
import { getQmdStore } from "../src/store";

test("closeDb disposes the QMD store's LLM backend, not just the SQLite handle", async () => {
  await initSmriti(":memory:");
  const store = getQmdStore();

  let disposeCalls = 0;
  if (store.internal.llm) {
    (store.internal.llm as any).dispose = async () => { disposeCalls++; };
  }

  await closeDb();

  expect(disposeCalls).toBe(1);
  expect(() => getQmdStore()).toThrow();
});

test("closeDb is safe to call again after initSmriti() re-opens", async () => {
  await initSmriti(":memory:");
  await closeDb();
  await initSmriti(":memory:");
  await closeDb(); // should not throw
});
