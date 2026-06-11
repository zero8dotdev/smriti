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
import { readConfig, mergeCategories } from "./config";

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
  categoriesImported: number;
};

// =============================================================================
// Parsing
// =============================================================================

/** Parse YAML frontmatter from a markdown file */
export function parseFrontmatter(content: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const raw = line.slice(colonIdx + 1).trim();
      if (raw.startsWith("[") && raw.endsWith("]")) {
        meta[key] = raw
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        meta[key] = raw.replace(/^["']|["']$/g, "");
      }
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
    categoriesImported: 0,
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

  // Import custom categories from config.json (v2+) before scanning files
  const config = readConfig(inputDir);
  if (config.categories && config.categories.length > 0) {
    result.categoriesImported = mergeCategories(db, config.categories);
  }

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

        // Segmented pipeline docs don't have **user**/**assistant** patterns;
        // treat the whole body as a single assistant message.
        const isSegmented = meta.pipeline === "segmented";
        const messages = isSegmented
          ? [{ role: "assistant", content: body.trim() }]
          : extractMessages(body);

        if (messages.length === 0) {
          result.skipped++;
          continue;
        }

        // Helper: coerce meta field to plain string
        const metaStr = (v: string | string[] | undefined): string =>
          Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

        // Create session from the imported file
        const sessionId =
          metaStr(meta.id) || `team-${crypto.randomUUID().slice(0, 8)}`;

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
          metaStr(meta.agent) || "team",
          metaStr(meta.project) || options.project
        );

        // Restore all tags from the tags array; fall back to scalar category
        const { isValidCategory } = await import("../categorize/schema");
        if (Array.isArray(meta.tags) && meta.tags.length > 0) {
          for (const tag of meta.tags) {
            if (isValidCategory(db, tag)) {
              tagSession(db, sessionId, tag, 1.0, "team");
            }
          }
        } else if (meta.category) {
          const cat = metaStr(meta.category);
          if (isValidCategory(db, cat)) {
            tagSession(db, sessionId, cat, 1.0, "team");
          }
        }

        // Record the share for dedup
        const primaryCategory = Array.isArray(meta.tags)
          ? (meta.tags[0] ?? metaStr(meta.category) ?? null)
          : metaStr(meta.category) || null;
        db.prepare(
          `INSERT OR IGNORE INTO smriti_shares (id, session_id, category_id, project_id, author, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID().slice(0, 8),
          sessionId,
          primaryCategory,
          metaStr(meta.project) || null,
          metaStr(meta.author) || "team",
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
