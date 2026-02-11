/**
 * context.ts - Generate project context for token reduction
 *
 * Queries sidecar tables and renders a compact markdown block
 * for `.smriti/CLAUDE.md`. Pure SQL → markdown, no Ollama needed.
 */

import type { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { DEFAULT_CONTEXT_DAYS, SMRITI_DIR } from "./config";

// =============================================================================
// Types
// =============================================================================

export type ContextOptions = {
  project?: string;
  days?: number;
  dryRun?: boolean;
  json?: boolean;
  cwd?: string;
};

export type ProjectContext = {
  sessions: Array<{
    id: string;
    title: string;
    updatedAt: string;
    turnCount: number | null;
    categories: string;
  }>;
  hotFiles: Array<{
    filePath: string;
    ops: number;
    lastOp: string;
    lastAt: string;
  }>;
  gitActivity: Array<{
    operation: string;
    branch: string | null;
    details: string | null;
    createdAt: string;
  }>;
  errors: Array<{
    errorType: string;
    count: number;
  }>;
  usage: {
    sessions: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
};

// =============================================================================
// Project Detection
// =============================================================================

/**
 * Detect project ID from current working directory.
 * Tries exact match first, then checks if the directory basename
 * matches a project ID (handles path derivation mismatches).
 */
export function detectProject(db: Database, cwd?: string): string | null {
  const dir = cwd || process.cwd();

  // Exact path match
  const exact = db
    .prepare(`SELECT id FROM smriti_projects WHERE path = ?`)
    .get(dir) as { id: string } | null;
  if (exact) return exact.id;

  // Fallback: match by directory basename as project ID
  const dirName = dir.split("/").pop();
  if (dirName) {
    const byName = db
      .prepare(`SELECT id FROM smriti_projects WHERE id = ?`)
      .get(dirName) as { id: string } | null;
    if (byName) return byName.id;
  }

  return null;
}

// =============================================================================
// Context Gathering
// =============================================================================

/**
 * Query sidecar tables for project context.
 * Each section is independent — empty tables produce empty arrays.
 */
export function gatherContext(
  db: Database,
  projectId: string,
  days: number = DEFAULT_CONTEXT_DAYS
): ProjectContext {
  const interval = `-${days} days`;

  // Recent sessions
  const sessions = db
    .prepare(
      `SELECT ms.id, ms.title, ms.updated_at, sc.turn_count,
              COALESCE(GROUP_CONCAT(DISTINCT st.category_id), '') AS categories
       FROM memory_sessions ms
       JOIN smriti_session_meta sm ON sm.session_id = ms.id
       LEFT JOIN smriti_session_costs sc ON sc.session_id = ms.id
       LEFT JOIN smriti_session_tags st ON st.session_id = ms.id
       WHERE sm.project_id = ? AND ms.updated_at >= datetime('now', ?)
       GROUP BY ms.id ORDER BY ms.updated_at DESC LIMIT 5`
    )
    .all(projectId, interval) as Array<{
      id: string;
      title: string;
      updated_at: string;
      turn_count: number | null;
      categories: string;
    }>;

  // Hot files
  const hotFiles = db
    .prepare(
      `SELECT file_path, COUNT(*) AS ops, MAX(operation) AS last_op, MAX(created_at) AS last_at
       FROM smriti_file_operations
       WHERE project_id = ? AND created_at >= datetime('now', ?)
       GROUP BY file_path ORDER BY ops DESC LIMIT 10`
    )
    .all(projectId, interval) as Array<{
      file_path: string;
      ops: number;
      last_op: string;
      last_at: string;
    }>;

  // Git activity
  const gitActivity = db
    .prepare(
      `SELECT go.operation, go.branch, go.details, go.created_at
       FROM smriti_git_operations go
       JOIN smriti_session_meta sm ON sm.session_id = go.session_id
       WHERE sm.project_id = ? AND go.created_at >= datetime('now', ?)
         AND go.operation IN ('commit','pr_create','push','merge','checkout')
       ORDER BY go.created_at DESC LIMIT 5`
    )
    .all(projectId, interval) as Array<{
      operation: string;
      branch: string | null;
      details: string | null;
      created_at: string;
    }>;

  // Recent errors
  const errors = db
    .prepare(
      `SELECT error_type, COUNT(*) AS count
       FROM smriti_errors e
       JOIN smriti_session_meta sm ON sm.session_id = e.session_id
       WHERE sm.project_id = ? AND e.created_at >= datetime('now', ?)
       GROUP BY error_type ORDER BY count DESC LIMIT 3`
    )
    .all(projectId, interval) as Array<{
      error_type: string;
      count: number;
    }>;

  // Cost summary (all-time for this project, not time-limited)
  const costRow = db
    .prepare(
      `SELECT COUNT(*) AS sessions, SUM(turn_count) AS turns,
              SUM(total_input_tokens) AS input_tok, SUM(total_output_tokens) AS output_tok
       FROM smriti_session_costs sc
       JOIN smriti_session_meta sm ON sm.session_id = sc.session_id
       WHERE sm.project_id = ?`
    )
    .get(projectId) as {
      sessions: number;
      turns: number | null;
      input_tok: number | null;
      output_tok: number | null;
    } | null;

  const usage =
    costRow && costRow.sessions > 0
      ? {
          sessions: costRow.sessions,
          turns: costRow.turns || 0,
          inputTokens: costRow.input_tok || 0,
          outputTokens: costRow.output_tok || 0,
        }
      : null;

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updated_at,
      turnCount: s.turn_count,
      categories: s.categories,
    })),
    hotFiles: hotFiles.map((f) => ({
      filePath: f.file_path,
      ops: f.ops,
      lastOp: f.last_op,
      lastAt: f.last_at,
    })),
    gitActivity: gitActivity.map((g) => ({
      operation: g.operation,
      branch: g.branch,
      details: g.details,
      createdAt: g.created_at,
    })),
    errors: errors.map((e) => ({
      errorType: e.error_type,
      count: e.count,
    })),
    usage,
  };
}

