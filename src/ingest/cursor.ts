/**
 * cursor.ts - Cursor IDE conversation parser
 *
 * Reads conversation data from two sources:
 *
 * 1. Cursor app SQLite databases (primary):
 *    ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *    cursorDiskKV table: composerData:<id> and bubbleId:<composerId>:<bubbleId>
 *
 * 2. Project .cursor/ JSON files (legacy / fallback):
 *    <project>/.cursor/**\/*.json
 *
 * macOS:   ~/Library/Application Support/Cursor/User/
 * Linux:   ~/.config/Cursor/User/
 * Windows: %APPDATA%\Cursor\User\
 *
 * Override root with CURSOR_STORAGE_DIR env var.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir, platform } from "os";
import { Database } from "bun:sqlite";
import type { ParsedMessage, IngestResult, IngestOptions } from "./index";

// =============================================================================
// Legacy JSON types (kept for .cursor/**/*.json backward compat)
// =============================================================================

/** Shape of a Cursor conversation entry */
type CursorEntry = {
  role?: string;
  content?: string;
  type?: string;
  text?: string;
  timestamp?: string;
};

/** Shape of a Cursor conversation file (JSON array or object) */
type CursorConversation = {
  id?: string;
  title?: string;
  messages?: CursorEntry[];
  tabs?: Array<{
    id?: string;
    messages?: CursorEntry[];
  }>;
};

// =============================================================================
// SQLite / cursorDiskKV types
// =============================================================================

type ComposerData = {
  _v?: number;
  composerId: string;
  richText?: string;
  text?: string;
  name?: string;
  createdAt?: number;
  /** Newer format: array of header objects referencing bubble IDs */
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type: number }>;
  /** Older format: inline messages */
  conversation?: Array<{ bubbleId: string; type: number; text?: string }>;
};

type BubbleData = {
  type: number; // 1 = user, 2 = assistant
  text?: string;
  bubbleId?: string;
  createdAt?: string;
};

// =============================================================================
// Cursor user-dir root resolution
// =============================================================================

/**
 * Resolve Cursor's User directory roots across platforms.
 * Returns all existing paths (checks both stable and non-stable editions).
 */
export function resolveCursorUserRoots(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  switch (platform()) {
    case "darwin":
      candidates.push(
        join(home, "Library", "Application Support", "Cursor", "User"),
        join(home, "Library", "Application Support", "Cursor - Insiders", "User")
      );
      break;
    case "linux":
      candidates.push(
        join(home, ".config", "Cursor", "User"),
        join(home, ".config", "Cursor - Insiders", "User")
      );
      break;
    case "win32":
      candidates.push(
        join(
          process.env.APPDATA || join(home, "AppData", "Roaming"),
          "Cursor",
          "User"
        ),
        join(
          process.env.APPDATA || join(home, "AppData", "Roaming"),
          "Cursor - Insiders",
          "User"
        )
      );
      break;
  }

  // Allow override via env var
  const envPath = Bun.env.CURSOR_STORAGE_DIR;
  if (envPath) candidates.unshift(envPath);

  return candidates.filter(existsSync);
}

// =============================================================================
// Workspace mapping: composerId → project folder path
// =============================================================================

/**
 * Read workspace.json to get the folder path for a workspaceStorage hash dir.
 * Shape: { "folder": "file:///Users/..." }
 */
