/**
 * Real implementation of `insights` on the new blueprint (see the
 * `insights` case in ../index.ts, and its helpers in ../insights/index.ts /
 * ../insights/format.ts, which this mirrors field-for-field). Blueprint
 * only: nothing here is wired into index.ts, and no subcommand touches the
 * real DB - each report-producing call is injected via the constructor,
 * defaulting to a safe simulated implementation.
 *
 * Shape: like `daemon`, NOT like `config` - bare `insights` is a distinct
 * "dashboard" mode (getOverview + getRecommendations), not a delegated
 * alias for one of the five subcommands (session/project/costs/errors/tools).
 * ../index.ts's `else { ... }` branch is that dashboard, reached from
 * inside the `if (sub === "session") ... else if (...) ... else { ... }`
 * chain - not a separate no-args special case, so it's modeled here the
 * same way `daemon`'s foreground mode is: this class's own execute().
 *
 * ../index.ts dispatches on `sub` with a plain if/else-if chain, so ANY
 * unrecognized `sub` (not just an absent one, e.g. `smriti insights bogus`)
 * silently falls through to the dashboard `else` branch. Modeled via
 * `unmatchedSubcommandFallsThrough = true` (see subcommand.ts) - added
 * there after this command (and `categories`, independently) both hit the
 * same real pattern - so this is now faithfully reproduced.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, CommandError, type ParsedArgs } from "../command";
import { BaseSubcommandCommand } from "../subcommand";
import type { ArgSpec, FlagSpec, Example, OutputSpec } from "../help/types";
import {
  getOverview as realGetOverview,
  getSessionInsights as realGetSessionInsights,
  getProjectInsights as realGetProjectInsights,
  getCostBreakdown as realGetCostBreakdown,
  getErrorAnalysis as realGetErrorAnalysis,
  getToolStats as realGetToolStats,
  getRecommendations as realGetRecommendations,
} from "../insights/index";

const NO_ARGS: ArgSpec[] = [];
const JSON_FLAG: FlagSpec = { flag: "--json", type: "boolean", description: "output as JSON instead of formatted text" };

// =============================================================================
// Shared report shapes (mirrors ../insights/index.ts's exported interfaces)
// =============================================================================

export interface OverviewReport {
  totalSessions: number;
  totalMessages: number;
  totalCost: number;
  costByModel: Array<{ model: string; cost: number; turns: number }>;
  topProjects: Array<{ project: string; cost: number; sessions: number }>;
  topFailingTools: Array<{ tool: string; failures: number; total: number; rate: number }>;
  errorHotspots: Array<{ sessionId: string; title: string; errorCount: number }>;
}

export interface SessionReport {
  sessionId: string;
  title: string;
  createdAt: string;
  costByModel: Array<{ model: string; cost: number; inputTokens: number; outputTokens: number; cacheTokens: number; turns: number }>;
  totalCost: number;
  tools: Array<{ name: string; count: number; successes: number; failures: number }>;
  errors: Array<{ type: string; message: string; count: number }>;
  commands: Array<{ command: string; exitCode: number | null; isGit: boolean }>;
  fileOps: Array<{ path: string; reads: number; edits: number; writes: number }>;
  gitOps: Array<{ operation: string; branch: string | null; prUrl: string | null; details: string | null }>;
}

export interface ProjectReport {
  projectId: string;
  sessionCount: number;
  totalCost: number;
  avgCostPerSession: number;
  errorRate: number;
  toolDistribution: Array<{ tool: string; count: number }>;
  mostAccessedFiles: Array<{ path: string; count: number }>;
  mostEditedFiles: Array<{ path: string; count: number }>;
  buildTestFailRate: number;
}

export interface CostReport {
  totalCost: number;
  byModel: Array<{ model: string; cost: number; inputTokens: number; outputTokens: number; cacheTokens: number; turns: number }>;
  byProject: Array<{ project: string; cost: number; sessions: number }>;
  byDay: Array<{ date: string; cost: number; sessions: number }>;
}

export interface ErrorReport {
  totalErrors: number;
  byType: Array<{ type: string; count: number }>;
  bySession: Array<{ sessionId: string; title: string; count: number }>;
  recentErrors: Array<{ type: string; message: string; sessionId: string; createdAt: string }>;
}

export interface ToolReport {
  totalCalls: number;
  tools: Array<{ name: string; count: number; successes: number; failures: number; rate: number; avgDurationMs: number | null }>;
}

export interface Recommendation {
  severity: "high" | "medium" | "low";
  message: string;
  detail: string;
}

// =============================================================================
// session
// =============================================================================

async function simulateGetSessionInsights(sessionId: string): Promise<SessionReport | null> {
  if (sessionId !== "sess-001") return null; // simulate "not found" for anything but the demo id
  return {
    sessionId: "sess-001",
    title: "Refactor auth middleware",
    createdAt: "2026-07-28T10:15:00Z",
    costByModel: [
      { model: "claude-sonnet-4-5", cost: 1.42, inputTokens: 82000, outputTokens: 6100, cacheTokens: 41000, turns: 34 },
    ],
    totalCost: 1.42,
    tools: [
      { name: "Read", count: 22, successes: 22, failures: 0 },
      { name: "Edit", count: 9, successes: 8, failures: 1 },
    ],
    errors: [{ type: "TypeError", message: "Cannot read properties of undefined", count: 1 }],
    commands: [{ command: "bun test", exitCode: 0, isGit: false }],
    fileOps: [{ path: "src/auth/middleware.ts", reads: 5, edits: 3, writes: 0 }],
    gitOps: [{ operation: "commit", branch: "main", prUrl: null, details: "fix(auth): refactor middleware" }],
  };
}

export class InsightsSessionCommand extends BaseCommand<SessionReport> {
  constructor(private readonly getSessionInsights: (sessionId: string) => Promise<SessionReport | null> = simulateGetSessionInsights) {
    super();
  }

  name = "session";
  summary = "Deep-dive report for one session";
  args: ArgSpec[] = [{ name: "session-id", type: "string", required: true, description: "session to report on" }];
  flags: FlagSpec[] = [JSON_FLAG];
  output: OutputSpec = {
    description: "prints cost, tool usage, errors, file ops, git ops, and commands for the session",
    jsonShape: "{ sessionId, title, createdAt, costByModel[], totalCost, tools[], errors[], commands[], fileOps[], gitOps[] }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti insights session sess-001", description: "formatted report for one session" },
    { command: "smriti insights session sess-001 --json", description: "machine-readable report" },
    { command: "smriti insights session bogus-id", description: "fails with NOT_FOUND - no such session" },
  ];
  detailedSummary =
    "Per-session breakdown: cost by model, tool call success/failure counts, error occurrences, " +
    "file read/edit/write counts, git operations, and the commands run during the session.";

  protected async execute(parsed: ParsedArgs): Promise<SessionReport> {
    const sessionId = parsed.positionals[0];
    const report = await this.getSessionInsights(sessionId);
    if (!report) {
      throw new CommandError(`Session not found: ${sessionId}`, "NOT_FOUND", { sessionId });
    }
    return report;
  }
}

/**
 * Real backend - wires directly to insights/index.ts's getSessionInsights(db, sessionId).
 * Mirrors ../index.ts's case "insights" -> sub === "session" branch exactly: `getSessionInsights(db, id)`
 * (synchronous, returns SessionReport | null). The null -> NOT_FOUND translation lives in this
 * class's own execute() already, unchanged. Not wired into any default - callers opt in explicitly
 * via createRealInsightsSessionBackend(db).
 */
