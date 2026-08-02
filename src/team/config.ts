/**
 * team/config.ts - .smriti/config.json schema and read/write/merge utilities
 */

import type { Database } from "bun:sqlite";
import { join } from "path";
import { ALL_CATEGORY_IDS } from "../categorize/schema";

// =============================================================================
// Types
// =============================================================================

export type CustomCategoryDef = {
  id: string;
  name: string;
  parent?: string;
  description?: string;
};

export type CustomEntityDef = {
  id: string;
  label: string;
  entity_type: string;
  aliases: string[];
};

export type SmritiConfig = {
  version: number;
  categories?: CustomCategoryDef[];
  entities?: CustomEntityDef[];
  allowedCategories?: string[];
  autoSync?: boolean;
};

// =============================================================================
// Read / Write
// =============================================================================

const CONFIG_FILE = "config.json";

export function readConfig(smritiDir: string): SmritiConfig {
  try {
    const { readFileSync } = require("fs");
    const json = readFileSync(join(smritiDir, CONFIG_FILE), "utf-8");
    return JSON.parse(json) as SmritiConfig;
  } catch {
    return { version: 1 };
  }
}

export async function writeConfig(
  smritiDir: string,
  config: SmritiConfig
): Promise<void> {
  await Bun.write(join(smritiDir, CONFIG_FILE), JSON.stringify(config, null, 2));
}

// =============================================================================
// Category Merge
// =============================================================================

const BUILTIN_IDS = new Set<string>(ALL_CATEGORY_IDS);

/**
 * Upsert custom categories from config into the local DB.
 * Sorts by slash-depth so parents are always created before children.
 * Returns count of newly created categories.
 */
export function mergeCategories(
  db: Database,
  categories: CustomCategoryDef[]
): number {
  if (categories.length === 0) return 0;

  // Parents before children: sort by number of slashes in id
  const sorted = [...categories].sort(
    (a, b) => (a.id.split("/").length) - (b.id.split("/").length)
  );

  let created = 0;
  for (const cat of sorted) {
    if (BUILTIN_IDS.has(cat.id)) continue;
    const existing = db
      .prepare(`SELECT id FROM smriti_categories WHERE id = ?`)
      .get(cat.id);
    if (existing) continue;

    // Validate parent exists if specified
    if (cat.parent) {
      const parentExists = db
        .prepare(`SELECT id FROM smriti_categories WHERE id = ?`)
        .get(cat.parent);
      if (!parentExists) continue; // skip orphan — parent not yet created
    }

    db.prepare(
      `INSERT OR IGNORE INTO smriti_categories (id, name, parent_id, description)
       VALUES (?, ?, ?, ?)`
    ).run(cat.id, cat.name, cat.parent ?? null, cat.description ?? null);
    created++;
  }
  return created;
}

// =============================================================================
// Export custom categories from DB
// =============================================================================

/**
 * Query smriti_categories for non-builtin entries and return as config defs.
 */
export function exportCustomCategories(db: Database): CustomCategoryDef[] {
  const rows = db
    .prepare(`SELECT id, name, parent_id, description FROM smriti_categories`)
    .all() as { id: string; name: string; parent_id: string | null; description: string | null }[];

  return rows
    .filter((r) => !BUILTIN_IDS.has(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.parent_id ? { parent: r.parent_id } : {}),
      ...(r.description ? { description: r.description } : {}),
    }));
}

// =============================================================================
// Entity Merge — team/org propagation for smriti_entities
//
// Same reasoning as categories: an entity's canonical id is only meaningful
// if every teammate's machine agrees on it. .smriti/config.json is the
// git-committed source of truth each local smriti_entities table converges
// toward on every share/sync — the same role a published vocabulary plays
// for literal RDF, minus the URIs.
// =============================================================================

/**
 * Upsert entities from config into the local DB. Matches first by id, then
 * falls back to a normalized-label match (so two machines that independently
 * minted different ids for the same concept still converge once either
 * syncs the shared file). Unions aliases on conflict rather than overwriting.
 * Returns count of newly created entities.
 */
export function mergeEntities(db: Database, entities: CustomEntityDef[]): number {
  if (entities.length === 0) return 0;

  let created = 0;
  for (const entity of entities) {
    const existingById = db
      .prepare(`SELECT id, aliases FROM smriti_entities WHERE id = ?`)
      .get(entity.id) as { id: string; aliases: string } | null;

    if (existingById) {
      const aliases = new Set<string>(JSON.parse(existingById.aliases));
      for (const a of entity.aliases) aliases.add(a);
      db.prepare(`UPDATE smriti_entities SET aliases = ? WHERE id = ?`)
        .run(JSON.stringify([...aliases]), entity.id);
      continue;
    }

    const normalizedLabel = entity.label.trim().toLowerCase();
    const existingByLabel = db
      .prepare(`SELECT id, aliases FROM smriti_entities WHERE LOWER(label) = ?`)
      .get(normalizedLabel) as { id: string; aliases: string } | null;

    if (existingByLabel) {
      const aliases = new Set<string>(JSON.parse(existingByLabel.aliases));
      for (const a of entity.aliases) aliases.add(a);
      db.prepare(`UPDATE smriti_entities SET aliases = ? WHERE id = ?`)
        .run(JSON.stringify([...aliases]), existingByLabel.id);
      continue;
    }

    db.prepare(
      `INSERT INTO smriti_entities (id, label, entity_type, aliases, mention_count)
       VALUES (?, ?, ?, ?, 0)`
    ).run(entity.id, entity.label, entity.entity_type, JSON.stringify(entity.aliases));
    created++;
  }
  return created;
}

/** Query smriti_entities and return as config defs for export to .smriti/config.json. */
export function exportEntities(db: Database): CustomEntityDef[] {
  const rows = db
    .prepare(`SELECT id, label, entity_type, aliases FROM smriti_entities`)
    .all() as Array<{ id: string; label: string; entity_type: string; aliases: string }>;

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    entity_type: r.entity_type,
    aliases: JSON.parse(r.aliases),
  }));
}
