/**
 * team/share.ts - Export knowledge to .smriti/ for git-based sharing
 *
 * Creates markdown files with YAML frontmatter in the project's .smriti/
 * directory. Users commit these files to git for team knowledge sharing.
 */

import type { Database } from "bun:sqlite";
import { SMRITI_DIR, AUTHOR } from "../config";
import { hashContent } from "../qmd";
import { existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import {
  formatSessionAsFallback,
  isSessionWorthSharing,
  deriveTitle,
  filterMessages,
  mergeConsecutive,
} from "./formatter";
import {
  synthesizeSession,
  hasSubstantiveSynthesis,
  deriveTitleFromSynthesis,
  formatSynthesisAsDocument,
} from "./reflect";
import { segmentSession } from "./segment";
import { generateDocumentsSequential, generateFrontmatter } from "./document";
import type { RawMessage } from "./formatter";

// =============================================================================
// Types
// =============================================================================

export type ShareOptions = {
  category?: string;
  project?: string;
  sessionId?: string;
  outputDir?: string;
  author?: string;
  reflect?: boolean;
  reflectModel?: string;
  segmented?: boolean;
  minRelevance?: number;
};

export type ShareResult = {
  filesCreated: number;
  filesSkipped: number;
  outputDir: string;
  errors: string[];
};

// =============================================================================
// Helpers
// =============================================================================

/** Generate a slug from text */
function slugify(text: string, maxLen: number = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

/** Format a date as YYYY-MM-DD */
function datePrefix(isoDate: string): string {
  return isoDate.slice(0, 10);
}

/** Generate YAML frontmatter */
function frontmatter(meta: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// =============================================================================
// Segmented Sharing (3-Stage Pipeline)
// =============================================================================

/**
 * Share knowledge using 3-stage segmentation pipeline
 * Stage 1: Segment session into knowledge units
 * Stage 2: Generate documentation per unit
 * Stage 3: Save and deduplicate (deferred)
 */
async function shareSegmentedKnowledge(
  db: Database,
  options: ShareOptions = {}
): Promise<ShareResult> {
  const author = options.author || AUTHOR;
  const minRelevance = options.minRelevance ?? 6;

  const result: ShareResult = {
    filesCreated: 0,
    filesSkipped: 0,
    outputDir: "",
    errors: [],
  };

  // Determine output directory
  let outputDir: string;
  if (options.outputDir) {
    outputDir = options.outputDir;
  } else if (options.project) {
    const project = db
      .prepare(`SELECT path FROM smriti_projects WHERE id = ?`)
      .get(options.project) as { path: string } | null;
    if (project?.path) {
      outputDir = join(project.path, SMRITI_DIR);
    } else {
      outputDir = join(process.cwd(), SMRITI_DIR);
    }
  } else {
    outputDir = join(process.cwd(), SMRITI_DIR);
  }

  result.outputDir = outputDir;

  // Ensure directory structure
  const knowledgeDir = join(outputDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  // Build query for sessions to share
  const conditions: string[] = ["ms.active = 1"];
  const params: any[] = [];

  if (options.category) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_session_tags st
        WHERE st.session_id = ms.id
          AND (st.category_id = ? OR st.category_id LIKE ? || '/%')
      )`
    );
    params.push(options.category, options.category);
  }

  if (options.project) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_session_meta sm
        WHERE sm.session_id = ms.id AND sm.project_id = ?
      )`
    );
    params.push(options.project);
  }

  if (options.sessionId) {
    conditions.push(`ms.id = ?`);
    params.push(options.sessionId);
  }

  const sessions = db
    .prepare(
      `SELECT ms.id, ms.title, ms.created_at, ms.summary,
              sm.agent_id, sm.project_id
       FROM memory_sessions ms
       LEFT JOIN smriti_session_meta sm ON sm.session_id = ms.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ms.updated_at DESC`
    )
    .all(...params) as Array<{
      id: string;
      title: string;
      created_at: string;
      summary: string | null;
      agent_id: string | null;
      project_id: string | null;
    }>;

  const manifest: Array<{
    id: string;
    category: string;
    file: string;
    shared_at: string;
  }> = [];

  for (const session of sessions) {
    try {
      // Get messages for this session
      const messages = db
        .prepare(
          `SELECT mm.id, mm.role, mm.content, mm.hash, mm.created_at
           FROM memory_messages mm
           WHERE mm.session_id = ?
           ORDER BY mm.id`
        )
        .all(session.id) as Array<{
          id: number;
          role: string;
          content: string;
          hash: string;
          created_at: string;
        }>;

      if (messages.length === 0) continue;

      // Skip noise-only sessions
      const rawMessages: RawMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      if (!isSessionWorthSharing(rawMessages)) {
        result.filesSkipped++;
        continue;
      }

      // Stage 1: Segment the session
      const segmentationResult = await segmentSession(
        db,
        session.id,
        rawMessages,
        { model: options.reflectModel }
      );

      // Filter by relevance
      const worthSharing = segmentationResult.units.filter(
        (u) => u.relevance >= minRelevance
      );

      if (worthSharing.length === 0) {
        result.filesSkipped++;
        continue;
      }

      // Stage 2: Generate documents (sequentially per plan)
      const docs = await generateDocumentsSequential(worthSharing, {
        model: options.reflectModel,
        projectSmritiDir: outputDir,
        author,
      });

      // Write documents and track dedup
      for (const doc of docs) {
        try {
          const categoryDir = join(knowledgeDir, doc.category.replace("/", "-"));
          mkdirSync(categoryDir, { recursive: true });

          const filePath = join(categoryDir, doc.filename);

          // Build frontmatter
          const frontmatter = generateFrontmatter(
            session.id,
            doc.unitId,
            doc.frontmatter,
            author,
            session.project_id || undefined
          );

          const content = frontmatter + "\n\n" + doc.markdown;

          // Check unit-level dedup
          const unitHash = await hashContent(
            JSON.stringify({
              content: doc.markdown,
              category: doc.category,
              entities: doc.frontmatter.entities,
            })
          );

          const exists = db
            .prepare(
              `SELECT 1 FROM smriti_shares
               WHERE content_hash = ? AND unit_id = ?`
            )
            .get(unitHash, doc.unitId);

          if (exists) {
            result.filesSkipped++;
            continue;
          }

          // Write file
          await Bun.write(filePath, content);

          // Record share
          db.prepare(
            `INSERT INTO smriti_shares (id, session_id, category_id, project_id, author, content_hash, unit_id, relevance_score, entities)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            crypto.randomUUID().slice(0, 8),
            session.id,
            doc.category,
            session.project_id,
            author,
            unitHash,
            doc.unitId,
            worthSharing.find((u) => u.id === doc.unitId)?.relevance || 0,
            JSON.stringify(doc.frontmatter.entities)
          );

          manifest.push({
            id: session.id,
            category: doc.category,
            file: `knowledge/${doc.category.replace("/", "-")}/${doc.filename}`,
            shared_at: new Date().toISOString(),
          });

          result.filesCreated++;
        } catch (err: any) {
          result.errors.push(`${doc.unitId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      result.errors.push(`${session.id}: ${err.message}`);
    }
  }

  // Write manifest and CLAUDE.md
  const indexPath = join(outputDir, "index.json");
  let existingManifest: any[] = [];
  try {
    const existing = await Bun.file(indexPath).text();
    existingManifest = JSON.parse(existing);
  } catch {
    // No existing manifest
  }

  const fullManifest = [...existingManifest, ...manifest];
  await Bun.write(indexPath, JSON.stringify(fullManifest, null, 2));

  // Write config if it doesn't exist
  const configPath = join(outputDir, "config.json");
  if (!existsSync(configPath)) {
    await Bun.write(
      configPath,
      JSON.stringify(
        {
          version: 1,
          allowedCategories: ["*"],
          autoSync: false,
        },
        null,
        2
      )
    );
  }

  // Generate CLAUDE.md
  await generateClaudeMd(outputDir, fullManifest);

  return result;
}

// =============================================================================
// Export
// =============================================================================

/**
 * Export knowledge to the .smriti/ directory.
 * Routes to segmented pipeline if --segmented flag is set, otherwise uses legacy single-stage.
 */
export async function shareKnowledge(
  db: Database,
  options: ShareOptions = {}
): Promise<ShareResult> {
  // Route to segmented pipeline if requested
  if (options.segmented) {
    return shareSegmentedKnowledge(db, options);
  }

  // Otherwise use legacy single-stage pipeline
  const author = options.author || AUTHOR;
  const result: ShareResult = {
    filesCreated: 0,
    filesSkipped: 0,
    outputDir: "",
    errors: [],
  };

  // Determine output directory
  let outputDir: string;
  if (options.outputDir) {
    outputDir = options.outputDir;
  } else if (options.project) {
    // Look up project path
    const project = db
      .prepare(`SELECT path FROM smriti_projects WHERE id = ?`)
      .get(options.project) as { path: string } | null;
    if (project?.path) {
      outputDir = join(project.path, SMRITI_DIR);
    } else {
      outputDir = join(process.cwd(), SMRITI_DIR);
    }
  } else {
    outputDir = join(process.cwd(), SMRITI_DIR);
  }

  result.outputDir = outputDir;

  // Ensure directory structure
  const knowledgeDir = join(outputDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  // Build query for sessions to share
  const conditions: string[] = ["ms.active = 1"];
  const params: any[] = [];

  if (options.category) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_session_tags st
        WHERE st.session_id = ms.id
          AND (st.category_id = ? OR st.category_id LIKE ? || '/%')
      )`
    );
    params.push(options.category, options.category);
  }

  if (options.project) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_session_meta sm
        WHERE sm.session_id = ms.id AND sm.project_id = ?
      )`
    );
    params.push(options.project);
  }

  if (options.sessionId) {
    conditions.push(`ms.id = ?`);
    params.push(options.sessionId);
  }

  const sessions = db
    .prepare(
      `SELECT ms.id, ms.title, ms.created_at, ms.summary,
              sm.agent_id, sm.project_id
       FROM memory_sessions ms
       LEFT JOIN smriti_session_meta sm ON sm.session_id = ms.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ms.updated_at DESC`
    )
    .all(...params) as Array<{
      id: string;
      title: string;
      created_at: string;
      summary: string | null;
      agent_id: string | null;
      project_id: string | null;
    }>;

  // Get existing share hashes for dedup
  const existingHashes = new Set(
    (
      db.prepare(`SELECT content_hash FROM smriti_shares`).all() as {
        content_hash: string;
      }[]
    ).map((r) => r.content_hash)
  );

  const manifest: Array<{
    id: string;
    category: string;
    file: string;
    shared_at: string;
  }> = [];

  for (const session of sessions) {
    try {
      // Get messages for this session
      const messages = db
        .prepare(
          `SELECT mm.id, mm.role, mm.content, mm.hash, mm.created_at
           FROM memory_messages mm
           WHERE mm.session_id = ?
           ORDER BY mm.id`
        )
        .all(session.id) as Array<{
          id: number;
          role: string;
          content: string;
          hash: string;
          created_at: string;
        }>;

      if (messages.length === 0) continue;

      // Check dedup via content hash
      const contentHash = messages.map((m) => m.hash).join(":");
      const sessionHash = await hashContent(contentHash);

      if (existingHashes.has(sessionHash)) {
        result.filesSkipped++;
        continue;
      }

      // Get categories for this session
      const categories = db
        .prepare(
          `SELECT category_id FROM smriti_session_tags WHERE session_id = ?`
        )
        .all(session.id) as { category_id: string }[];
      const primaryCategory =
        categories[0]?.category_id || "uncategorized";

      // Create category subdirectory
      const categoryDir = join(knowledgeDir, primaryCategory.replace("/", "-"));
      mkdirSync(categoryDir, { recursive: true });

      // Skip noise-only sessions
      const rawMessages = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      if (!isSessionWorthSharing(rawMessages)) {
        result.filesSkipped++;
        continue;
      }

      // Synthesize via LLM (primary) or fall back to cleaned conversation
      let cleanTitle: string;
      let body: string;

      if (options.reflect) {
        const synthesis = await synthesizeSession(rawMessages, {
          model: options.reflectModel,
          projectSmritiDir: outputDir,
        });

        if (synthesis && hasSubstantiveSynthesis(synthesis)) {
          // Use LLM-synthesized knowledge article
          cleanTitle = deriveTitleFromSynthesis(synthesis) ||
            deriveTitle(session.title, mergeConsecutive(filterMessages(rawMessages)));
          body = formatSynthesisAsDocument(cleanTitle, synthesis);
        } else {
          // LLM unavailable or insufficient — fall back to cleaned conversation
          const fallback = formatSessionAsFallback(session.title, session.summary, rawMessages);
          cleanTitle = fallback.title;
          body = fallback.body;
        }
      } else {
        const fallback = formatSessionAsFallback(session.title, session.summary, rawMessages);
        cleanTitle = fallback.title;
        body = fallback.body;
      }

      // Generate filename using clean title
      const date = datePrefix(session.created_at);
      const slug = slugify(cleanTitle || session.id);
      const filename = `${date}_${slug}.md`;
      const filePath = join(categoryDir, filename);

      // Build final content with frontmatter
      const meta = frontmatter({
        id: session.id,
        category: primaryCategory,
        project: session.project_id || "",
        agent: session.agent_id || "",
        author,
        shared_at: new Date().toISOString(),
        tags: categories.map((c) => c.category_id),
      });

      const content = meta + "\n\n" + body;

      await Bun.write(filePath, content);

      // Record the share
      db.prepare(
        `INSERT INTO smriti_shares (id, session_id, category_id, project_id, author, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID().slice(0, 8),
        session.id,
        primaryCategory,
        session.project_id,
        author,
        sessionHash
      );

      manifest.push({
        id: session.id,
        category: primaryCategory,
        file: `knowledge/${primaryCategory.replace("/", "-")}/${filename}`,
        shared_at: new Date().toISOString(),
      });

      result.filesCreated++;
    } catch (err: any) {
      result.errors.push(`${session.id}: ${err.message}`);
    }
  }

  // Write manifest
  const indexPath = join(outputDir, "index.json");
  let existingManifest: any[] = [];
  try {
    const existing = await Bun.file(indexPath).text();
    existingManifest = JSON.parse(existing);
  } catch {
    // No existing manifest
  }

  const fullManifest = [...existingManifest, ...manifest];
  await Bun.write(indexPath, JSON.stringify(fullManifest, null, 2));

  // Write config if it doesn't exist
  const configPath = join(outputDir, "config.json");
  if (!existsSync(configPath)) {
    await Bun.write(
      configPath,
      JSON.stringify(
        {
          version: 1,
          allowedCategories: ["*"],
          autoSync: false,
        },
        null,
        2
      )
    );
  }

  // Generate CLAUDE.md so Claude Code discovers shared knowledge
  await generateClaudeMd(outputDir, fullManifest);

  return result;
}

/**
 * Generate a .smriti/CLAUDE.md that indexes all shared knowledge files.
 * Claude Code auto-discovers CLAUDE.md files in subdirectories.
 */
async function generateClaudeMd(
  outputDir: string,
  manifest: Array<{ id: string; category: string; file: string; shared_at: string }>
) {
  // Group by category
  const byCategory = new Map<string, string[]>();
  for (const entry of manifest) {
    const files = byCategory.get(entry.category) || [];
    files.push(entry.file);
    byCategory.set(entry.category, files);
  }

  const lines: string[] = [
    "# Team Knowledge",
    "",
    "This directory contains shared knowledge from development sessions.",
    "Generated by `smriti share`. Do not edit manually.",
    "",
  ];

  for (const [category, files] of [...byCategory.entries()].sort()) {
    lines.push(`## ${category}`);
    lines.push("");
    for (const file of files) {
      const name = file.split("/").pop()?.replace(/\.md$/, "").replace(/_/g, " ") || file;
      lines.push(`- [${name}](${file})`);
    }
    lines.push("");
  }

  await Bun.write(join(outputDir, "CLAUDE.md"), lines.join("\n"));
}