// =============================================================================
// Rendering
// =============================================================================

/** Format a relative time string from an ISO date */
function relativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return "1d ago";
  return `${diffDay}d ago`;
}

/** Format token count as human-readable */
function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Try to parse a commit message from git details JSON */
function parseGitDetails(details: string | null): string | null {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details);
    const msg = parsed.message || parsed.commit_message || null;
    // Skip shell syntax artifacts like heredoc markers
    if (msg && (msg.includes("$(cat") || msg.includes("<<"))) return null;
    return msg;
  } catch {
    if (details.includes("$(cat") || details.includes("<<")) return null;
    return details.length <= 60 ? details : null;
  }
}

/** Strip a project root prefix from file paths for readability */
function relativePath(filePath: string, projectPath?: string): string {
  // Try the provided project path
  if (projectPath && filePath.startsWith(projectPath)) {
    const rel = filePath.slice(projectPath.length);
    return rel.startsWith("/") ? rel.slice(1) : rel;
  }
  // Try cwd (handles path derivation mismatches)
  const cwd = process.cwd();
  if (filePath.startsWith(cwd + "/")) {
    return filePath.slice(cwd.length + 1);
  }
  // Fallback: strip home directory prefix
  const home = process.env.HOME || "";
  if (home && filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}

/**
 * Render ProjectContext into a compact markdown block.
 * Omits sections that are empty.
 */
export function renderContext(
  ctx: ProjectContext,
  projectId: string,
  days: number = DEFAULT_CONTEXT_DAYS,
  projectPath?: string
): string {
  const sections: string[] = [];
  const date = new Date().toISOString().slice(0, 10);

  sections.push(`## Project Context`);
  sections.push("");
  sections.push(
    `> Auto-generated by \`smriti context\` on ${date}. Do not edit manually.`
  );

  // Recent sessions
  if (ctx.sessions.length > 0) {
    sections.push("");
    sections.push(`### Recent Sessions (last ${days} days)`);
    for (const s of ctx.sessions) {
      const time = relativeTime(s.updatedAt);
      const title = s.title || s.id.slice(0, 8);
      const turns = s.turnCount ? ` (${s.turnCount} turns)` : "";
      const cats = s.categories
        ? ` [${s.categories.split(",")[0]}]`
        : "";
      sections.push(`- **${time}** ${title}${turns}${cats}`);
    }
  }

  // Hot files
  if (ctx.hotFiles.length > 0) {
    sections.push("");
    sections.push(`### Hot Files`);
    const fileList = ctx.hotFiles
      .map((f) => `\`${relativePath(f.filePath, projectPath)}\` (${f.ops} ops)`)
      .join(", ");
    sections.push(fileList);
  }

  // Git activity
  if (ctx.gitActivity.length > 0) {
    sections.push("");
    sections.push(`### Git Activity`);
    for (const g of ctx.gitActivity) {
      const date = g.createdAt.slice(0, 10);
      const msg = parseGitDetails(g.details);
      if (g.operation === "commit") {
        const branch = g.branch ? ` \`${g.branch}\`` : "";
        const detail = msg ? `: "${msg}"` : "";
        sections.push(`- commit${branch}${detail} (${date})`);
      } else if (g.operation === "pr_create") {
        const detail = msg ? `: "${msg}"` : "";
        sections.push(`- pr_create${detail} (${date})`);
      } else {
        const branch = g.branch ? ` \`${g.branch}\`` : "";
        sections.push(`- ${g.operation}${branch} (${date})`);
      }
    }
  }

  // Errors
  if (ctx.errors.length > 0) {
    sections.push("");
    sections.push(`### Recent Errors`);
    for (const e of ctx.errors) {
      const s = e.count === 1 ? "occurrence" : "occurrences";
      sections.push(`- ${e.errorType}: ${e.count} ${s}`);
    }
  }

  // Usage
  if (ctx.usage) {
    sections.push("");
    sections.push(`### Usage`);
    sections.push(
      `${ctx.usage.sessions} sessions, ${ctx.usage.turns} turns, ~${formatTokens(ctx.usage.inputTokens)} input / ~${formatTokens(ctx.usage.outputTokens)} output tokens`
    );
  }

  // Check if there's any content beyond the header
  const hasContent =
    ctx.sessions.length > 0 ||
    ctx.hotFiles.length > 0 ||
    ctx.gitActivity.length > 0 ||
    ctx.errors.length > 0 ||
    ctx.usage !== null;

  if (!hasContent) {
    return "";
  }

  return sections.join("\n");
}

// =============================================================================
// CLAUDE.md Splice Logic
// =============================================================================

/**
 * Splice a context block into an existing CLAUDE.md string.
 * Removes any existing `## Project Context` section.
 * Inserts new context after the header, before knowledge index sections.
 * Idempotent — running twice produces the same result.
 */
export function spliceContext(existing: string, contextBlock: string): string {
  const lines = existing.split("\n");
  const result: string[] = [];
  let inContextSection = false;
  let headerEndIndex = -1;

  // First pass: find where the header ends (first ## line that isn't Project Context)
  // and strip any existing Project Context section
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("## Project Context")) {
      inContextSection = true;
      continue;
    }

    if (inContextSection && line.startsWith("## ")) {
      inContextSection = false;
    }

    if (inContextSection) {
      continue;
    }

    result.push(line);
  }

  // Find insertion point: after header content, before first ## section
  let insertIdx = result.length;
  for (let i = 0; i < result.length; i++) {
    if (result[i].startsWith("## ")) {
      insertIdx = i;
      break;
    }
  }

  // Insert context block with surrounding newlines
  if (contextBlock) {
    const toInsert = [contextBlock, ""];
    // Ensure there's a blank line before the context block
    if (insertIdx > 0 && result[insertIdx - 1] !== "") {
      toInsert.unshift("");
    }
    result.splice(insertIdx, 0, ...toInsert);
  }

  return result.join("\n");
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Generate project context and optionally write to .smriti/CLAUDE.md.
 */
