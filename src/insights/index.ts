/**
 * insights/index.ts - Query functions for sidecar data analysis
 *
 * Surfaces patterns from tool usage, costs, errors, file operations,
 * and git operations to help optimize AI-assisted development workflows.
 */

import type { Database } from "bun:sqlite";

// =============================================================================
// Types
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
// Dashboard Overview
// =============================================================================

export function getOverview(db: Database): OverviewReport {
  const totalSessions = (db.prepare(`SELECT COUNT(*) as n FROM memory_sessions`).get() as any).n;
  const totalMessages = (db.prepare(`SELECT COUNT(*) as n FROM memory_messages`).get() as any).n;
  const totalCost = (db.prepare(`SELECT COALESCE(SUM(estimated_cost_usd), 0) as n FROM smriti_session_costs`).get() as any).n;

  const costByModel = db.prepare(`
    SELECT model, SUM(estimated_cost_usd) as cost, SUM(turn_count) as turns
    FROM smriti_session_costs
    GROUP BY model
    ORDER BY cost DESC
  `).all() as Array<{ model: string; cost: number; turns: number }>;

  const topProjects = db.prepare(`
    SELECT sm.project_id as project, SUM(sc.estimated_cost_usd) as cost, COUNT(DISTINCT sc.session_id) as sessions
    FROM smriti_session_costs sc
    JOIN smriti_session_meta sm ON sc.session_id = sm.session_id
    WHERE sm.project_id IS NOT NULL
    GROUP BY sm.project_id
    ORDER BY cost DESC
    LIMIT 5
  `).all() as Array<{ project: string; cost: number; sessions: number }>;

  const topFailingTools = db.prepare(`
    SELECT tool_name as tool,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
      COUNT(*) as total,
      CAST(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as rate
    FROM smriti_tool_usage
    GROUP BY tool_name
    HAVING failures > 0
    ORDER BY failures DESC
    LIMIT 5
  `).all() as Array<{ tool: string; failures: number; total: number; rate: number }>;

  const errorHotspots = db.prepare(`
    SELECT e.session_id as sessionId, COALESCE(ms.title, e.session_id) as title, COUNT(*) as errorCount
    FROM smriti_errors e
    LEFT JOIN memory_sessions ms ON e.session_id = ms.id
    GROUP BY e.session_id
    ORDER BY errorCount DESC
    LIMIT 5
  `).all() as Array<{ sessionId: string; title: string; errorCount: number }>;

  return { totalSessions, totalMessages, totalCost, costByModel, topProjects, topFailingTools, errorHotspots };
}

// =============================================================================
// Session Deep Dive
// =============================================================================

export function getSessionInsights(db: Database, sessionId: string): SessionReport | null {
  const session = db.prepare(`SELECT id, title, created_at FROM memory_sessions WHERE id = ?`).get(sessionId) as any;
  if (!session) return null;

  const costByModel = db.prepare(`
    SELECT model, estimated_cost_usd as cost, total_input_tokens as inputTokens,
      total_output_tokens as outputTokens, total_cache_tokens as cacheTokens, turn_count as turns
    FROM smriti_session_costs WHERE session_id = ?
    ORDER BY cost DESC
  `).all(sessionId) as SessionReport["costByModel"];

  const totalCost = costByModel.reduce((sum, r) => sum + r.cost, 0);

  const tools = db.prepare(`
    SELECT tool_name as name, COUNT(*) as count,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
    FROM smriti_tool_usage WHERE session_id = ?
    GROUP BY tool_name ORDER BY count DESC
  `).all(sessionId) as SessionReport["tools"];

  const errors = db.prepare(`
    SELECT error_type as type, message, COUNT(*) as count
    FROM smriti_errors WHERE session_id = ?
    GROUP BY error_type, message ORDER BY count DESC
  `).all(sessionId) as SessionReport["errors"];

  const commands = db.prepare(`
    SELECT command, exit_code as exitCode, is_git as isGit
    FROM smriti_commands WHERE session_id = ?
    ORDER BY created_at
  `).all(sessionId) as SessionReport["commands"];

  const fileOps = db.prepare(`
    SELECT file_path as path,
      SUM(CASE WHEN operation = 'read' THEN 1 ELSE 0 END) as reads,
      SUM(CASE WHEN operation = 'edit' THEN 1 ELSE 0 END) as edits,
      SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END) as writes
    FROM smriti_file_operations WHERE session_id = ?
    GROUP BY file_path ORDER BY (reads + edits + writes) DESC
  `).all(sessionId) as SessionReport["fileOps"];

  const gitOps = db.prepare(`
    SELECT operation, branch, pr_url as prUrl, details
    FROM smriti_git_operations WHERE session_id = ?
    ORDER BY created_at
  `).all(sessionId) as SessionReport["gitOps"];

  return {
    sessionId: session.id,
    title: session.title || "(untitled)",
    createdAt: session.created_at,
    costByModel,
    totalCost,
    tools,
    errors,
    commands,
    fileOps,
    gitOps,
  };
}

