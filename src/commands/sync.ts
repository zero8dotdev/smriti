/**
 * Real implementation of `sync` on the new blueprint (see the `sync`
 * case in ../index.ts). Blueprint only - no real DB is touched; the sync
 * backend is injected, defaulting to a safe simulation.
 *
 * Syncs team knowledge from a .smriti/ directory, reading markdown files
 * from the knowledge/ subdirectory and importing them into the local database.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { syncTeamKnowledge } from "../team/sync";

export interface SyncResult {
  filesProcessed: number;
  imported: number;
  skipped: number;
  errors: string[];
  categoriesImported: number;
  entitiesImported: number;
}

export interface SyncOptions {
  inputDir?: string;
  project?: string;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface SyncBackend {
  /** Syncs team knowledge from a .smriti/ directory. */
  syncTeamKnowledge(options: SyncOptions): Promise<SyncResult>;
}

const simulateBackend: SyncBackend = {
  async syncTeamKnowledge() {
    return {
      filesProcessed: 3,
      imported: 2,
      skipped: 1,
      errors: [],
      categoriesImported: 0,
      entitiesImported: 0,
    };
  },
};

/**
 * Real backend, matching the `case "sync":` block in ../index.ts.
 * Delegates to syncTeamKnowledge(db, options) from ../team/sync.ts, passing
 * through the same fields (inputDir, project) that index.ts assembles from
 * CLI args.
 */
export function createRealSyncBackend(db: Database): SyncBackend {
  return {
    async syncTeamKnowledge(options) {
      return syncTeamKnowledge(db, {
        inputDir: options.inputDir,
        project: options.project,
      });
    },
  };
}

export class SyncCommand extends BaseCommand<SyncResult> {
  constructor(private readonly backend: SyncBackend = simulateBackend) {
    super();
  }

  name = "sync";
  summary = "Import team knowledge from .smriti/";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    { flag: "--input", type: "string", description: "custom input directory (defaults to .smriti/ in cwd or project path)" },
    { flag: "--project", type: "string", description: "project to sync into; auto-detects .smriti/ path from project registry" },
  ];
  output = {
    description: "prints count of files processed, imported, skipped, and any errors encountered; optionally shows imported categories and entities",
    jsonShape: "{ filesProcessed: number, imported: number, skipped: number, errors: string[], categoriesImported: number, entitiesImported: number }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti sync", description: "import team knowledge from .smriti/ in current directory" },
    { command: "smriti sync --project myapp", description: "import from .smriti/ of a registered project" },
    { command: "smriti sync --input /path/to/shared/.smriti", description: "import from a custom .smriti/ directory" },
  ];
  detailedSummary =
    "Reads markdown files from .smriti/knowledge/ and imports them as shared sessions with team attribution. " +
    "Merges custom categories and canonical entities from config.json (v2+) before importing files, deduplicates on content hash, " +
    "and re-creates relationship edges from frontmatter. By default uses .smriti/ in the current working directory; " +
    "--project resolves it from the project registry, --input overrides both.";

  protected async execute(parsed: ParsedArgs): Promise<SyncResult> {
    const options: SyncOptions = {
      inputDir: parsed.flags["--input"] as string | undefined,
      project: parsed.flags["--project"] as string | undefined,
    };

    return this.backend.syncTeamKnowledge(options);
  }
}