export async function generateContext(
  db: Database,
  options: ContextOptions = {}
): Promise<{
  projectId: string;
  context: string;
  written: boolean;
  path: string | null;
  tokenEstimate: number;
}> {
  const days = options.days || DEFAULT_CONTEXT_DAYS;

  // Detect project
  let projectId = options.project || detectProject(db, options.cwd);
  if (!projectId) {
    throw new Error(
      "Could not detect project. Use --project <id> or run from a project directory.\n" +
        "Run 'smriti projects' to see registered projects."
    );
  }

  // Verify project exists
  const project = db
    .prepare(`SELECT id, path FROM smriti_projects WHERE id = ?`)
    .get(projectId) as { id: string; path: string | null } | null;

  if (!project) {
    throw new Error(
      `Project '${projectId}' not found. Run 'smriti projects' to see registered projects.`
    );
  }

  // Gather and render — prefer cwd over stored path (stored path may have derivation mismatches)
  const actualDir = options.cwd || process.cwd();
  const ctx = gatherContext(db, projectId, days);
  const contextBlock = renderContext(ctx, projectId, days, actualDir);
  const tokenEstimate = contextBlock
    ? Math.ceil(contextBlock.length / 4)
    : 0;

  if (!contextBlock) {
    return {
      projectId,
      context: `No project context available for '${projectId}'. Run \`smriti ingest\` first.`,
      written: false,
      path: null,
      tokenEstimate: 0,
    };
  }

  if (options.dryRun) {
    return {
      projectId,
      context: contextBlock,
      written: false,
      path: null,
      tokenEstimate,
    };
  }

  // Write to .smriti/CLAUDE.md
  const smritiDir = join(actualDir, SMRITI_DIR);
  const claudeMdPath = join(smritiDir, "CLAUDE.md");

  mkdirSync(smritiDir, { recursive: true });

  let existing = "";
  try {
    existing = await Bun.file(claudeMdPath).text();
  } catch {
    // File doesn't exist yet — start with a header
    existing = "# Team Knowledge\n\nGenerated by smriti. Do not edit manually.\n";
  }

  const spliced = spliceContext(existing, contextBlock);
  await Bun.write(claudeMdPath, spliced);

  return {
    projectId,
    context: contextBlock,
    written: true,
    path: claudeMdPath,
    tokenEstimate,
  };
}

