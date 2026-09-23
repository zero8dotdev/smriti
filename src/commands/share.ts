/**
 * Real implementation of `share` on the new blueprint (see the `share`
 * case in ../index.ts). Exports knowledge to .smriti/ for team sharing.
 *
 * All filters (--category, --project, --session) are optional and can be
 * combined to target specific sessions. The output directory defaults to
 * .smriti/ in the current project or working directory.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { shareKnowledge } from "../team/share";

export interface ShareResult {
  filesCreated: number;
  filesSkipped: number;
  outputDir: string;
  errors: string[];
}

export interface ShareFilters {
  category?: string;
  project?: string;
  sessionId?: string;
}

export interface ShareOptions extends ShareFilters {
  outputDir?: string;
  reflect?: boolean;
  reflectModel?: string;
  segmented?: boolean;
  minRelevance?: number;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface ShareBackend {
  /** Exports knowledge to .smriti/ directory, returns result with counts. */
  share(options: ShareOptions): Promise<ShareResult>;
}

const simulateBackend: ShareBackend = {
  async share(options) {
    // Simulate successful share: create 3 files, skip 1
    return {
      filesCreated: 3,
      filesSkipped: 1,
      outputDir: options.outputDir || ".smriti",
      errors: [],
    };
  },
};

/**
 * Real backend, matching the `case "share":` block in ../index.ts.
 * Delegates to shareKnowledge(db, options) from ../team/share.ts, passing
 * through the same fields (category, project, sessionId, outputDir, reflect,
 * reflectModel, segmented, minRelevance) that index.ts assembles from CLI args.
 */
export function createRealShareBackend(db: Database): ShareBackend {
  return {
    async share(options) {
      return shareKnowledge(db, {
        category: options.category,
        project: options.project,
        sessionId: options.sessionId,
        outputDir: options.outputDir,
        reflect: options.reflect,
        reflectModel: options.reflectModel,
        segmented: options.segmented,
        minRelevance: options.minRelevance,
      });
    },
  };
}

export class ShareCommand extends BaseCommand<ShareResult> {
  constructor(private readonly backend: ShareBackend = simulateBackend) {
    super();
  }

  name = "share";
  summary = "Export knowledge to .smriti/ for team sharing";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    { flag: "--category", type: "string", description: "filter by category" },
    { flag: "--project", type: "string", description: "filter by project" },
    { flag: "--session", type: "string", description: "share specific session" },
    { flag: "--output", type: "string", description: "custom output directory" },
    { flag: "--no-reflect", type: "boolean", description: "skip LLM reflections" },
    { flag: "--reflect-model", type: "string", description: "Ollama model for reflections" },
    { flag: "--segmented", type: "boolean", description: "use 3-stage segmentation pipeline (beta)" },
    { flag: "--min-relevance", type: "number", description: "relevance threshold for segmented mode" },
  ];
  output = {
    description: "prints files created, skipped, output directory, and any errors",
    jsonShape: "{ filesCreated: number, filesSkipped: number, outputDir: string, errors: string[] }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti share --category decision",
      description: "export all sessions tagged with 'decision' to .smriti/knowledge/",
    },
    {
      command: "smriti share --project myapp --no-reflect",
      description: "export sessions from myapp project without LLM synthesis",
    },
    {
      command: "smriti share --session abc123 --segmented --output /tmp/export",
      description: "export one session using segmentation pipeline to custom directory",
    },
  ];
  detailedSummary =
    "Export sessions to markdown files in .smriti/knowledge/ for git-based sharing. " +
    "By default, uses LLM reflection to synthesize knowledge articles (--no-reflect to skip). " +
    "--segmented enables 3-stage segmentation pipeline. " +
    "All filters (--category, --project, --session) are optional and can be combined.";

  protected async execute(parsed: ParsedArgs): Promise<ShareResult> {
    // Parse min-relevance as a number if present
    const minRelevanceStr = parsed.flags["--min-relevance"];
    let minRelevance: number | undefined;
    if (minRelevanceStr !== undefined && minRelevanceStr !== true) {
      minRelevance = Number(minRelevanceStr);
    }

    return this.backend.share({
      category: parsed.flags["--category"] as string | undefined,
      project: parsed.flags["--project"] as string | undefined,
      sessionId: parsed.flags["--session"] as string | undefined,
      outputDir: parsed.flags["--output"] as string | undefined,
      reflect: parsed.flags["--no-reflect"] !== true,
      reflectModel: parsed.flags["--reflect-model"] as string | undefined,
      segmented: parsed.flags["--segmented"] === true,
      minRelevance,
    });
  }
}