export function createRealInsightsSessionBackend(db: Database): (sessionId: string) => Promise<SessionReport | null> {
  return async (sessionId) => realGetSessionInsights(db, sessionId);
}

// =============================================================================
// project
// =============================================================================

async function simulateGetProjectInsights(projectId: string): Promise<ProjectReport | null> {
  if (projectId !== "demo-project") return null; // simulate "not found or has no data"
  return {
    projectId: "demo-project",
    sessionCount: 12,
    totalCost: 18.34,
    avgCostPerSession: 1.53,
    errorRate: 0.25,
    toolDistribution: [
      { tool: "Read", count: 140 },
      { tool: "Edit", count: 61 },
    ],
    mostAccessedFiles: [{ path: "src/index.ts", count: 24 }],
    mostEditedFiles: [{ path: "src/commands/insights.ts", count: 9 }],
    buildTestFailRate: 0.1,
  };
}


export class InsightsProjectCommand extends BaseCommand<ProjectReport> {
  constructor(private readonly getProjectInsights: (projectId: string) => Promise<ProjectReport | null> = simulateGetProjectInsights) {
    super();
  }

  name = "project";
  summary = "Aggregate report across all sessions in a project";
  args: ArgSpec[] = [{ name: "project-id", type: "string", required: true, description: "project to report on" }];
  flags: FlagSpec[] = [JSON_FLAG];
  output: OutputSpec = {
    description: "prints cost, error rate, tool distribution, and file hotspots for the project",
    jsonShape: "{ projectId, sessionCount, totalCost, avgCostPerSession, errorRate, toolDistribution[], mostAccessedFiles[], mostEditedFiles[], buildTestFailRate }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti insights project demo-project", description: "formatted report for one project" },
    { command: "smriti insights project demo-project --json", description: "machine-readable report" },
    { command: "smriti insights project unknown-project", description: "fails with NOT_FOUND - no such project, or it has no data" },
  ];
  detailedSummary =
    "Project-wide rollup: total/average cost, error rate per session, tool call distribution, " +
    "the most-read files (knowledge bottlenecks), the most-edited files (churn hotspots), and the build/test failure rate.";

  protected async execute(parsed: ParsedArgs): Promise<ProjectReport> {
    const projectId = parsed.positionals[0];
    const report = await this.getProjectInsights(projectId);
    if (!report) {
      throw new CommandError(`Project not found or has no data: ${projectId}`, "NOT_FOUND", { projectId });
    }
    return report;
  }
}