// =============================================================================
// Session Comparison
// =============================================================================

export type SessionMetrics = {
  id: string;
  title: string;
  createdAt: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  fileOps: number;
  fileReads: number;
  fileWrites: number;
  errors: number;
  durationMs: number;
};

export type CompareResult = {
  a: SessionMetrics;
  b: SessionMetrics;
  diff: {
    tokens: number;
    tokensPct: number;
    turns: number;
    turnsPct: number;
    toolCalls: number;
    toolCallsPct: number;
    fileReads: number;
    fileReadsPct: number;
  };
};

/**
 * Resolve a partial session ID to a full ID.
 * Supports prefix matching (first 8+ chars).
 */
export function resolveSessionId(db: Database, partial: string): string | null {
  // Try exact match first
  const exact = db
    .prepare(`SELECT id FROM memory_sessions WHERE id = ?`)
    .get(partial) as { id: string } | null;
  if (exact) return exact.id;

  // Prefix match
  const prefix = db
    .prepare(`SELECT id FROM memory_sessions WHERE id LIKE ? || '%' LIMIT 2`)
    .all(partial) as { id: string }[];
  if (prefix.length === 1) return prefix[0].id;
  if (prefix.length > 1) return null; // Ambiguous

  return null;
}

/**
 * Get the N most recent session IDs for a project.
 */