function readWorkspaceFolderPath(hashDir: string): string | null {
  const wsJsonPath = join(hashDir, "workspace.json");
  try {
    const parsed = JSON.parse(readFileSync(wsJsonPath, "utf8")) as {
      folder?: string;
      workspace?: string;
    };
    const raw = parsed.folder || parsed.workspace || null;
    if (!raw) return null;
    return decodeURIComponent(raw.replace(/^file:\/\//, ""));
  } catch {
    return null;
  }
}

/**
 * Build a map of composerId → workspace folder path by scanning all
 * workspaceStorage hash directories in the given Cursor User root.
 *
 * Each workspace state.vscdb has an ItemTable with key `composer.composerData`
 * that contains JSON: { allComposers: [{ composerId, ... }] }.
 */
export function buildComposerWorkspaceMap(cursorUserRoot: string): Map<string, string> {
  const result = new Map<string, string>();
  const wsStorageDir = join(cursorUserRoot, "workspaceStorage");
  if (!existsSync(wsStorageDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(wsStorageDir);
  } catch {
    return result;
  }

  for (const hash of entries) {
    const hashDir = join(wsStorageDir, hash);
    const dbPath = join(hashDir, "state.vscdb");
    if (!existsSync(dbPath)) continue;

    const folderPath = readWorkspaceFolderPath(hashDir);
    if (!folderPath) continue;

    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const row = db.prepare(
        `SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1`
      ).get() as { value: string } | null;

      if (!row?.value) continue;

      const parsed = JSON.parse(row.value) as {
        allComposers?: Array<{ composerId: string }>;
      };

      for (const c of parsed.allComposers ?? []) {
        if (c.composerId) {
          result.set(c.composerId, folderPath);
        }
      }
    } catch {
      // skip unreadable workspace DBs
    } finally {
      db?.close();
    }
  }

  return result;
}

// =============================================================================
// SQLite-based session discovery
// =============================================================================

export type CursorSessionMeta = {
  sessionId: string;
  /** null means not associated with a known workspace */
  projectPath: string | null;
  composerId: string;
  createdAt: string;
  title: string;
};

/**
 * Parse composer JSON value into messages by resolving bubbles.
 * Prefers inline `conversation` if non-empty, else falls back to
 * fullConversationHeadersOnly + bubble lookup map.
 */
export function resolveComposerMessages(
  composer: ComposerData,
  bubbleMap: Map<string, BubbleData>
): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  const roleFromType = (type: number): "user" | "assistant" | null =>
    type === 1 ? "user" : type === 2 ? "assistant" : null;

  // Fallback timestamp: composer creation time (bubbles often carry none)
  const composerTs = composer.createdAt
    ? new Date(composer.createdAt).toISOString()
    : undefined;

  // Prefer inline conversation array (older format)
  if (composer.conversation && composer.conversation.length > 0) {
    for (const entry of composer.conversation) {
      const role = roleFromType(entry.type);
      if (!role) continue;
      const text = entry.text?.trim();
      if (!text) continue;
      messages.push({ role, content: text, ...(composerTs ? { timestamp: composerTs } : {}) });
    }
    return messages;
  }

  // Newer format: headers-only + bubble lookup
  if (composer.fullConversationHeadersOnly) {
    for (const header of composer.fullConversationHeadersOnly) {
      const role = roleFromType(header.type);
      if (!role) continue;
      const bubble = bubbleMap.get(header.bubbleId);
      if (!bubble) continue;
      const text = bubble.text?.trim();
      if (!text) continue;
      const ts = bubble.createdAt || composerTs;
      messages.push({ role, content: text, ...(ts ? { timestamp: ts } : {}) });
    }
  }

  return messages;
}

/**
 * Discover Cursor sessions from a global storage SQLite database.
 *
 * @param globalDbPath  Path to state.vscdb (globalStorage)
 * @param composerWorkspaceMap  pre-built composerId → folder path map
 * @param projectPath  Optional filter: only return composers in this workspace
 */
export function discoverCursorSqliteSessions(
  globalDbPath: string,
  composerWorkspaceMap: Map<string, string>,
  options: { projectPath?: string } = {}
): Array<{ meta: CursorSessionMeta; messages: ParsedMessage[] }> {
  const results: Array<{ meta: CursorSessionMeta; messages: ParsedMessage[] }> = [];

  let db: Database | null = null;
  try {
    db = new Database(globalDbPath, { readonly: true });

    // Load all composer entries
    const composerRows = db
      .prepare(
        `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL AND value != ''`
      )
      .all() as { key: string; value: string }[];

    // Load all bubble entries into a flat map: bubbleId -> BubbleData
    // We batch-load only the bubbles we need after parsing composers
    // For efficiency, load all into a single Map
    const bubbleRows = db
      .prepare(
        `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value IS NOT NULL AND value != ''`
      )
      .all() as { key: string; value: string }[];

    // Map: composerId:bubbleId -> BubbleData
    const bubbleMap = new Map<string, BubbleData>();
    for (const row of bubbleRows) {
      // key format: bubbleId:<composerId>:<bubbleId>
      const parts = row.key.split(":");
      if (parts.length < 3) continue;
      const bubbleId = parts[parts.length - 1];
      if (!bubbleId) continue;
      try {
        const data = JSON.parse(row.value) as BubbleData;
        bubbleMap.set(bubbleId, data);
      } catch {
        // skip malformed bubble
      }
    }

    for (const row of composerRows) {
      let composer: ComposerData;
      try {
        composer = JSON.parse(row.value) as ComposerData;
      } catch {
        continue;
      }

      if (!composer.composerId) continue;

      const folderPath = composerWorkspaceMap.get(composer.composerId) ?? null;

      // Apply project filter if specified
      if (options.projectPath && folderPath !== options.projectPath) continue;

      const messages = resolveComposerMessages(composer, bubbleMap);
      if (messages.length === 0) continue;

      // Derive title from name, first user message, or richText
      const firstUser = messages.find((m) => m.role === "user");
      const title =
        composer.name?.trim() ||
        firstUser?.content.slice(0, 100).replace(/\n/g, " ") ||
        "Cursor Chat";

      const createdAt = composer.createdAt
        ? new Date(composer.createdAt).toISOString()
        : new Date().toISOString();

      results.push({
        meta: {
          sessionId: `cursor-${composer.composerId}`,
          projectPath: folderPath,
          composerId: composer.composerId,
          createdAt,
          title,
        },
        messages,
      });
    }
  } catch {
    // unreadable DB — skip
  } finally {
    db?.close();
  }

  return results;
}

// =============================================================================
// Legacy: JSON file discovery
// =============================================================================

/**
 * Discover Cursor conversation files in a project's .cursor/ directory.
 * Kept for backward compatibility with projects that have local JSON exports.
 */
export async function discoverCursorSessions(
  projectPath: string
): Promise<Array<{ sessionId: string; filePath: string; projectPath: string }>> {
  const sessions: Array<{
    sessionId: string;
    filePath: string;
    projectPath: string;
  }> = [];

  const cursorDir = `${projectPath}/.cursor`;
  try {
    const glob = new Bun.Glob("**/*.json");
    for await (const match of glob.scan({ cwd: cursorDir, absolute: false })) {
      const normalizedMatch = match.replaceAll("\\", "/");
      const sessionId = `cursor-${normalizedMatch
        .replace(/\.json$/, "")
        .replaceAll("/", "-")}`;
      sessions.push({
        sessionId,
        filePath: join(cursorDir, normalizedMatch),
        projectPath,
      });
    }
  } catch {
    // .cursor directory may not exist
  }

  return sessions;
}

/**
 * Parse a Cursor conversation JSON file into normalized messages.
 * Used only for the legacy .cursor/**\/*.json path.
 */
export function parseCursorJson(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  let data: CursorConversation | CursorConversation[];
  try {
    data = JSON.parse(content);
  } catch {
    return messages;
  }

  const conversations = Array.isArray(data) ? data : [data];

  for (const conv of conversations) {
    const allMessages = [
      ...(conv.messages || []),
      ...(conv.tabs?.flatMap((t) => t.messages || []) || []),
    ];

    for (const entry of allMessages) {
      const role = entry.role || entry.type;
      if (!role || (role !== "user" && role !== "assistant")) continue;

      const text = entry.content || entry.text;
      if (!text?.trim()) continue;

      messages.push({
        role,
        content: text,
        timestamp: entry.timestamp,
      });
    }
  }

  return messages;
}

// =============================================================================
// Ingestion entry point
// =============================================================================

/**
 * Ingest Cursor sessions.
 *
 * Without projectPath: scans Cursor app's SQLite globalStorage for all composers.
 * With projectPath: scans SQLite and also falls back to .cursor/*.json files.
 */
export async function ingestCursor(
  options: IngestOptions & { projectPath?: string } = {}
): Promise<IngestResult> {
  const { db, onProgress, projectPath } = options;
  if (!db) throw new Error("Database required for ingestion");
  const { ingest } = await import("./index");
  return ingest(db, "cursor", {
    projectPath,
    onProgress,
  });
}
