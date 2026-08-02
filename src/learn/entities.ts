/**
 * learn/entities.ts - Canonical entity resolution + relationship triples
 *
 * RDF-inspired, not literal RDF: no URIs/Turtle/SPARQL. Subject/object are
 * (type, id) pairs instead of global URIs, since Smriti is a local SQLite
 * tool, not a web-facing linked-data endpoint. The useful ideas kept are:
 * stable resource identity (so recurrence is detected across wording
 * variance) and typed subject-predicate-object facts that survive team
 * sharing (see src/team/config.ts's exportEntities/mergeEntities and
 * src/team/document.ts's frontmatter for how these propagate org-wide).
 *
 * v1 entity resolution is exact-normalize only (case/whitespace/punctuation
 * via slugify) — "JWT" and "jwt" merge, "JWT" and "JSON Web Token" do not.
 * True synonym resolution needs semantic matching and is out of scope here.
 */

import type { Database } from "bun:sqlite";
import { slugify } from "../team/utils";

// =============================================================================
// Types
// =============================================================================

export type EntityType = "technology" | "concept" | "file" | "pattern";
export type RelationshipPredicate = "mentions" | "relatesTo" | "supersedes" | "contradicts";
export type RelationshipSubjectType = "knowledge_unit" | "entity" | "session";
export type RelationshipSource = "extraction" | "derived" | "llm";

export type StoredEntity = {
  id: string;
  label: string;
  entity_type: EntityType;
  aliases: string[];
  mention_count: number;
  first_seen_at: string;
};

export type StoredRelationship = {
  id: number;
  subject_type: RelationshipSubjectType;
  subject_id: string;
  predicate: RelationshipPredicate;
  object_type: RelationshipSubjectType;
  object_id: string;
  confidence: number;
  source: RelationshipSource;
  created_at: string;
};

type EntityRow = {
  id: string;
  label: string;
  entity_type: string;
  aliases: string;
  mention_count: number;
  first_seen_at: string;
};

function deserializeEntity(row: EntityRow): StoredEntity {
  return {
    ...row,
    entity_type: row.entity_type as EntityType,
    aliases: JSON.parse(row.aliases),
  };
}

// =============================================================================
// Entity Resolution
// =============================================================================

/**
 * Resolve a raw, free-text entity label to a canonical entity id, creating
 * the entity if it doesn't exist yet. Matching is exact-normalize (via
 * slugify) — same case/whitespace variant collapses to one node; different
 * wordings for the same concept do not (see module docstring).
 */
export function resolveEntity(
  db: Database,
  rawLabel: string,
  entityType: EntityType = "concept"
): string | null {
  const trimmed = rawLabel.trim();
  if (!trimmed) return null;

  const id = slugify(trimmed);
  if (!id) return null;

  const existing = db
    .prepare(`SELECT aliases FROM smriti_entities WHERE id = ?`)
    .get(id) as { aliases: string } | null;

  if (existing) {
    const aliases: string[] = JSON.parse(existing.aliases);
    if (!aliases.includes(trimmed)) {
      aliases.push(trimmed);
      db.prepare(
        `UPDATE smriti_entities SET aliases = ?, mention_count = mention_count + 1 WHERE id = ?`
      ).run(JSON.stringify(aliases), id);
    } else {
      db.prepare(`UPDATE smriti_entities SET mention_count = mention_count + 1 WHERE id = ?`).run(id);
    }
    return id;
  }

  db.prepare(
    `INSERT INTO smriti_entities (id, label, entity_type, aliases, mention_count)
     VALUES (?, ?, ?, ?, 1)`
  ).run(id, trimmed, entityType, JSON.stringify([trimmed]));
  return id;
}

export function getEntity(db: Database, id: string): StoredEntity | null {
  const row = db.prepare(`SELECT * FROM smriti_entities WHERE id = ?`).get(id) as EntityRow | null;
  return row ? deserializeEntity(row) : null;
}

/** Look up an entity by exact id, or by slugified/label match against a raw query string. */
export function findEntity(db: Database, query: string): StoredEntity | null {
  const bySlug = getEntity(db, slugify(query));
  if (bySlug) return bySlug;

  const row = db
    .prepare(`SELECT * FROM smriti_entities WHERE LOWER(label) = LOWER(?)`)
    .get(query.trim()) as EntityRow | null;
  return row ? deserializeEntity(row) : null;
}