// =============================================================================
// Project Analysis
// =============================================================================

export function getProjectInsights(db: Database, projectId: string): ProjectReport | null {
  const sessionCount = (db.prepare(`
    SELECT COUNT(*) as n FROM smriti_session_meta WHERE project_id = ?
  `).get(projectId) as any)?.n;
  if (!sessionCount) return null;

  const totalCost = (db.prepare(`
    SELECT COALESCE(SUM(sc.estimated_cost_usd), 0) as n
    FROM smriti_session_costs sc
    JOIN smriti_session_meta sm ON sc.session_id = sm.session_id
    WHERE sm.project_id = ?
  `).get(projectId) as any).n;

  const errorCount = (db.prepare(`
    SELECT COUNT(*) as n FROM smriti_errors e
    JOIN smriti_session_meta sm ON e.session_id = sm.session_id
    WHERE sm.project_id = ?
  `).get(projectId) as any).n;

  const toolDistribution = db.prepare(`
    SELECT tu.tool_name as tool, COUNT(*) as count
    FROM smriti_tool_usage tu
    JOIN smriti_session_meta sm ON tu.session_id = sm.session_id
    WHERE sm.project_id = ?
    GROUP BY tu.tool_name ORDER BY count DESC
    LIMIT 10
  `).all(projectId) as Array<{ tool: string; count: number }>;

  const mostAccessedFiles = db.prepare(`
    SELECT fo.file_path as path, COUNT(*) as count
    FROM smriti_file_operations fo
    JOIN smriti_session_meta sm ON fo.session_id = sm.session_id
    WHERE sm.project_id = ? AND fo.operation = 'read'
    GROUP BY fo.file_path ORDER BY count DESC
    LIMIT 10
  `).all(projectId) as Array<{ path: string; count: number }>;

  const mostEditedFiles = db.prepare(`
    SELECT fo.file_path as path, COUNT(*) as count
    FROM smriti_file_operations fo
    JOIN smriti_session_meta sm ON fo.session_id = sm.session_id
    WHERE sm.project_id = ? AND fo.operation IN ('edit', 'write')
    GROUP BY fo.file_path ORDER BY count DESC
    LIMIT 10
  `).all(projectId) as Array<{ path: string; count: number }>;

  // Build/test failure rate: commands with "test" or "build" that failed
  const buildTestTotal = (db.prepare(`
    SELECT COUNT(*) as n FROM smriti_commands c
    JOIN smriti_session_meta sm ON c.session_id = sm.session_id
    WHERE sm.project_id = ? AND (c.command LIKE '%test%' OR c.command LIKE '%build%')
  `).get(projectId) as any).n;

  const buildTestFails = buildTestTotal > 0
    ? (db.prepare(`
        SELECT COUNT(*) as n FROM smriti_commands c
        JOIN smriti_session_meta sm ON c.session_id = sm.session_id
        WHERE sm.project_id = ? AND (c.command LIKE '%test%' OR c.command LIKE '%build%') AND c.exit_code != 0
      `).get(projectId) as any).n
    : 0;

  return {
    projectId,
    sessionCount,
    totalCost,
    avgCostPerSession: sessionCount > 0 ? totalCost / sessionCount : 0,
    errorRate: sessionCount > 0 ? errorCount / sessionCount : 0,
    toolDistribution,
    mostAccessedFiles,
    mostEditedFiles,
    buildTestFailRate: buildTestTotal > 0 ? buildTestFails / buildTestTotal : 0,
  };
}

// =============================================================================
// Cost Breakdown
// =============================================================================

