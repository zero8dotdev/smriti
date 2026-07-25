/**
 * learn/consolidate.ts - Continuous knowledge consolidation
 *
 * Progressive Summarization: cheap Stage-1 extraction runs broadly over dense
 * sessions; expensive Stage-2 polish only runs once a unit proves it's reused
 * (recalled repeatedly) or scored high relevance at extraction time.
 *
 * Two independent phases, run sequentially:
 *  - Segment: dense, not-yet-segmented sessions -> segmentSession() -> smriti_knowledge_units
 *  - Promote: knowledge units that cleared the reuse/relevance bar -> generateDocument()
 *             -> written to .smriti/knowledge/ + recorded in smriti_shares
 *
 * CLI-only, like `categorize`/`share` — never wired into the daemon (see
 * src/daemon/index.ts's enrichOnIngest comment for why LLM work per-flush is unsafe).
 */

import type { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { SMRITI_DIR, AUTHOR } from "../config";
import { hashContent } from "../qmd";
import {
  findUnsegmentedDenseSessions,
  insertKnowledgeUnit,
  findPromotableUnits,
  promoteKnowledgeUnit,
} from "../db";
import { getSessionMessages } from "../team/share";
import { segmentSession } from "../team/segment";
import { generateDocument, generateFrontmatter } from "../team/document";
import { isSessionWorthSharing } from "../team/formatter";
import type { RawMessage } from "../team/formatter";
import type { KnowledgeUnit } from "../team/types";

// =============================================================================
// Types
// =============================================================================

export type ConsolidateOptions = {
  minDensity?: number;
  minRetrievals?: number;
  minRelevance?: number;
  model?: string;
  outputDir?: string;
  author?: string;
  sessionLimit?: number;
  onProgress?: (msg: string) => void;
};

export type ConsolidateResult = {
  sessionsSegmented: number;
  unitsStored: number;
  unitsSkipped: number;
  unitsPromoted: number;
  errors: string[];
};

// =============================================================================
// Consolidation
// =============================================================================

export async function consolidateKnowledge(
  db: Database,
  options: ConsolidateOptions = {}
): Promise<ConsolidateResult> {
  const author = options.author || AUTHOR;
  const outputDir = options.outputDir || join(process.cwd(), SMRITI_DIR);

  const result: ConsolidateResult = {
    sessionsSegmented: 0,
    unitsStored: 0,
    unitsSkipped: 0,
    unitsPromoted: 0,
    errors: [],
  };

  // ===========================================================================
  // Segment phase: cheap Stage-1 extraction over dense, unsegmented sessions
  // ===========================================================================

  const sessions = findUnsegmentedDenseSessions(
    db,
    options.minDensity ?? 0.5,
    options.sessionLimit ?? 20
  );

  for (const s of sessions) {
    try {
      const messages = getSessionMessages(db, s.session_id);
      if (messages.length === 0) continue;

      const rawMessages: RawMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      if (!isSessionWorthSharing(rawMessages)) continue;

      const segmentationResult = await segmentSession(db, s.session_id, rawMessages, {
        model: options.model,
      });
      result.sessionsSegmented++;

      for (const unit of segmentationResult.units) {
        const contentHash = await hashContent(
          JSON.stringify({ topic: unit.topic, category: unit.category, plainText: unit.plainText })
        );
        const inserted = insertKnowledgeUnit(db, unit, s.session_id, s.project_id, contentHash);
        inserted ? result.unitsStored++ : result.unitsSkipped++;
      }
    } catch (err: any) {
      result.errors.push(`segment ${s.session_id}: ${err.message}`);
    }
  }

  options.onProgress?.(
    `segment phase: ${result.sessionsSegmented} sessions, ${result.unitsStored} units stored, ${result.unitsSkipped} skipped`
  );

  // ===========================================================================
  // Promote phase: expensive Stage-2 polish for units that proved reuse
  // ===========================================================================

  const knowledgeDir = join(outputDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  const promotable = findPromotableUnits(
    db,
    options.minRetrievals ?? 3,
    options.minRelevance ?? 8
  );

  for (const stored of promotable) {
    try {
      const unit: KnowledgeUnit = {
        id: stored.id,
        topic: stored.topic,
        category: stored.category,
        relevance: stored.relevance,
        entities: stored.entities,
        files: stored.files,
        plainText: stored.plain_text,
        lineRanges: stored.line_ranges,
      };

      const doc = await generateDocument(unit, stored.topic, {
        model: options.model,
        projectSmritiDir: outputDir,
        author,
      });

      const categoryDir = join(knowledgeDir, doc.category.replaceAll("/", "-"));
      mkdirSync(categoryDir, { recursive: true });
      const filePath = join(categoryDir, doc.filename);

      const fm = generateFrontmatter(
        stored.session_id,
        doc.unitId,
        { ...doc.frontmatter, pipeline: "consolidated" },
        author,
        stored.project_id || undefined
      );
      await Bun.write(filePath, fm + "\n\n" + doc.markdown);

      const shareId = crypto.randomUUID().slice(0, 8);
      const shareHash = await hashContent(
        JSON.stringify({ content: doc.markdown, category: doc.category, entities: doc.frontmatter.entities })
      );

      db.prepare(
        `INSERT INTO smriti_shares (id, session_id, category_id, project_id, author, content_hash, unit_id, relevance_score, entities)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        shareId,
        stored.session_id,
        doc.category,
        stored.project_id,
        author,
        shareHash,
        doc.unitId,
        stored.relevance,
        JSON.stringify(stored.entities)
      );

      const relPath = `knowledge/${doc.category.replaceAll("/", "-")}/${doc.filename}`;
      promoteKnowledgeUnit(db, stored.id, relPath, shareId);
      result.unitsPromoted++;
    } catch (err: any) {
      result.errors.push(`promote ${stored.id}: ${err.message}`);
    }
  }

  options.onProgress?.(`promote phase: ${result.unitsPromoted} units promoted`);

  return result;
}
