/**
 * daemon/watcher.ts - Recursive directory watcher.
 *
 * Wraps Node's fs.watch to fire a single typed event per filesystem change
 * across a directory tree. macOS gets recursive watching for free; Linux's
 * inotify backend doesn't implement `recursive`, so we walk the tree at
 * startup and watch each directory, re-watching on dir-create events.
 *
 * We deliberately use native fs.watch instead of chokidar because chokidar
 * 5.0.0 fired zero events under Bun 1.3.6 during pre-impl smoke testing.
 * Native fs.watch correctly fires for both new file creation (`rename`)
 * and content changes (`change`). See docs/internal/daemon-prd.md.
 */

import { watch, type FSWatcher, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type WatcherEvent = {
  /**
   * fs.watch event type. `rename` covers file create/delete/move; `change`
   * covers in-place content modification.
   */
  type: "rename" | "change";
  /** Absolute path of the changed entry. */
  path: string;
};

export type WatcherHandle = {
  /** Number of directories currently being watched (relevant on Linux). */
  watchedCount(): number;
  /** Stop watching and release all FSWatcher instances. */
  close(): void;
};

const IS_MACOS = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";

/**
 * Watch a directory tree recursively. The callback fires for every fs.watch
 * event under `root`. Paths in events are absolute.
 *
 * The root must exist when watchRecursive is called; this is not a "watch
 * for the root to appear" primitive.
 */
export function watchRecursive(
  root: string,
  onEvent: (event: WatcherEvent) => void,
): WatcherHandle {
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) {
    throw new Error(`watchRecursive: root does not exist: ${absRoot}`);
  }

  // Native recursive support on macOS and Windows. On Linux we walk + watch.
  const useNativeRecursive = IS_MACOS || IS_WINDOWS;
  const watchers = new Map<string, FSWatcher>();

  const handleEvent = (dir: string, type: "rename" | "change", filename: string | null) => {
    if (!filename) return; // some FS backends emit null filenames; we can't act on those
    const full = resolve(dir, filename);
    onEvent({ type, path: full });
    // On Linux fallback, a `rename` event on a directory may mean a new
    // subdirectory was just created — start watching it too.
    if (!useNativeRecursive && type === "rename") {
      try {
        const stat = statSync(full);
        if (stat.isDirectory() && !watchers.has(full)) {
          watchDirNonRecursive(full);
        }
      } catch {
        // Path was deleted between event and stat; ignore.
      }
    }
  };

  const watchDirNonRecursive = (dir: string) => {
    if (watchers.has(dir)) return;
    try {
      const w = watch(dir, (eventType, filename) => {
        handleEvent(dir, eventType as "rename" | "change", filename);
      });
      w.on("error", () => {
        // Directory was deleted or otherwise became unwatchable. Drop it.
        watchers.delete(dir);
      });
      watchers.set(dir, w);
    } catch {
      // EACCES, ENOENT, etc. — skip this directory rather than failing the whole watch.
    }
  };

  if (useNativeRecursive) {
    const w = watch(absRoot, { recursive: true }, (eventType, filename) => {
      handleEvent(absRoot, eventType as "rename" | "change", filename);
    });
    watchers.set(absRoot, w);
  } else {
    // Linux: walk the tree at startup, watch each directory.
    const stack: string[] = [absRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      watchDirNonRecursive(dir);
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) stack.push(join(dir, entry.name));
        }
      } catch {
        // Permission or vanished entry; skip silently.
      }
    }
  }

  return {
    watchedCount() {
      return watchers.size;
    },
    close() {
      for (const w of watchers.values()) {
        try { w.close(); } catch {}
      }
      watchers.clear();
    },
  };
}
