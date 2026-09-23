/**
 * Real implementation of `digest` on the new blueprint (see the `digest`
 * case in ../index.ts). Generates a structured work summary for a time window.
 *
 * Shows session activity grouped by project for the past N days, with optional
 * LLM synthesis via Ollama. All flags are optional - the command has a default
 * path (7 days, no synthesis) and can be refined with --days, --project, --synthesize, --model.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { generateDigest } from "../digest";

export interface DigestSession {
  id: string;
  title: string;
  projectId: string | null;
  agentId: string | null;
  toolCount: number;
  fileCount: number;
  gitCount: number;
  errorCount: number;
  totalTokens: number;
  estimatedCost: number;
  densityScore: number;
  updatedAt: string;
}

export interface DigestProject {
  projectId: string | null;
  sessionCount: number;
  totalTokens: number;
  estimatedCost: number;
  filesChanged: number;
  gitOps: number;
  errorCount: number;
  topTools: Array<{ toolName: string; count: number }>;
  sessions: DigestSession[];
}

export interface DigestReport {
  period: { from: string; to: string; days: number };
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCost: number;
  byProject: DigestProject[];
  topErrors: Array<{ message: string; count: number }>;
  synthesis?: string;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface DigestBackend {
  /** Generates a digest report for the given time window and options. */
  generateDigest(options: {
    days?: number;
    project?: string;
    synthesize?: boolean;
    model?: string;
  }): Promise<DigestReport>;
}

const simulateBackend: DigestBackend = {
  async generateDigest(options) {
    const days = options.days ?? 7;
    const now = new Date().toISOString();
    const from = new Date(Date.now() - days * 86_400_000).toISOString();

    // Simulate a digest with one project and two sessions
    const project: DigestProject = {
      projectId: options.project ?? "simulated-project",
      sessionCount: 2,
      totalTokens: 12500,
      estimatedCost: 0.0375,
      filesChanged: 8,
      gitOps: 3,
      errorCount: 1,
      topTools: [
        { toolName: "read", count: 45 },
        { toolName: "write", count: 32 },
      ],
      sessions: [
        {
          id: "sess-001",
          title: "Feature implementation",
          projectId: options.project ?? "simulated-project",
          agentId: "claude-code",
          toolCount: 35,
          fileCount: 5,
          gitCount: 2,
          errorCount: 0,
          totalTokens: 8000,
          estimatedCost: 0.024,
          densityScore: 0.75,
          updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
        {
          id: "sess-002",
          title: "Bug fixes",
          projectId: options.project ?? "simulated-project",
          agentId: "claude-code",
          toolCount: 25,
          fileCount: 3,
          gitCount: 1,
          errorCount: 1,
          totalTokens: 4500,
          estimatedCost: 0.0135,
          densityScore: 0.65,
          updatedAt: now,
        },
      ],
    };

    let report: DigestReport = {
      period: { from, to: now, days },
      totalSessions: 2,
      totalMessages: 156,
      totalTokens: 12500,
      estimatedCost: 0.0375,
      byProject: [project],
      topErrors: [{ message: "connection timeout", count: 1 }],
    };

    if (options.synthesize) {
      report.synthesis =
        "Over the past " +
        days +
        " days, focused work on the simulated-project resulted in feature implementation and bug fixes. " +
        "8 files changed across 2 sessions, with 3 git operations. Moderate density sessions indicate well-structured work.";
    }

    return report;
  },
};

/**
 * Real backend, backed by the shared sqlite Database handle.
 *
 * Mirrors ../index.ts case "digest": exactly:
 *   - generateDigest(db, { days, project, synthesize, model })  from ../digest
 *
 * ../digest.ts's `generateDigest` does all the work the real case block
 * does (session query, per-session tool/file/git/error/cost aggregation,
 * per-project grouping/sorting, top-errors, and best-effort Ollama
 * synthesis when `synthesize` is set) - the case block itself calls
 * nothing else before formatting/printing the result, so this factory
 * is a direct pass-through. The real `DigestReport`/`DigestProject`/
 * `DigestSession` shapes exported from ../digest.ts are structurally
 * identical to the ones declared in this file, so no conversion is
 * needed. `maxTokens` is an optional field on the real function's
 * options that this blueprint's `DigestBackend` interface has no slot
 * for; it is simply left unset, matching the real case block’s call
 * (which also never passes it).
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealDigestBackend(db).
 */
export function createRealDigestBackend(db: Database): DigestBackend {
  return {
    async generateDigest(options): Promise<DigestReport> {
      return await generateDigest(db, {
        days: options.days,
        project: options.project,
        synthesize: options.synthesize,
        model: options.model,
      });
    },
  };
}

export class DigestCommand extends BaseCommand<DigestReport> {
  constructor(private readonly backend: DigestBackend = simulateBackend) {
    super();
  }

  name = "digest";
  summary = "Show work digest for a time window";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    {
      flag: "--days",
      type: "number",
      default: "7",
      description: "lookback window in days",
    },
    {
      flag: "--project",
      type: "string",
      description: "filter to a specific project",
    },
    {
      flag: "--synthesize",
      type: "boolean",
      description: "generate narrative summary via Ollama",
    },
    {
      flag: "--model",
      type: "string",
      description: "Ollama model for synthesis (requires --synthesize)",
    },
  ];
  output = {
    description: "prints a work summary grouped by project, with optional LLM narrative",
    jsonShape:
      "{ period: { from: string, to: string, days: number }, totalSessions: number, totalMessages: number, totalTokens: number, estimatedCost: number, byProject: DigestProject[], topErrors: Array<{ message: string, count: number }>, synthesis?: string }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti digest",
      description: "show digest for the last 7 days across all projects",
    },
    {
      command: "smriti digest --days 14 --project myapp",
      description: "digest for myapp over the last 2 weeks",
    },
    {
      command: "smriti digest --synthesize --model mistral",
      description: "digest with LLM narrative using mistral model",
    },
  ];
  detailedSummary =
    "Generates a structured summary of AI-assisted work over a time window, aggregated by project. " +
    "Shows session counts, token usage, file changes, git operations, and error rates. " +
    "--synthesize optionally generates a narrative via Ollama (best-effort; skipped if Ollama unavailable).";

  protected async execute(
    parsed: ParsedArgs,
    _ctx: CommandContext
  ): Promise<DigestReport> {
    const days = parsed.flags["--days"]
      ? Number(parsed.flags["--days"])
      : 7;
    const project = parsed.flags["--project"] as string | undefined;
    const synthesize = parsed.flags["--synthesize"] === true;
    const model = parsed.flags["--model"] as string | undefined;

    return await this.backend.generateDigest({
      days,
      project,
      synthesize,
      model,
    });
  }
}
