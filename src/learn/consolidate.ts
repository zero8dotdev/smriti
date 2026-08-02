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
import { callOllama } from "../team/ollama";
import { ollamaChat, type OllamaTool } from "../ollama";
import type { RawMessage } from "../team/formatter";
import type { KnowledgeUnit } from "../team/types";
import {
  resolveEntity,
  insertRelationship,
  getRelationships,
  findRelatedCandidates,
  type RelationshipPredicate,
} from "./entities";

// =============================================================================
// Types
// =============================================================================

export type ConsolidateOptions = {
  minDensity?: number;
  minRetrievals?: number;
  minRelevance?: number;
  minEntityReach?: number;
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

        // Turn Stage 1's free-text entities into canonical "mentions" edges —
        // pure post-processing of data already extracted, no extra LLM calls.
        if (inserted) {
          for (const rawEntity of unit.entities) {
            const entityId = resolveEntity(db, rawEntity);
            if (entityId) {
              insertRelationship(db, "knowledge_unit", unit.id, "mentions", "entity", entityId, {
                source: "extraction",
              });
            }
          }
        }
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
    options.minRelevance ?? 8,
    options.minEntityReach
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

      // Bounded relationship inference: only runs if this unit shares a
      // canonical entity with at least one other unit, and costs exactly one
      // extra LLM call (same cost discipline as Stage 2) — persists what
      // ollamaCheckConflicts previously only computed ephemerally.
      const candidates = findRelatedCandidates(db, stored.id, 5);
      if (candidates.length > 0) {
        await inferRelationships(db, unit, candidates, options.model);
      }

      const doc = await generateDocument(unit, stored.topic, {
        model: options.model,
        projectSmritiDir: outputDir,
        author,
      });

      const categoryDir = join(knowledgeDir, doc.category.replaceAll("/", "-"));
      mkdirSync(categoryDir, { recursive: true });
      const filePath = join(categoryDir, doc.filename);

      // Carry canonical entity ids + unit-to-unit edges into shared
      // frontmatter. Unlike entity ids, these edges need no team-level
      // canonicalization step — unit.id is already a portable UUID once
      // shared (see src/team/document.ts's frontmatter `id` field), so
      // syncTeamKnowledge can re-create them on a teammate's machine as-is.
      const entityIds = getRelationships(db, {
        subjectType: "knowledge_unit",
        subjectId: stored.id,
        predicate: "mentions",
        objectType: "entity",
      }).map((r) => r.object_id);
      const outgoingEdges = getRelationships(db, {
        subjectType: "knowledge_unit",
        subjectId: stored.id,
      }).filter((r) => r.predicate !== "mentions");

      const fm = generateFrontmatter(
        stored.session_id,
        doc.unitId,
        {
          ...doc.frontmatter,
          pipeline: "consolidated",
          entity_ids: entityIds,
          ...groupEdgesByPredicate(outgoingEdges),
        },
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

// =============================================================================
// Relationship Inference (promote-time, LLM-gated)
// =============================================================================

const MAX_EXCERPT_CHARS = 800;

export type RelationCandidate = { id: string; topic: string; category: string; plain_text: string };
export type RelationGuess = { index: number; predicate: RelationshipPredicate | "none" };

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function buildCandidateBlock(candidates: RelationCandidate[]): string {
  return candidates
    .map((c, i) => `[${i}] Topic: ${c.topic}\nCategory: ${c.category}\nContent: ${truncate(c.plain_text, MAX_EXCERPT_CHARS)}`)
    .join("\n\n");
}

function buildComparisonPreamble(
  unit: { topic: string; category: string; plainText: string },
  candidates: RelationCandidate[]
): string {
  return `NEW UNIT
Topic: ${unit.topic}
Category: ${unit.category}
Content: ${truncate(unit.plainText, MAX_EXCERPT_CHARS)}

CANDIDATES
${buildCandidateBlock(candidates)}`;
}

// Brackets optional: models reliably get the index and predicate right but
// don't reliably reproduce "[i]" literally (observed: "RELATION 0: supersedes"
// instead of "RELATION [0]: supersedes") — a strict bracket requirement here
// silently drops otherwise-correct answers.
const RELATION_LINE = /RELATION\s*\[?(\d+)\]?:\s*(relatesTo|supersedes|contradicts|none)/gi;

// Case-insensitive regex match -> canonical camelCase predicate (avoid a blind
// .toLowerCase() on the match, which would turn "relatesTo" into "relatesto").
const PREDICATE_BY_LOWERCASE: Record<string, RelationshipPredicate> = {
  relatesto: "relatesTo",
  supersedes: "supersedes",
  contradicts: "contradicts",
};

/**
 * Original approach: ask for free-text "RELATION [i]: predicate" lines and
 * parse them with a regex. Kept only as the "before" baseline for the eval
 * comparison against classifyRelationshipsToolCall — no longer wired into
 * inferRelationships().
 */
export async function classifyRelationshipsTextFormat(
  unit: { topic: string; category: string; plainText: string },
  candidates: RelationCandidate[],
  model?: string
): Promise<RelationGuess[]> {
  const prompt = `You are comparing a NEW knowledge unit against CANDIDATE units that already mention at least one of the same topics/entities.

${buildComparisonPreamble(unit, candidates)}

For each candidate, decide the relationship of the NEW unit to it:
- relatesTo: related but neither replaces nor conflicts with the other
- supersedes: the NEW unit replaces/updates the candidate's guidance
- contradicts: the NEW unit conflicts with the candidate
- none: no meaningful relationship

Respond with exactly one line per candidate, in this format:
RELATION [i]: relatesTo|supersedes|contradicts|none`;

  const response = await callOllama(prompt, { model });

  const guesses: RelationGuess[] = [];
  for (const match of response.matchAll(RELATION_LINE)) {
    const index = Number(match[1]);
    const raw = match[2]!.toLowerCase();
    const predicate = raw === "none" ? "none" : PREDICATE_BY_LOWERCASE[raw];
    if (!predicate || !candidates[index]) continue;
    guesses.push({ index, predicate });
  }

  // A non-empty response that yields zero parsed lines almost always means
  // the model drifted from the expected format, not that every candidate
  // was genuinely unrelated — surface it instead of promoting in silence.
  if (guesses.length === 0 && response.trim().length > 0) {
    console.warn(
      `classifyRelationshipsTextFormat: parsed 0 relation lines from a non-empty response — response may not match the expected format:`,
      truncate(response, 300)
    );
  }

  return guesses;
}

const VALID_PREDICATES = new Set(["relatesTo", "supersedes", "contradicts", "none"]);

const RECORD_RELATIONSHIPS_TOOL: OllamaTool = {
  type: "function",
  function: {
    name: "record_relationships",
    description:
      "Record the relationship of the NEW knowledge unit to each CANDIDATE unit, one entry per candidate index.",
    parameters: {
      type: "object",
      properties: {
        relationships: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: {
                type: "integer",
                description: "The candidate's [i] index as shown in the CANDIDATES list",
              },
              predicate: {
                type: "string",
                enum: ["relatesTo", "supersedes", "contradicts", "none"],
                description:
                  "relatesTo: related but neither replaces nor conflicts; supersedes: NEW unit replaces/updates the candidate; contradicts: NEW unit conflicts with the candidate; none: no meaningful relationship",
              },
            },
            required: ["index", "predicate"],
          },
        },
      },
      required: ["relationships"],
    },
  },
};

