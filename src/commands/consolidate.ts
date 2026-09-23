/**
 * Real implementation of `consolidate` on the new blueprint (see the `consolidate`
 * case in ../index.ts). Blueprint only - no real DB is touched; the consolidation
 * backend is injected, defaulting to a safe simulation.
 *
 * Consolidates dense sessions by segmenting them into smaller units, promoting
 * reused units to canonical status, and pruning stale/superseded knowledge.
 * The prune phase is optional and defaults to dry-run (prints candidates, deletes nothing).
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { consolidateKnowledge } from "../learn/consolidate";

export interface PruneCandidate {
  id: string;
  topic: string;
  tier: string;
  action: string;
  reason: string;
}

export interface ConsolidateResult {
  sessionsSegmented: number;
  unitsStored: number;
  unitsSkipped: number;
  unitsPromoted: number;
  unitsPruned?: number;
  unitsArchived?: number;
  pruneCandidates?: PruneCandidate[];
  errors: string[];
}

export interface ConsolidateOptions {
  minDensity?: number;
  minRetrievals?: number;
  minRelevance?: number;
  minEntityReach?: number;
  model?: string;
  outputDir?: string;
  sessionLimit?: number;
  prune: boolean;
  pruneStaleDays?: number;
  pruneApply: boolean;
  onProgress?: (msg: string) => void;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface ConsolidateBackend {
  /** Runs the consolidation process. */
  consolidateKnowledge(options: ConsolidateOptions): Promise<ConsolidateResult>;
}

const simulateBackend: ConsolidateBackend = {
  async consolidateKnowledge(options): Promise<ConsolidateResult> {
    options.onProgress?.("Simulating segmentation...");
    options.onProgress?.("Simulating promotion...");

    // Simulate results based on prune flags
    if (options.prune && !options.pruneApply) {
      // Dry-run mode: show candidates
      return {
        sessionsSegmented: 3,
        unitsStored: 12,
        unitsSkipped: 2,
        unitsPromoted: 4,
        pruneCandidates: [
          { id: "unit-1", topic: "auth", tier: "segmented", action: "delete", reason: "stale (35 days old)" },
          { id: "unit-2", topic: "api", tier: "segmented", action: "archive", reason: "superseded by unit-3" },
        ],
        errors: [],
      };
    } else if (options.prune && options.pruneApply) {
      // Prune applied
      return {
        sessionsSegmented: 3,
        unitsStored: 12,
        unitsSkipped: 2,
        unitsPromoted: 4,
        unitsPruned: 2,
        unitsArchived: 1,
        errors: [],
      };
    } else {
      // No prune phase
      return {
        sessionsSegmented: 2,
        unitsStored: 8,
        unitsSkipped: 1,
        unitsPromoted: 2,
        errors: [],
      };
    }
  },
};

/**
 * Real backend, wired to the actual consolidation pipeline (src/learn/consolidate.ts),
 * matching exactly what the `consolidate` case in ../index.ts does. Not invoked here -
 * wiring into index.ts happens separately, by hand.
 */
export function createRealConsolidateBackend(db: Database): ConsolidateBackend {
  return {
    async consolidateKnowledge(options: ConsolidateOptions): Promise<ConsolidateResult> {
      return consolidateKnowledge(db, {
        minDensity: options.minDensity,
        minRetrievals: options.minRetrievals,
        minRelevance: options.minRelevance,
        minEntityReach: options.minEntityReach,
        model: options.model,
        outputDir: options.outputDir,
        sessionLimit: options.sessionLimit,
        prune: options.prune,
        pruneStaleDays: options.pruneStaleDays,
        pruneApply: options.pruneApply,
        onProgress: options.onProgress,
      });
    },
  };
}

export class ConsolidateCommand extends BaseCommand<ConsolidateResult> {
  constructor(private readonly backend: ConsolidateBackend = simulateBackend) {
    super();
  }

  name = "consolidate";
  summary = "Segment dense sessions, promote reused units, prune stale/superseded ones";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    { flag: "--min-density", type: "number", description: "minimum density score threshold" },
    { flag: "--min-retrievals", type: "number", description: "minimum number of retrievals to promote a unit" },
    { flag: "--min-relevance", type: "number", description: "minimum relevance score for units" },
    { flag: "--min-entity-reach", type: "number", description: "minimum entity mention count to promote" },
    { flag: "--model", type: "string", description: "LLM model for segmentation (e.g. llama2)" },
    { flag: "--output", type: "string", description: "output directory for promoted knowledge docs" },
    { flag: "--session-limit", type: "number", description: "max sessions to process" },
    { flag: "--prune", type: "boolean", description: "also run the prune phase (dry-run by default)" },
    { flag: "--yes", type: "boolean", description: "actually delete/archive prune candidates (requires --prune)" },
    { flag: "--apply", type: "boolean", description: "synonym for --yes" },
    { flag: "--prune-stale-days", type: "number", default: "30", description: "age threshold for stale segmented units" },
  ];
  output = {
    description: "segments processed, units stored/promoted, and (if --prune) deletion/archive counts",
    jsonShape: "{ sessionsSegmented: number, unitsStored: number, unitsSkipped: number, unitsPromoted: number, unitsPruned?: number, unitsArchived?: number, pruneCandidates?: Array<{id, topic, tier, action, reason}>, errors: string[] }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti consolidate",
      description: "segment all dense sessions, promote reused units (no prune)",
    },
    {
      command: "smriti consolidate --prune",
      description: "segment and show prune candidates (dry-run mode)",
    },
    {
      command: "smriti consolidate --prune --yes --prune-stale-days 60",
      description: "segment, identify stale units older than 60 days, and delete them",
    },
  ];
  detailedSummary =
    "Consolidation runs a three-phase pipeline: (1) segment dense sessions into smaller units, " +
    "(2) promote frequently-reused units to canonical status (shared knowledge), " +
    "(3) optionally prune stale or superseded units. " +
    "Without --prune, only segmentation and promotion run. " +
    "With --prune but without --yes/--apply, prune candidates are printed (dry-run). " +
    "With --prune --yes/--apply, candidates are deleted or archived for real. " +
    "Thresholds (--min-density, --min-retrievals, etc.) filter which sessions/units qualify for each phase.";

  protected async execute(parsed: ParsedArgs): Promise<ConsolidateResult> {
    const prune = parsed.flags["--prune"] === true;
    const pruneApply = parsed.flags["--yes"] === true || parsed.flags["--apply"] === true;

    const result = await this.backend.consolidateKnowledge({
      minDensity: this.parseOptionalNumber(parsed, "--min-density"),
      minRetrievals: this.parseOptionalNumber(parsed, "--min-retrievals"),
      minRelevance: this.parseOptionalNumber(parsed, "--min-relevance"),
      minEntityReach: this.parseOptionalNumber(parsed, "--min-entity-reach"),
      model: parsed.flags["--model"] as string | undefined,
      outputDir: parsed.flags["--output"] as string | undefined,
      sessionLimit: this.parseOptionalNumber(parsed, "--session-limit"),
      prune,
      pruneStaleDays: this.parseOptionalNumber(parsed, "--prune-stale-days") || 30,
      pruneApply,
      onProgress: (msg) => console.log(`  ${msg}`),
    });

    return result;
  }

  private parseOptionalNumber(parsed: ParsedArgs, flag: string): number | undefined {
    const value = parsed.flags[flag];
    if (value === undefined || value === true) return undefined;
    const num = Number(String(value));
    return Number.isNaN(num) ? undefined : num;
  }
}