export function recentSessionIds(
  db: Database,
  n: number,
  projectId?: string
): string[] {
  if (projectId) {
    return (
      db
        .prepare(
          `SELECT ms.id FROM memory_sessions ms
           JOIN smriti_session_meta sm ON sm.session_id = ms.id
           WHERE sm.project_id = ?
           ORDER BY ms.updated_at DESC LIMIT ?`
        )
        .all(projectId, n) as { id: string }[]
    ).map((r) => r.id);
  }
  return (
    db
      .prepare(
        `SELECT id FROM memory_sessions ORDER BY updated_at DESC LIMIT ?`
      )
      .all(n) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Gather metrics for a single session from sidecar tables.
 */
export function gatherSessionMetrics(
  db: Database,
  sessionId: string
): SessionMetrics {
  // Session basics
  const session = db
    .prepare(`SELECT id, title, created_at FROM memory_sessions WHERE id = ?`)
    .get(sessionId) as { id: string; title: string; created_at: string };

  // Costs
  const costs = db
    .prepare(
      `SELECT turn_count, total_input_tokens, total_output_tokens, total_duration_ms
       FROM smriti_session_costs WHERE session_id = ?`
    )
    .get(sessionId) as {
      turn_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_duration_ms: number;
    } | null;

  // Tool calls
  const toolRows = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS count
       FROM smriti_tool_usage WHERE session_id = ?
       GROUP BY tool_name ORDER BY count DESC`
    )
    .all(sessionId) as { tool_name: string; count: number }[];

  const toolBreakdown: Record<string, number> = {};
  let toolCalls = 0;
  for (const row of toolRows) {
    toolBreakdown[row.tool_name] = row.count;
    toolCalls += row.count;
  }

  // File operations
  const fileStats = db
    .prepare(
      `SELECT operation, COUNT(*) AS count
       FROM smriti_file_operations WHERE session_id = ?
       GROUP BY operation`
    )
    .all(sessionId) as { operation: string; count: number }[];

  let fileOps = 0;
  let fileReads = 0;
  let fileWrites = 0;
  for (const row of fileStats) {
    fileOps += row.count;
    if (row.operation === "read") fileReads = row.count;
    if (row.operation === "write" || row.operation === "edit")
      fileWrites += row.count;
  }

  // Errors
  const errorRow = db
    .prepare(
      `SELECT COUNT(*) AS count FROM smriti_errors WHERE session_id = ?`
    )
    .get(sessionId) as { count: number };

  return {
    id: session.id,
    title: session.title || session.id.slice(0, 8),
    createdAt: session.created_at,
    turnCount: costs?.turn_count || 0,
    inputTokens: costs?.total_input_tokens || 0,
    outputTokens: costs?.total_output_tokens || 0,
    totalTokens:
      (costs?.total_input_tokens || 0) + (costs?.total_output_tokens || 0),
    toolCalls,
    toolBreakdown,
    fileOps,
    fileReads,
    fileWrites,
    errors: errorRow.count,
    durationMs: costs?.total_duration_ms || 0,
  };
}

function pctChange(a: number, b: number): number {
  if (a === 0) return b === 0 ? 0 : 100;
  return ((b - a) / a) * 100;
}

/**
 * Compare two sessions and compute differences.
 */
export function compareSessions(
  db: Database,
  idA: string,
  idB: string
): CompareResult {
  const a = gatherSessionMetrics(db, idA);
  const b = gatherSessionMetrics(db, idB);

  return {
    a,
    b,
    diff: {
      tokens: b.totalTokens - a.totalTokens,
      tokensPct: pctChange(a.totalTokens, b.totalTokens),
      turns: b.turnCount - a.turnCount,
      turnsPct: pctChange(a.turnCount, b.turnCount),
      toolCalls: b.toolCalls - a.toolCalls,
      toolCallsPct: pctChange(a.toolCalls, b.toolCalls),
      fileReads: b.fileReads - a.fileReads,
      fileReadsPct: pctChange(a.fileReads, b.fileReads),
    },
  };
}

/**
 * Format comparison result as a readable table.
 */
export function formatCompare(result: CompareResult): string {
  const { a, b, diff } = result;
  const lines: string[] = [];

  lines.push(`Session A: ${a.title}`);
  lines.push(`  ${a.id} (${a.createdAt.slice(0, 16)})`);
  lines.push(`Session B: ${b.title}`);
  lines.push(`  ${b.id} (${b.createdAt.slice(0, 16)})`);
  lines.push("");

  // Table header
  const pad = (s: string, n: number) => s.padEnd(n);
  const rpad = (s: string, n: number) => s.padStart(n);
  const fmtDiff = (n: number, pct: number) => {
    const sign = n > 0 ? "+" : "";
    const pctStr = pct !== 0 ? ` (${sign}${pct.toFixed(0)}%)` : "";
    return `${sign}${n}${pctStr}`;
  };

  lines.push(
    `${pad("Metric", 20)} ${rpad("A", 12)} ${rpad("B", 12)} ${rpad("Diff", 18)}`
  );
  lines.push("-".repeat(64));

  lines.push(
    `${pad("Turns", 20)} ${rpad(String(a.turnCount), 12)} ${rpad(String(b.turnCount), 12)} ${rpad(fmtDiff(diff.turns, diff.turnsPct), 18)}`
  );
  lines.push(
    `${pad("Total tokens", 20)} ${rpad(formatTokens(a.totalTokens), 12)} ${rpad(formatTokens(b.totalTokens), 12)} ${rpad(fmtDiff(diff.tokens, diff.tokensPct), 18)}`
  );
  lines.push(
    `${pad("  Input", 20)} ${rpad(formatTokens(a.inputTokens), 12)} ${rpad(formatTokens(b.inputTokens), 12)}`
  );
  lines.push(
    `${pad("  Output", 20)} ${rpad(formatTokens(a.outputTokens), 12)} ${rpad(formatTokens(b.outputTokens), 12)}`
  );
  lines.push(
    `${pad("Tool calls", 20)} ${rpad(String(a.toolCalls), 12)} ${rpad(String(b.toolCalls), 12)} ${rpad(fmtDiff(diff.toolCalls, diff.toolCallsPct), 18)}`
  );
  lines.push(
    `${pad("File reads", 20)} ${rpad(String(a.fileReads), 12)} ${rpad(String(b.fileReads), 12)} ${rpad(fmtDiff(diff.fileReads, diff.fileReadsPct), 18)}`
  );
  lines.push(
    `${pad("File writes", 20)} ${rpad(String(a.fileWrites), 12)} ${rpad(String(b.fileWrites), 12)}`
  );
  lines.push(
    `${pad("Errors", 20)} ${rpad(String(a.errors), 12)} ${rpad(String(b.errors), 12)}`
  );

  // Tool breakdown
  const allTools = new Set([
    ...Object.keys(a.toolBreakdown),
    ...Object.keys(b.toolBreakdown),
  ]);
  if (allTools.size > 0) {
    lines.push("");
    lines.push("Tool breakdown:");
    for (const tool of [...allTools].sort()) {
      const countA = a.toolBreakdown[tool] || 0;
      const countB = b.toolBreakdown[tool] || 0;
      if (countA > 0 || countB > 0) {
        lines.push(
          `  ${pad(tool, 18)} ${rpad(String(countA), 12)} ${rpad(String(countB), 12)}`
        );
      }
    }
  }

  return lines.join("\n");
}
