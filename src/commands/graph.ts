/**
 * Graph command implementation - show a canonical entity's mentions and relationship edges.
 * Based on real behavior from ../index.ts case "graph":
 *   - One required positional: entity (query string to resolve to canonical entity)
 *   - Calls findEntity to locate the entity
 *   - If not found, returns empty result (not an error - soft failure)
 *   - Gets all knowledge units mentioning that entity via getUnitsForEntity
 *   - Extracts relationships between those units (excluding "mentions" predicate)
 *   - Outputs as formatted graph or JSON
 *
 * Blueprint pattern: backend injection for entity lookup and relationship retrieval,
 * defaulting to safe simulations (no real DB access).
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import type { StoredEntity, StoredRelationship } from "../learn/entities";
import {
  findEntity as dbFindEntity,
  getUnitsForEntity as dbGetUnitsForEntity,
  getRelationships as dbGetRelationships,
} from "../learn/entities";

export interface KnowledgeUnitInfo {
  id: string;
  topic: string;
  category: string;
  relevance: number;
  tier: string;
  retrieval_count: number;
}

export interface GraphResult {
  entity: StoredEntity | null;
  units: KnowledgeUnitInfo[];
  edges: StoredRelationship[];
}

export interface GraphBackend {
  /** Resolves an entity query to a canonical entity. Returns null if not found. */
  findEntity(query: string): Promise<StoredEntity | null>;
  /** Gets all knowledge units that mention an entity. */
  getUnitsForEntity(entityId: string): Promise<KnowledgeUnitInfo[]>;
  /** Gets relationships between units for a given subject unit, filtering by pattern. */
  getRelationships(opts: {
    subjectType: "knowledge_unit";
    subjectId: string;
  }): Promise<StoredRelationship[]>;
}

const simulateBackend: GraphBackend = {
  async findEntity(): Promise<StoredEntity | null> {
    // Simulate an entity that doesn't exist by default
    return null;
  },
  async getUnitsForEntity(): Promise<KnowledgeUnitInfo[]> {
    return [];
  },
  async getRelationships(): Promise<StoredRelationship[]> {
    return [];
  },
};

/**
 * Real backend - wires the injected seam to the actual smriti_entities /
 * smriti_relationships / smriti_knowledge_units tables via learn/entities.ts.
 * Mirrors the real `graph` case in ../index.ts (~line 942) exactly:
 *   - findEntity(query)          -> learn/entities.ts's findEntity(db, query)
 *   - getUnitsForEntity(entityId) -> learn/entities.ts's getUnitsForEntity(db, entityId)
 *   - getRelationships({ subjectType, subjectId })
 *       -> learn/entities.ts's getRelationships(db, { subjectType, subjectId })
 *          (a TriplePattern with only subjectType/subjectId set, exactly as
 *          the real case block calls it - objectType/objectId/predicate are
 *          left unset so the SQL WHERE clause is unfiltered on those columns;
 *          filtering by predicate/object membership happens client-side in
 *          GraphCommand.execute(), same as the real case block does inline).
 * All three real functions are synchronous (better-sqlite3-style `Database`
 * from bun:sqlite); wrapped in `async` here only to satisfy the Promise-based
 * GraphBackend interface - no behavior change, values are returned as-is.
 * Not wired into any default - callers opt in explicitly via
 * createRealGraphBackend(db).
 */
export function createRealGraphBackend(db: Database): GraphBackend {
  return {
    async findEntity(query) {
      return dbFindEntity(db, query);
    },
    async getUnitsForEntity(entityId) {
      return dbGetUnitsForEntity(db, entityId);
    },
    async getRelationships(opts) {
      return dbGetRelationships(db, opts);
    },
  };
}

export class GraphCommand extends BaseCommand<GraphResult> {
  constructor(private readonly backend: GraphBackend = simulateBackend) {
    super();
  }

  name = "graph";
  summary = "Show a canonical entity's mentions and relationship edges";
  args: ArgSpec[] = [
    {
      name: "entity",
      type: "string",
      required: true,
      description: "entity name or query string to resolve to a canonical entity",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--json", type: "boolean", description: "output result as JSON" },
  ];
  output = {
    description: "entity details, all knowledge units mentioning it, and relationships between those units",
    jsonShape: "{ entity: StoredEntity | null, units: KnowledgeUnitInfo[], edges: StoredRelationship[] }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti graph JWT",
      description: "show entity 'JWT', all units mentioning it, and their relationships",
    },
    {
      command: "smriti graph 'async/await' --json",
      description: "resolve entity and output the graph structure as JSON",
    },
    {
      command: "smriti graph auth",
      description: "show the relationship graph for the 'auth' entity across all work sessions",
    },
  ];
  detailedSummary =
    "Entities are canonical concepts extracted from knowledge units across all sessions. " +
    "The graph shows a bird's-eye view: which knowledge units mention this entity, and which " +
    "of those units relate to each other (via relationships other than 'mentions'). " +
    "Useful for understanding how a concept was discussed and connected across your work.";

  protected async execute(parsed: ParsedArgs, _ctx: CommandContext): Promise<GraphResult> {
    const entityQuery = parsed.positionals[0];

    // Find the entity (may be null if not found — not an error)
    const entity = await this.backend.findEntity(entityQuery);
    if (!entity) {
      // Return empty result; the caller decides how to present it
      return { entity: null, units: [], edges: [] };
    }

    // Get all knowledge units mentioning this entity
    const units = await this.backend.getUnitsForEntity(entity.id);
    const unitIds = new Set(units.map((u) => u.id));

    // Get all relationships between those units (excluding "mentions" predicate)
    const edges: StoredRelationship[] = [];
    for (const unit of units) {
      const unitEdges = await this.backend.getRelationships({
        subjectType: "knowledge_unit",
        subjectId: unit.id,
      });
      // Filter: keep only edges that point to other units in our set,
      // and exclude "mentions" relationships (they're implicit in the unit list)
      const relevant = unitEdges.filter(
        (r) => r.predicate !== "mentions" && unitIds.has(r.object_id)
      );
      edges.push(...relevant);
    }

    return { entity, units, edges };
  }
}