/**
 * Real backend - wires directly to insights/index.ts's getProjectInsights(db, projectId).
 * Mirrors ../index.ts's case "insights" -> sub === "project" branch exactly: `getProjectInsights(db, id)`
 * (synchronous, returns ProjectReport | null). Not wired into any default - callers opt in
 * explicitly via createRealInsightsProjectBackend(db).
 */
export function createRealInsightsProjectBackend(db: Database): (projectId: string) => Promise<ProjectReport | null> {
  return async (projectId) => realGetProjectInsights(db, projectId);
}

// =============================================================================
// costs
// =============================================================================

async function simulateGetCostBreakdown(_opts: { days?: number }): Promise<CostReport> {
  return {
    totalCost: 42.17,
    byModel: [{ model: "claude-sonnet-4-5", cost: 42.17, inputTokens: 1200000, outputTokens: 88000, cacheTokens: 600000, turns: 410 }],
    byProject: [{ project: "demo-project", cost: 18.34, sessions: 12 }],
    byDay: [{ date: "2026-08-04", cost: 3.21, sessions: 2 }],
  };
}


export class InsightsCostsCommand extends BaseCommand<CostReport> {
  constructor(private readonly getCostBreakdown: (opts: { days?: number }) => Promise<CostReport> = simulateGetCostBreakdown) {
    super();
  }

  name = "costs";
  summary = "Cost breakdown by model, project, and day";
  args = NO_ARGS;
  flags: FlagSpec[] = [
    { flag: "--days", type: "number", description: "only include sessions from the last N days" },
    JSON_FLAG,
  ];
  output: OutputSpec = {
    description: "prints total cost broken down by model, project, and day",
    jsonShape: "{ totalCost, byModel[], byProject[], byDay[] }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti insights costs", description: "all-time cost breakdown" },
    { command: "smriti insights costs --days 7", description: "cost breakdown for the last 7 days" },
    { command: "smriti insights costs --json", description: "machine-readable breakdown" },
  ];
  detailedSummary =
    "All-time by default; --days N filters to sessions created in the last N days. " +
    "Faithful to the real CLI: --days 0 (or anything that doesn't parse to a truthy number) is treated the same as omitting --days.";

  protected async execute(parsed: ParsedArgs): Promise<CostReport> {
    // Mirrors ../index.ts exactly: `Number(getArg(args, "--days")) || undefined`
    // - a falsy result (missing, non-numeric, or literally 0) means "no filter".
    const days = Number(parsed.flags["--days"]) || undefined;
    return this.getCostBreakdown({ days });
  }
}

/**
 * Real backend - wires directly to insights/index.ts's getCostBreakdown(db, options).
 * Mirrors ../index.ts's case "insights" -> sub === "costs" branch exactly:
 * `getCostBreakdown(db, { days })` (synchronous). `days` filtering (falsy -> "no filter") is
 * already handled upstream in this class's own execute(); the factory just forwards whatever
 * options object it's given. Not wired into any default - callers opt in explicitly via
 * createRealInsightsCostsBackend(db).
 */
export function createRealInsightsCostsBackend(db: Database): (opts: { days?: number }) => Promise<CostReport> {
  return async (opts) => realGetCostBreakdown(db, opts);
}

// =============================================================================
// errors
// =============================================================================

async function simulateGetErrorAnalysis(_opts: { project?: string }): Promise<ErrorReport> {
  return {
    totalErrors: 3,
    byType: [{ type: "TypeError", count: 2 }, { type: "NetworkError", count: 1 }],
    bySession: [{ sessionId: "sess-001", title: "Refactor auth middleware", count: 2 }],
    recentErrors: [
      { type: "TypeError", message: "Cannot read properties of undefined", sessionId: "sess-001", createdAt: "2026-07-28T10:20:00Z" },
    ],
  };
}


