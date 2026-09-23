/**
 * Learnings command implementation - list extracted knowledge units with tier, retrievals, relevance.
 * Based on real behavior from ../index.ts case "learnings":
 *   - Optional flags: --tier (segmented|canonical), --min-retrievals (number), --limit (number, default 50)
 *   - Calls listKnowledgeUnits with filters
 *   - Returns StoredKnowledgeUnit[] array
 *   - Formats as table or JSON
 *
 * Blueprint pattern: backend injection for knowledge unit listing,
 * defaulting to safe simulations (no real DB access).
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { listKnowledgeUnits as dbListKnowledgeUnits, type StoredKnowledgeUnit } from "../db";

export interface LearningsBackend {
  /** Retrieves knowledge units filtered by tier, retrieval count, and limit. */
  listKnowledgeUnits(options: {
    tier?: "segmented" | "canonical";
    minRetrievals?: number;
    limit?: number;
  }): Promise<StoredKnowledgeUnit[]>;
}

const simulateBackend: LearningsBackend = {
  async listKnowledgeUnits(): Promise<StoredKnowledgeUnit[]> {
    // Return empty array by default - safe simulation, no real DB access
    return [];
  },
};

/**
 * Real backend - wires the injected seam to the actual smriti_knowledge_units
 * table via db.ts. Mirrors the real `learnings` case in index.ts (~line 924)
 * exactly: `listKnowledgeUnits(options)` is db.ts's `listKnowledgeUnits(db, {
 * tier, minRetrievals, limit })`, called with the same three fields the real
 * case block builds from `--tier`, `--min-retrievals`, and `--limit`
 * (defaulting to 50 there, mirrored by this class's execute()). The real
 * db.ts function is synchronous (bun:sqlite `.all()` is sync) and returns
 * StoredKnowledgeUnit[] directly, not a Promise - wrapped here in an async
 * function to satisfy the interface's Promise<StoredKnowledgeUnit[]> return
 * type; no other transformation is applied. db.ts's `tier` parameter also
 * accepts `"archived"`, a value this interface (and the command's `--tier`
 * enum) never produces, so the widening is safe in this direction only.
 * Not wired into any default - callers opt in explicitly via
 * createRealLearningsBackend(db).
 */
export function createRealLearningsBackend(db: Database): LearningsBackend {
  return {
    async listKnowledgeUnits(options) {
      return dbListKnowledgeUnits(db, options);
    },
  };
}

export class LearningsCommand extends BaseCommand<StoredKnowledgeUnit[]> {
  constructor(private readonly backend: LearningsBackend = simulateBackend) {
    super();
  }

  name = "learnings";
  summary = "List extracted knowledge units (tier, retrievals, relevance)";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    {
      flag: "--tier",
      type: "string",
      enum: ["segmented", "canonical"],
      description: "filter by knowledge unit tier",
    },
    {
      flag: "--min-retrievals",
      type: "number",
      description: "minimum retrieval count threshold",
    },
    {
      flag: "--limit",
      type: "number",
      default: "50",
      description: "maximum results to return",
    },
    {
      flag: "--json",
      type: "boolean",
      description: "output result as JSON",
    },
  ];
  output = {
    description: "table of knowledge units (tier, topic, category, retrievals, relevance, doc path) or JSON array",
    jsonShape: "Array<StoredKnowledgeUnit> - full knowledge unit objects with metadata",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti learnings",
      description: "list top 50 knowledge units by retrieval count",
    },
    {
      command: "smriti learnings --tier canonical --min-retrievals 5",
      description: "list canonical knowledge units retrieved 5+ times",
    },
    {
      command: "smriti learnings --limit 100 --json",
      description: "fetch up to 100 units as JSON",
    },
  ];
  detailedSummary =
    "Knowledge units are extracted segments of work history, organized by tier (segmented or canonical). " +
    "Segmented units are initial captures; canonical units are promoted after reaching relevance thresholds. " +
    "Retrieval count tracks how often a unit was recalled in answers. This command shows the full roster " +
    "with relevance scores, useful for auditing knowledge quality and promotion readiness.";

  protected async execute(parsed: ParsedArgs, _ctx: CommandContext): Promise<StoredKnowledgeUnit[]> {
    const tier = parsed.flags["--tier"] as "segmented" | "canonical" | undefined;
    const minRetrievals = parsed.flags["--min-retrievals"]
      ? Number(parsed.flags["--min-retrievals"])
      : undefined;
    const limit = parsed.flags["--limit"]
      ? Number(parsed.flags["--limit"])
      : 50;

    return await this.backend.listKnowledgeUnits({
      tier,
      minRetrievals,
      limit,
    });
  }
}
