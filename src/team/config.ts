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

export type SmritiConfig = {
  version: number;
  categories?: CustomCategoryDef[];
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