export class InsightsErrorsCommand extends BaseCommand<ErrorReport> {
  constructor(private readonly getErrorAnalysis: (opts: { project?: string }) => Promise<ErrorReport> = simulateGetErrorAnalysis) {
    super();
  }

  name = "errors";
  summary = "Error frequency by type, session, and recency";
  args = NO_ARGS;
  flags: FlagSpec[] = [
    { flag: "--project", type: "string", description: "filter to one project" },
    JSON_FLAG,
  ];
  output: OutputSpec = {
    description: "prints total error count, grouped by type and by session, plus the 10 most recent",
    jsonShape: "{ totalErrors, byType[], bySession[], recentErrors[] }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti insights errors", description: "error analysis across all sessions" },
    { command: "smriti insights errors --project demo-project", description: "scoped to one project" },
    { command: "smriti insights errors --json", description: "machine-readable analysis" },
  ];
  detailedSummary =
    "Never fails on empty data - an all-zero report (totalErrors: 0, empty arrays) is a valid, " +
    "successful result when nothing has gone wrong.";

  protected async execute(parsed: ParsedArgs): Promise<ErrorReport> {
    const project = parsed.flags["--project"] as string | undefined;
    return this.getErrorAnalysis({ project });
  }
}

/**
 * Real backend - wires directly to insights/index.ts's getErrorAnalysis(db, options).
 * Mirrors ../index.ts's case "insights" -> sub === "errors" branch exactly:
 * `getErrorAnalysis(db, { project })` (synchronous). Not wired into any default - callers
 * opt in explicitly via createRealInsightsErrorsBackend(db).
 */
export function createRealInsightsErrorsBackend(db: Database): (opts: { project?: string }) => Promise<ErrorReport> {
  return async (opts) => realGetErrorAnalysis(db, opts);
}

// =============================================================================
// tools
// =============================================================================

async function simulateGetToolStats(_opts: { project?: string }): Promise<ToolReport> {
  return {
    totalCalls: 231,
    tools: [
      { name: "Read", count: 140, successes: 140, failures: 0, rate: 0, avgDurationMs: 12 },
      { name: "Edit", count: 61, successes: 58, failures: 3, rate: 0.049, avgDurationMs: 44 },
    ],
  };
}


export class InsightsToolsCommand extends BaseCommand<ToolReport> {
  constructor(private readonly getToolStats: (opts: { project?: string }) => Promise<ToolReport> = simulateGetToolStats) {
    super();
  }

  name = "tools";
  summary = "Tool call reliability - success/failure rate and latency";
  args = NO_ARGS;
  flags: FlagSpec[] = [
    { flag: "--project", type: "string", description: "filter to one project" },
    JSON_FLAG,
  ];
  output: OutputSpec = {
    description: "prints call counts, success/failure counts, failure rate, and avg duration per tool",
    jsonShape: "{ totalCalls, tools: [{ name, count, successes, failures, rate, avgDurationMs }] }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti insights tools", description: "tool reliability across all sessions" },
    { command: "smriti insights tools --project demo-project", description: "scoped to one project" },
    { command: "smriti insights tools --json", description: "machine-readable stats" },
  ];
  detailedSummary =
    "Ordered by call count, most-used tool first. `rate` is failures/count (0 when a tool has never failed); " +
    "`avgDurationMs` is null when no duration data was recorded for a tool.";

  protected async execute(parsed: ParsedArgs): Promise<ToolReport> {
    const project = parsed.flags["--project"] as string | undefined;
    return this.getToolStats({ project });
  }
}

/**
 * Real backend - wires directly to insights/index.ts's getToolStats(db, options).
 * Mirrors ../index.ts's case "insights" -> sub === "tools" branch exactly:
 * `getToolStats(db, { project })` (synchronous). Not wired into any default - callers
 * opt in explicitly via createRealInsightsToolsBackend(db).
 */
export function createRealInsightsToolsBackend(db: Database): (opts: { project?: string }) => Promise<ToolReport> {
  return async (opts) => realGetToolStats(db, opts);
}

// =============================================================================
// insights (parent) - dashboard default mode + subcommand dispatch
// =============================================================================

export type DashboardResult = OverviewReport & { recommendations: Recommendation[] };

async function simulateGetOverview(): Promise<OverviewReport> {
  return {
    totalSessions: 47,
    totalMessages: 3120,
    totalCost: 42.17,
    costByModel: [{ model: "claude-sonnet-4-5", cost: 42.17, turns: 410 }],
    topProjects: [{ project: "demo-project", cost: 18.34, sessions: 12 }],
    topFailingTools: [{ tool: "Bash", failures: 4, total: 90, rate: 0.044 }],
    errorHotspots: [{ sessionId: "sess-001", title: "Refactor auth middleware", errorCount: 2 }],
  };
}

