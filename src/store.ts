/**
 * store.ts - QMD store singleton
 *
 * Holds the SDK-created QMDStore so both db.ts and memory.ts can access it
 * without creating a circular dependency chain.
 * No imports from db/memory/qmd — those all import from here, not vice versa.
 */

import type { QMDStore } from "../qmd/src/index";

let _store: QMDStore | null = null;

export function setQmdStore(s: QMDStore): void {
  _store = s;
}

export function getQmdStore(): QMDStore {
  if (!_store) throw new Error("QMD store not initialized — call initSmriti() first");
  return _store;
}

export function closeQmdStore(): void {
  if (_store) {
    _store.internal.close();
    _store = null;
  }
}