/** Knowledge units that `mentions` a given canonical entity — the display side of `smriti graph <entity>`. */
export function getUnitsForEntity(
  db: Database,
  entityId: string
): Array<{ id: string; topic: string; category: string; relevance: number; tier: string; retrieval_count: number }> {
  return db
    .prepare(
      `SELECT ku.id, ku.topic, ku.category, ku.relevance, ku.tier, ku.retrieval_count
       FROM smriti_relationships r
       JOIN smriti_knowledge_units ku ON ku.id = r.subject_id
       WHERE r.subject_type = 'knowledge_unit' AND r.object_type = 'entity'
         AND r.predicate = 'mentions' AND r.object_id = ? AND ku.tier != 'archived'
       ORDER BY ku.retrieval_count DESC, ku.relevance DESC`
    )
    .all(entityId) as Array<{
    id: string; topic: string; category: string; relevance: number; tier: string; retrieval_count: number;
  }>;
}

export function listEntities(db: Database, limit?: number): StoredEntity[] {
  const rows = (
    limit
      ? db.prepare(`SELECT * FROM smriti_entities ORDER BY mention_count DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT * FROM smriti_entities ORDER BY mention_count DESC`).all()
  ) as EntityRow[];
  return rows.map(deserializeEntity);
}

// =============================================================================
// Relationship Triples
// =============================================================================

/** Insert a (subject, predicate, object) triple. Deduped via the table's UNIQUE constraint. */
export function insertRelationship(
  db: Database,
  subjectType: RelationshipSubjectType,
  subjectId: string,
  predicate: RelationshipPredicate,
  objectType: RelationshipSubjectType,
  objectId: string,
  options: { confidence?: number; source?: RelationshipSource } = {}
): void {
  db.prepare(
    `INSERT OR IGNORE INTO smriti_relationships
      (subject_type, subject_id, predicate, object_type, object_id, confidence, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    subjectType,
    subjectId,
    predicate,
    objectType,
    objectId,
    options.confidence ?? 1.0,
    options.source ?? "extraction"
  );
}

export type TriplePattern = {
  subjectType?: RelationshipSubjectType;
  subjectId?: string;
  predicate?: RelationshipPredicate;
  objectType?: RelationshipSubjectType;
  objectId?: string;
};

/** Single-pattern triple lookup — the basic-graph-pattern piece of SPARQL, simplified to one triple at a time. */
export function getRelationships(db: Database, pattern: TriplePattern): StoredRelationship[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (pattern.subjectType) { conditions.push("subject_type = ?"); params.push(pattern.subjectType); }
  if (pattern.subjectId) { conditions.push("subject_id = ?"); params.push(pattern.subjectId); }
  if (pattern.predicate) { conditions.push("predicate = ?"); params.push(pattern.predicate); }
  if (pattern.objectType) { conditions.push("object_type = ?"); params.push(pattern.objectType); }
  if (pattern.objectId) { conditions.push("object_id = ?"); params.push(pattern.objectId); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM smriti_relationships ${where}`).all(...params) as StoredRelationship[];
}

/**
 * Find other knowledge units that `mentions` at least one of the same
 * canonical entities as `unitId` — the candidate set for promote-time
 * LLM relationship inference (bounded, so that call stays cheap).
 */
export function findRelatedCandidates(
  db: Database,
  unitId: string,
  limit: number = 5
): Array<{ id: string; topic: string; category: string; plain_text: string }> {
  return db
    .prepare(
      `SELECT DISTINCT ku.id, ku.topic, ku.category, ku.plain_text
       FROM smriti_relationships r1
       JOIN smriti_relationships r2
         ON r1.object_id = r2.object_id
        AND r2.object_type = 'entity' AND r2.predicate = 'mentions'
       JOIN smriti_knowledge_units ku ON ku.id = r2.subject_id
       WHERE r1.subject_type = 'knowledge_unit' AND r1.subject_id = ?
         AND r1.object_type = 'entity' AND r1.predicate = 'mentions'
         AND r2.subject_id != r1.subject_id
       LIMIT ?`
    )
    .all(unitId, limit) as Array<{ id: string; topic: string; category: string; plain_text: string }>;
}
