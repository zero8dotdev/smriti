/**
 * session-resolver.ts - Resolve session state before persistence
 *
 * Handles:
 * - Project ID/path derivation
 * - Incremental ingest (count existing messages)
 * - Session deduplication checks
 *
 * NO PARSING, NO PERSISTENCE — only state resolution.
 */

import type { Database } from "bun:sqlite";
import { PROJECTS_ROOT } from "../config";
import { basename } from "path";
import { existsSync } from "fs";

// =============================================================================
// Types
// =============================================================================

export type ResolvedSession = {
  sessionId: string;
  projectId: string;
  projectPath: string;
  isNew: boolean;
  existingMessageCount: number;
};

// =============================================================================
// Project Path Resolution (agent-agnostic)
// =============================================================================

/**
 * Reconstruct a real filesystem path from a Claude projects directory name.
 * Greedy matching: try longest matching path that exists on filesystem.
 *
 * Example: "-Users-zero8-zero8-dev-smriti" → "/Users/zero8/zero8.dev/smriti"
 */
export function deriveProjectPath(dirName: string): string {
  if (!dirName) return PROJECTS_ROOT;

  // For non-Claude agents (Cline, etc.), dirName might be a real path already
  if (dirName.startsWith("/")) {
    return dirName;
  }

  // Claude-style encoding: "-" separates path segments
  const raw = dirName.replace(/^-/, "");
  const parts = raw.split("-");

  const segments: string[] = [];
  let i = 0;
  while (i < parts.length) {
    let best = parts[i];
    let bestLen = 1;
    for (let j = i + 1; j < parts.length; j++) {
      const candidate = parts.slice(i, j + 1).join("-");
      const candidatePath = "/" + [...segments, candidate].join("/");
      if (existsSync(candidatePath)) {
        best = candidate;
        bestLen = j - i + 1;
      }
    }
    segments.push(best);
    i += bestLen;
  }

  return "/" + segments.join("/");
}

/**
 * Derive a clean project ID from a directory name or path.
 * Strips PROJECTS_ROOT to get relative path.
 *
 * Example: "/Users/zero8/zero8.dev/smriti" → "smriti"
 *          "/Users/zero8/zero8.dev/project/subdir" → "project/subdir"
 */
export function deriveProjectId(dirName: string): string {
  const realPath = deriveProjectPath(dirName);
  const root = PROJECTS_ROOT.replace(/\/+$/, "");

  // Exact match with root
  if (realPath === root) {
    return basename(root);
  }

  // Strip root prefix
  if (realPath.startsWith(root + "/")) {
    return realPath.slice(root.length + 1);
  }

  // Fallback: use basename
  return basename(realPath) || "home";
}

// =============================================================================
// Session Resolution
// =============================================================================

/**
 * Resolve session state: project info, deduplication, incremental counts.
 *
 * Input: sessionId, projectDir, agent name
 * Output: { sessionId, projectId, projectPath, isNew, existingMessageCount }
 *
 * Example usage:
 *   const resolved = await resolveSession(db, "session-123", "-Users-...", "claude");
 *   // → { sessionId: "session-123", projectId: "smriti", projectPath: "...", isNew: false, existingMessageCount: 5 }
 */
export async function resolveSession(
  db: Database,
  sessionId: string,
  projectDir: string,
  agent: string
): Promise<ResolvedSession> {
  // Derive project info
  const projectPath = deriveProjectPath(projectDir);
  const projectId = deriveProjectId(projectDir);

  // Check if session already exists (for deduplication)
  const existing = db
    .prepare(`SELECT 1 FROM smriti_session_meta WHERE session_id = ?`)
    .get(sessionId) as { 1: number } | null;

  const isNew = !existing;

  // Count existing messages for incremental ingest
  // (Claude JSONL files are append-only, so we can just count and skip processed ones)
  const existingMessageCount: number =
    (db
      .prepare(`SELECT COUNT(*) as count FROM memory_messages WHERE session_id = ?`)
      .get(sessionId) as { count: number } | null)?.count ?? 0;

  return {
    sessionId,
    projectId,
    projectPath,
    isNew,
    existingMessageCount,
  };
}

/**
 * Batch resolve multiple sessions (for agents that ingest many at once).
 */
export async function resolveSessions(
  db: Database,
  sessions: Array<{ sessionId: string; projectDir: string; agent: string }>
): Promise<ResolvedSession[]> {
  return Promise.all(
    sessions.map((s) => resolveSession(db, s.sessionId, s.projectDir, s.agent))
  );
}