export function getCostBreakdown(db: Database, options?: { days?: number }): CostReport {
  const dayFilter = options?.days
    ? `WHERE ms.created_at >= datetime('now', '-${options.days} days')`
    : "";

  const totalCost = (db.prepare(`
    SELECT COALESCE(SUM(sc.estimated_cost_usd), 0) as n
    FROM smriti_session_costs sc
    ${options?.days ? `JOIN memory_sessions ms ON sc.session_id = ms.id ${dayFilter}` : ""}
  `).get() as any).n;

  const byModel = db.prepare(`
    SELECT sc.model, SUM(sc.estimated_cost_usd) as cost,
      SUM(sc.total_input_tokens) as inputTokens,
      SUM(sc.total_output_tokens) as outputTokens,
      SUM(sc.total_cache_tokens) as cacheTokens,
      SUM(sc.turn_count) as turns
    FROM smriti_session_costs sc
    ${options?.days ? `JOIN memory_sessions ms ON sc.session_id = ms.id ${dayFilter}` : ""}
    GROUP BY sc.model ORDER BY cost DESC
  `).all() as CostReport["byModel"];

  const byProject = db.prepare(`
    SELECT sm.project_id as project, SUM(sc.estimated_cost_usd) as cost,
      COUNT(DISTINCT sc.session_id) as sessions
    FROM smriti_session_costs sc
    JOIN smriti_session_meta sm ON sc.session_id = sm.session_id
    ${options?.days ? `JOIN memory_sessions ms ON sc.session_id = ms.id ${dayFilter}` : ""}
    WHERE sm.project_id IS NOT NULL
    GROUP BY sm.project_id ORDER BY cost DESC
  `).all() as CostReport["byProject"];

  const byDay = db.prepare(`
    SELECT DATE(ms.created_at) as date, SUM(sc.estimated_cost_usd) as cost,
      COUNT(DISTINCT sc.session_id) as sessions
    FROM smriti_session_costs sc
    JOIN memory_sessions ms ON sc.session_id = ms.id
    ${dayFilter}
    GROUP BY DATE(ms.created_at) ORDER BY date DESC
    LIMIT 30
  `).all() as CostReport["byDay"];

  return { totalCost, byModel, byProject, byDay };
}

// =============================================================================
// Error Analysis
// =============================================================================

export function getErrorAnalysis(db: Database, options?: { project?: string }): ErrorReport {
  const projectJoin = options?.project
    ? `JOIN smriti_session_meta sm ON e.session_id = sm.session_id`
    : "";
  const projectWhere = options?.project ? `WHERE sm.project_id = ?` : "";
  const params = options?.project ? [options.project] : [];

  const totalErrors = (db.prepare(`
    SELECT COUNT(*) as n FROM smriti_errors e ${projectJoin} ${projectWhere}
  `).get(...params) as any).n;

  const byType = db.prepare(`
    SELECT e.error_type as type, COUNT(*) as count
    FROM smriti_errors e ${projectJoin} ${projectWhere}
    GROUP BY e.error_type ORDER BY count DESC
  `).all(...params) as ErrorReport["byType"];

  const bySession = db.prepare(`
    SELECT e.session_id as sessionId, COALESCE(ms.title, e.session_id) as title, COUNT(*) as count
    FROM smriti_errors e
    LEFT JOIN memory_sessions ms ON e.session_id = ms.id
    ${options?.project ? `JOIN smriti_session_meta sm ON e.session_id = sm.session_id WHERE sm.project_id = ?` : ""}
    GROUP BY e.session_id ORDER BY count DESC
    LIMIT 10
  `).all(...params) as ErrorReport["bySession"];

  const recentErrors = db.prepare(`
    SELECT e.error_type as type, e.message, e.session_id as sessionId, e.created_at as createdAt
    FROM smriti_errors e ${projectJoin} ${projectWhere}
    ORDER BY e.created_at DESC
    LIMIT 20
  `).all(...params) as ErrorReport["recentErrors"];

  return { totalErrors, byType, bySession, recentErrors };
}

// =============================================================================
// Tool Reliability
// =============================================================================

