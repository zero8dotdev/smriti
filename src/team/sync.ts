/**
 * team/sync.ts - Import team knowledge from .smriti/ directory
 *
 * Reads markdown files from a project's .smriti/ directory and imports
 * them into the local database with team attribution.
 */

import type { Database } from "bun:sqlite";
import { SMRITI_DIR } from "../config";
import { addMessage, hashContent } from "../qmd";
import { join } from "path";

// =============================================================================
// Types
// =============================================================================

export type SyncOptions = {
  inputDir?: string;
  project?: string;
};

export type SyncResult = {
  filesProcessed: number;
  imported: number;
  skipped: number;
  errors: string[];
};

// =============================================================================
// Parsing
// =============================================================================

/** Parse YAML frontmatter from a markdown file */
export function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line
        .slice(colonIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      meta[key] = value;
    }
  }

  return { meta, body: match[2] };
}

/** Extract conversation messages from markdown body */
function extractMessages(
  body: string
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const lines = body.split("\n");

  let currentRole = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const roleMatch = line.match(/^\*\*(user|assistant)\*\*:\s*(.*)/i);
    if (roleMatch) {
      // Save previous message
      if (currentRole && currentContent.length > 0) {
        messages.push({
          role: currentRole,
          content: currentContent.join("\n").trim(),
        });
      }
      currentRole = roleMatch[1].toLowerCase();
      currentContent = roleMatch[2] ? [roleMatch[2]] : [];
    } else if (currentRole) {
      currentContent.push(line);
    }
  }

  // Don't forget the last message
  if (currentRole && currentContent.length > 0) {
    messages.push({
      role: currentRole,
      content: currentContent.join("\n").trim(),
    });
  }

  return messages;
}

// =============================================================================
// Sync
// =============================================================================

/**
 * Import team knowledge from a .smriti/ directory.
 */
export async function syncTeamKnowledge(
  db: Database,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const result: SyncResult = {
    filesProcessed: 0,
    imported: 0,
    skipped: 0,
    errors: [],
  };

  // Determine input directory
  let inputDir: string;
  if (options.inputDir) {
    inputDir = options.inputDir;
  } else if (options.project) {
    const project = db
      .prepare(`SELECT path FROM smriti_projects WHERE id = ?`)
      .get(options.project) as { path: string } | null;
    if (project?.path) {
      inputDir = join(project.path, SMRITI_DIR);
    } else {
      inputDir = join(process.cwd(), SMRITI_DIR);
    }
  } else {
    inputDir = join(process.cwd(), SMRITI_DIR);
  }

  // Get existing share hashes for dedup
  const existingHashes = new Set(
    (
      db.prepare(`SELECT content_hash FROM smriti_shares`).all() as {
        content_hash: string;
      }[]
    ).map((r) => r.content_hash)
  );

  // Scan for markdown files
  const knowledgeDir = join(inputDir, "knowledge");
  const glob = new Bun.Glob("**/*.md");

  const { upsertSessionMeta, tagSession } = await import("../db");

  try {
    for await (const match of glob.scan({
      cwd: knowledgeDir,
      absolute: false,
    })) {
      result.filesProcessed++;
      const filePath = join(knowledgeDir, match);

      try {
        const content = await Bun.file(filePath).text();
        const { meta, body } = parseFrontmatter(content);

        // Compute content hash for dedup
        const contentHash = await hashContent(body);
        if (existingHashes.has(contentHash)) {
          result.skipped++;
          continue;
        }

        const messages = extractMessages(body);
        if (messages.length === 0) {
          result.skipped++;
          continue;
        }

        // Create session from the imported file
        const sessionId =
          meta.id || `team-${crypto.randomUUID().slice(0, 8)}`;

        // Extract title from heading
        const titleMatch = body.match(/^#\s+(.+)/m);
        const title = titleMatch?.[1] || match.replace(/\.md$/, "");

        for (const msg of messages) {
          await addMessage(db, sessionId, msg.role, msg.content, { title });
        }

        // Attach metadata
        upsertSessionMeta(
          db,
          sessionId,
          meta.agent || "team",
          meta.project || options.project
        );

        // Apply category tags
        if (meta.category) {
          tagSession(db, sessionId, meta.category, 1.0, "team");
        }

        // Record the share for dedup
        db.prepare(
          `INSERT OR IGNORE INTO smriti_shares (id, session_id, category_id, project_id, author, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID().slice(0, 8),
          sessionId,
          meta.category || null,
          meta.project || null,
          meta.author || "team",
          contentHash
        );

        result.imported++;
      } catch (err: any) {
        result.errors.push(`${match}: ${err.message}`);
      }
    }
  } catch {
    // knowledge directory may not exist
    result.errors.push(`Knowledge directory not found: ${knowledgeDir}`);
  }

  return result;
}

/**
 * List team contributions (shared sessions grouped by author).
 */
export function listTeamContributions(db: Database): Array<{
  author: string;
  count: number;
  categories: string;
  latest: string;
}> {
  return db
    .prepare(
      `SELECT
        author,
        COUNT(*) as count,
        GROUP_CONCAT(DISTINCT category_id) as categories,
        MAX(shared_at) as latest
      FROM smriti_shares
      GROUP BY author
      ORDER BY latest DESC`
    )
    .all() as any;
}