/**
 * Ask the LLM to classify the NEW unit's relationship to each candidate via
 * a native tool call instead of free-text lines — the model returns
 * structured JSON directly, so there's no format to drift from and nothing
 * to regex-parse.
 */
export async function classifyRelationshipsToolCall(
  unit: { topic: string; category: string; plainText: string },
  candidates: RelationCandidate[],
  model?: string
): Promise<RelationGuess[]> {
  const prompt = `Compare the NEW knowledge unit against each CANDIDATE unit below, then call record_relationships with your assessment for every candidate index.

${buildComparisonPreamble(unit, candidates)}`;

  const resp = await ollamaChat([{ role: "user", content: prompt }], {
    model,
    tools: [RECORD_RELATIONSHIPS_TOOL],
    temperature: 0.1,
  });

  const call = resp.message.tool_calls?.find((c) => c.function.name === "record_relationships");
  if (!call) {
    if (resp.message.content?.trim()) {
      console.warn(
        `classifyRelationshipsToolCall: model answered without calling record_relationships:`,
        truncate(resp.message.content, 300)
      );
    }
    return [];
  }

  const raw = call.function.arguments?.relationships;
  if (!Array.isArray(raw)) return [];

  const guesses: RelationGuess[] = [];
  for (const entry of raw) {
    const index = Number((entry as any)?.index);
    const predicate = (entry as any)?.predicate;
    if (!Number.isInteger(index) || !candidates[index] || !VALID_PREDICATES.has(predicate)) continue;
    guesses.push({ index, predicate });
  }
  return guesses;
}

/**
 * Ask the LLM whether the unit being promoted relatesTo/supersedes/contradicts
 * any of its entity-sharing candidates, and persist the answer as edges.
 * Best-effort: a failure here (LLM down, unparseable response) is swallowed —
 * it's enrichment on top of promotion, not a precondition for it.
 */
async function inferRelationships(
  db: Database,
  unit: KnowledgeUnit,
  candidates: RelationCandidate[],
  model?: string
): Promise<void> {
  try {
    const guesses = await classifyRelationshipsToolCall(unit, candidates, model);

    for (const { index, predicate } of guesses) {
      if (predicate === "none") continue;
      const candidate = candidates[index]!;

      // Directional predicates shouldn't hold in both directions for the same
      // pair. When two entity-sharing units are promoted in the same run,
      // each independently asks "do I relate to/supersede the other" — if the
      // candidate already asserted the reverse relation (e.g. its own
      // promotion ran first in this batch), keep that one and skip the
      // contradictory reverse edge rather than storing both.
      const reverseAlreadyAsserted = getRelationships(db, {
        subjectType: "knowledge_unit",
        subjectId: candidate.id,
        predicate,
        objectType: "knowledge_unit",
        objectId: unit.id,
      }).length > 0;
      if (reverseAlreadyAsserted) continue;

      insertRelationship(db, "knowledge_unit", unit.id, predicate, "knowledge_unit", candidate.id, {
        source: "llm",
      });
    }
  } catch {
    // Enrichment only — never block promotion on a failed/unparseable relation call.
  }
}

/** Group outgoing relationship edges by predicate into frontmatter-ready arrays of object unit ids. */
function groupEdgesByPredicate(
  edges: Array<{ predicate: string; object_id: string }>
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const edge of edges) {
    (grouped[edge.predicate] ??= []).push(edge.object_id);
  }
  return grouped;
}