export function getToolStats(db: Database, options?: { project?: string }): ToolReport {
  const projectJoin = options?.project
    ? `JOIN smriti_session_meta sm ON tu.session_id = sm.session_id`
    : "";
  const projectWhere = options?.project ? `WHERE sm.project_id = ?` : "";
  const params = options?.project ? [options.project] : [];

  const totalCalls = (db.prepare(`
    SELECT COUNT(*) as n FROM smriti_tool_usage tu ${projectJoin} ${projectWhere}
  `).get(...params) as any).n;

  const tools = db.prepare(`
    SELECT tu.tool_name as name, COUNT(*) as count,
      SUM(CASE WHEN tu.success = 1 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN tu.success = 0 THEN 1 ELSE 0 END) as failures,
      CAST(SUM(CASE WHEN tu.success = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as rate,
      AVG(tu.duration_ms) as avgDurationMs
    FROM smriti_tool_usage tu ${projectJoin} ${projectWhere}
    GROUP BY tu.tool_name ORDER BY count DESC
  `).all(...params) as ToolReport["tools"];

  return { totalCalls, tools };
}

// =============================================================================
// Recommendations
// =============================================================================

export function getRecommendations(db: Database): Recommendation[] {
  const recs: Recommendation[] = [];

  // Long sessions (> 200 turns)
  const longSessions = db.prepare(`
    SELECT sc.session_id, SUM(sc.turn_count) as turns
    FROM smriti_session_costs sc
    GROUP BY sc.session_id
    HAVING turns > 200
  `).all() as Array<{ session_id: string; turns: number }>;
  if (longSessions.length > 0) {
    recs.push({
      severity: "medium",
      message: `${longSessions.length} session(s) exceed 200 turns`,
      detail: "Consider splitting long sessions. Context quality degrades after ~200 turns and costs increase due to growing cache.",
    });
  }

  // Exploration-heavy sessions (Read/Glob/Grep > 50% of tool calls)
  const explorationHeavy = db.prepare(`
    SELECT session_id,
      SUM(CASE WHEN tool_name IN ('Read', 'Glob', 'Grep', 'LS') THEN 1 ELSE 0 END) as explore_calls,
      COUNT(*) as total_calls
    FROM smriti_tool_usage
    GROUP BY session_id
    HAVING total_calls > 20 AND CAST(explore_calls AS REAL) / total_calls > 0.5
  `).all() as Array<{ session_id: string; explore_calls: number; total_calls: number }>;
  if (explorationHeavy.length > 0) {
    recs.push({
      severity: "high",
      message: `${explorationHeavy.length} session(s) are exploration-heavy (>50% read ops)`,
      detail: "Use /explore (Haiku) for codebase research before implementation. Haiku is 19x cheaper than Opus for exploration.",
    });
  }

  // Missing tools (exit code 127)
  const missingTools = db.prepare(`
    SELECT command, COUNT(*) as count
    FROM smriti_commands
    WHERE exit_code = 127
    GROUP BY command
    HAVING count > 2
  `).all() as Array<{ command: string; count: number }>;
  if (missingTools.length > 0) {
    const tools = missingTools.map((t) => t.command.split(" ")[0]).join(", ");
    recs.push({
      severity: "medium",
      message: `Missing tools detected: ${tools}`,
      detail: "Commands returned exit code 127 (not found). Install the missing tools or update your PATH.",
    });
  }

  // Knowledge bottleneck files (read > 10 times)
  const bottlenecks = db.prepare(`
    SELECT file_path as path, COUNT(*) as count
    FROM smriti_file_operations
    WHERE operation = 'read'
    GROUP BY file_path
    HAVING count > 10
    ORDER BY count DESC
    LIMIT 5
  `).all() as Array<{ path: string; count: number }>;
  if (bottlenecks.length > 0) {
    const files = bottlenecks.map((b) => `${b.path} (${b.count}x)`).join(", ");
    recs.push({
      severity: "low",
      message: "Knowledge bottleneck files detected",
      detail: `These files are read repeatedly: ${files}. Consider adding summaries to CLAUDE.md to reduce redundant reads.`,
    });
  }

  // High tool failure rate
  const failingTools = db.prepare(`
    SELECT tool_name, COUNT(*) as total,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
    FROM smriti_tool_usage
    GROUP BY tool_name
    HAVING total > 10 AND CAST(failures AS REAL) / total > 0.3
  `).all() as Array<{ tool_name: string; total: number; failures: number }>;
  if (failingTools.length > 0) {
    const tools = failingTools.map((t) => `${t.tool_name} (${((t.failures / t.total) * 100).toFixed(0)}% fail)`).join(", ");
    recs.push({
      severity: "medium",
      message: "Tools with high failure rates",
      detail: `${tools}. Investigate why these tools are failing frequently.`,
    });
  }

  return recs;
}