async function simulateGetRecommendations(): Promise<Recommendation[]> {
  return [
    {
      severity: "medium",
      message: "1 session(s) exceed 200 turns",
      detail: "Consider splitting long sessions. Context quality degrades after ~200 turns and costs increase due to growing cache.",
    },
  ];
}

/**
 * Real backend - wires directly to insights/index.ts's getOverview(db).
 * Mirrors ../index.ts's case "insights" default (dashboard) branch exactly: `getOverview(db)`
 * (synchronous). Paired with createRealInsightsRecommendationsBackend below since the parent
 * class's constructor takes the two report-producing functions as separate positional params,
 * not a single combined backend object. Not wired into any default - callers opt in explicitly
 * via createRealInsightsOverviewBackend(db).
 */
export function createRealInsightsOverviewBackend(db: Database): () => Promise<OverviewReport> {
  return async () => realGetOverview(db);
}

/**
 * Real backend - wires directly to insights/index.ts's getRecommendations(db).
 * Mirrors ../index.ts's case "insights" default (dashboard) branch exactly: `getRecommendations(db)`
 * (synchronous). See createRealInsightsOverviewBackend above for why this is a separate factory.
 * Not wired into any default - callers opt in explicitly via createRealInsightsRecommendationsBackend(db).
 */
export function createRealInsightsRecommendationsBackend(db: Database): () => Promise<Recommendation[]> {
  return async () => realGetRecommendations(db);
}

/**
 * `smriti insights` - real, non-throwaway implementation on the new
 * blueprint. No-subcommand ("dashboard") path is this class's own
 * execute(); every named subcommand is a fully independent BaseCommand
 * instance above.
 */
export class InsightsCommand extends BaseSubcommandCommand<DashboardResult> {
  /** Real CLI: any unrecognized sub falls through to the dashboard, not an error. See file header. */
  protected readonly unmatchedSubcommandFallsThrough = true;

  readonly subcommands: Readonly<Record<string, BaseCommand<unknown>>>;

  constructor(
    private readonly getOverview: () => Promise<OverviewReport> = simulateGetOverview,
    private readonly getRecommendations: () => Promise<Recommendation[]> = simulateGetRecommendations,
    subcommands?: {
      session?: InsightsSessionCommand;
      project?: InsightsProjectCommand;
      costs?: InsightsCostsCommand;
      errors?: InsightsErrorsCommand;
      tools?: InsightsToolsCommand;
    }
  ) {
    super();
    this.subcommands = {
      session: subcommands?.session ?? new InsightsSessionCommand(),
      project: subcommands?.project ?? new InsightsProjectCommand(),
      costs: subcommands?.costs ?? new InsightsCostsCommand(),
      errors: subcommands?.errors ?? new InsightsErrorsCommand(),
      tools: subcommands?.tools ?? new InsightsToolsCommand(),
    };
  }

  name = "insights";
  summary = "Analytics dashboard over sidecar-captured usage data";
  args = NO_ARGS;
  flags: FlagSpec[] = [JSON_FLAG];
  output: OutputSpec = {
    description: "with no subcommand, prints the full dashboard: overview stats plus recommendations",
    jsonShape: "OverviewReport & { recommendations: Recommendation[] }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti insights", description: "full dashboard: overview + recommendations" },
    { command: "smriti insights --json", description: "machine-readable dashboard" },
    { command: "smriti insights session sess-001", description: "drill into one session (see the `session` subcommand)" },
  ];
  detailedSummary =
    "Bare `insights` is a distinct mode (dashboard), not an alias for one of the five subcommands: " +
    "session (one session), project (one project), costs (cost breakdown), errors (error analysis), " +
    "tools (tool reliability). The dashboard combines a global overview with generated recommendations " +
    "(long sessions, exploration-heavy sessions, missing tools, knowledge bottleneck files, flaky tools).";

  // Only ever invoked for the no-subcommand ("dashboard") path -
  // BaseSubcommandCommand.run() dispatches a matched subcommand token
  // straight to that subcommand's own run() (which prints its own output),
  // never through this execute(). Safe to print unconditionally here, same
  // as `search`'s own execute() prints its own dual text/--json output.
  protected async execute(_parsed: ParsedArgs): Promise<DashboardResult> {
    const overview = await this.getOverview();
    const recommendations = await this.getRecommendations();
    const result: DashboardResult = { ...overview, recommendations };
    return result;
  }
}
