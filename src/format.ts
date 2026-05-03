/**
 * format.ts - Output formatting for CLI display
 *
 * Supports table, JSON, and markdown output modes.
 */

// =============================================================================
// Table Formatting
// =============================================================================

/** Pad a string to a fixed width, truncating if needed */
function pad(str: string, width: number): string {
  if (str.length > width) return str.slice(0, width - 1) + "\u2026";
  return str.padEnd(width);
}

/** Format rows as a simple text table */
export function table(
  headers: string[],
  rows: string[][],
  widths?: number[]
): string {
  const colWidths =
    widths ||
    headers.map((h, i) => {
      const maxRow = Math.max(...rows.map((r) => (r[i] || "").length), 0);
      return Math.max(h.length, Math.min(maxRow, 60));
    });

  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join("  ");
  const separator = colWidths.map((w) => "-".repeat(w)).join("  ");
  const dataLines = rows.map((row) =>
    row.map((cell, i) => pad(cell || "", colWidths[i])).join("  ")
  );

  return [headerLine, separator, ...dataLines].join("\n");
}

// =============================================================================
// Session Formatting
// =============================================================================

export function formatSessionList(
  sessions: Array<{
    id: string;
    title: string;
    updated_at: string;
    agent_id?: string | null;
    project_id?: string | null;
    categories?: string;
  }>
): string {
  if (sessions.length === 0) return "No sessions found.";

  const headers = ["ID", "Title", "Updated", "Agent", "Project", "Categories"];
  const rows = sessions.map((s) => [
    s.id.slice(0, 8),
    s.title || "(untitled)",
    s.updated_at?.slice(0, 16) || "",
    s.agent_id || "-",
    s.project_id || "-",
    s.categories || "-",
  ]);

  return table(headers, rows, [10, 40, 18, 14, 14, 20]);
}

// =============================================================================
// Search Result Formatting
// =============================================================================

export function formatSearchResults(
  results: Array<{
    session_id: string;
    session_title: string;
    message_id: number;
    role: string;
    content: string;
    score: number;
  }>
): string {
  if (results.length === 0) return "No results found.";

  const lines: string[] = [];
  for (const r of results) {
    const snippet = r.content.slice(0, 200).replace(/\n/g, " ");
    lines.push(
      `[${r.score.toFixed(3)}] ${r.session_title || r.session_id.slice(0, 8)}`
    );
    lines.push(`  ${r.role}: ${snippet}`);
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Status Formatting
// =============================================================================

export function formatStatus(stats: {
  sessions: number;
  activeSessions: number;
  messages: number;
  embeddedMessages: number;
  summarizedSessions: number;
  agentCounts?: Record<string, number>;
  projectCounts?: Record<string, number>;
  categoryCounts?: Record<string, number>;
  projectFilter?: string;
}): string {
  const lines: string[] = [];

  if (stats.projectFilter) {
    lines.push(`Status for project: ${stats.projectFilter}`);
    lines.push("");
  }

  lines.push(
    `Sessions:      ${stats.sessions} (${stats.activeSessions} active)`,
    `Messages:      ${stats.messages} (${stats.embeddedMessages} embedded)`,
    `Summarized:    ${stats.summarizedSessions}`,
  );

  if (stats.agentCounts && Object.keys(stats.agentCounts).length > 0) {
    lines.push("");
    lines.push("By Agent:");
    for (const [agent, count] of Object.entries(stats.agentCounts)) {
      lines.push(`  ${agent}: ${count}`);
    }
  }

  if (stats.projectCounts && Object.keys(stats.projectCounts).length > 0) {
    lines.push("");
    lines.push("By Project:");
    for (const [project, count] of Object.entries(stats.projectCounts)) {
      lines.push(`  ${project}: ${count}`);
    }
  }

  if (stats.categoryCounts && Object.keys(stats.categoryCounts).length > 0) {
    lines.push("");
    lines.push("By Category:");
    for (const [cat, count] of Object.entries(stats.categoryCounts)) {
      lines.push(`  ${cat}: ${count}`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Ingest Result Formatting
// =============================================================================

export function formatIngestResult(result: {
  agent: string;
  sessionsFound: number;
  sessionsIngested: number;
  messagesIngested: number;
  skipped: number;
  errors: string[];
}): string {
  const lines = [
    `Agent: ${result.agent}`,
    `Sessions found: ${result.sessionsFound}`,
    `Sessions ingested: ${result.sessionsIngested}`,
    `Messages ingested: ${result.messagesIngested}`,
    `Skipped: ${result.skipped}`,
  ];

  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 5)) {
      lines.push(`  - ${err}`);
    }
    if (result.errors.length > 5) {
      lines.push(`  ... and ${result.errors.length - 5} more`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Category Tree Formatting
// =============================================================================

export function formatCategoryTree(
  tree: Map<
    string,
    { id: string; name: string; description: string; children: string[] }
  >,
  allCats: Array<{ id: string; name: string; description: string }>
): string {
  const catMap = new Map(allCats.map((c) => [c.id, c]));
  const lines: string[] = [];

  for (const [, node] of tree) {
    lines.push(`${node.id} - ${node.description || node.name}`);
    for (const childId of node.children) {
      const child = catMap.get(childId);
      if (child) {
        lines.push(`  ${child.id} - ${child.description || child.name}`);
      }
    }
  }

  return lines.join("\n");
}

// =============================================================================
// JSON Output
// =============================================================================

export function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// =============================================================================
// Team Contributions Formatting
// =============================================================================

export function formatTeamContributions(
  contributions: Array<{
    author: string;
    count: number;
    categories: string;
    latest: string;
  }>
): string {
  if (contributions.length === 0) return "No team contributions found.";

  const headers = ["Author", "Shared", "Categories", "Latest"];
  const rows = contributions.map((c) => [
    c.author,
    String(c.count),
    c.categories || "-",
    c.latest?.slice(0, 16) || "-",
  ]);

  return table(headers, rows);
}

// =============================================================================
// Share Result Formatting
// =============================================================================

export function formatShareResult(result: {
  filesCreated: number;
  filesSkipped: number;
  outputDir: string;
  errors: string[];
}): string {
  const lines = [
    `Output: ${result.outputDir}`,
    `Files created: ${result.filesCreated}`,
    `Files skipped: ${result.filesSkipped}`,
  ];

  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 5)) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Sync Result Formatting
// =============================================================================

export function formatSyncResult(result: {
  filesProcessed: number;
  imported: number;
  skipped: number;
  errors: string[];
}): string {
  const lines = [
    `Files processed: ${result.filesProcessed}`,
    `Imported: ${result.imported}`,
    `Skipped: ${result.skipped}`,
  ];

  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 5)) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Project Report Formatting
// =============================================================================

export function formatProjectReport(
  report: {
    project: {
      id: string;
      path: string | null;
      description: string | null;
      language: string | null;
      framework: string | null;
    } | null;
    sessionCount: number;
    messageCount: number;
    byAgent: Array<{ agent_id: string | null; session_count: number }>;
    tags: Array<{ category_id: string; session_count: number }>;
    decisionCount: number;
    recentSessions: Array<{
      id: string;
      title: string;
      updated_at: string;
      agent_id: string | null;
      categories: string;
    }>;
  },
  options?: { tagsOnly?: boolean; decisionsOnly?: boolean }
): string {
  if (!report.project) return "Project not found.";

  const lines: string[] = [];

  if (!options?.tagsOnly && !options?.decisionsOnly) {
    lines.push(`Project: ${report.project.id}`);
    if (report.project.path) lines.push(`Path:    ${report.project.path}`);
    if (report.project.language) lines.push(`Language: ${report.project.language}`);
    if (report.project.framework) lines.push(`Framework: ${report.project.framework}`);
    if (report.project.description) lines.push(`Description: ${report.project.description}`);

    lines.push("");
    lines.push(`Sessions: ${report.sessionCount}`);
    lines.push(`Messages: ${report.messageCount.toLocaleString()}`);
  }

  if (!options?.decisionsOnly) {
    if (report.tags.length > 0) {
      lines.push("");
      lines.push("Tags:");
      for (const tag of report.tags) {
        lines.push(`  ${tag.category_id.padEnd(30)}  ${tag.session_count} session${tag.session_count === 1 ? "" : "s"}`);
      }
    }
  }

  if (!options?.tagsOnly) {
    if (report.byAgent.length > 0 && !options?.decisionsOnly) {
      lines.push("");
      lines.push("By Agent:");
      for (const agent of report.byAgent) {
        const agentName = agent.agent_id || "(unknown)";
        lines.push(`  ${agentName.padEnd(20)}  ${agent.session_count} session${agent.session_count === 1 ? "" : "s"}`);
      }
    }

    lines.push("");
    lines.push(`Decisions: ${report.decisionCount} session${report.decisionCount === 1 ? "" : "s"} tagged decision/*`);

    if (report.recentSessions.length > 0) {
      lines.push("");
      lines.push("Recent Sessions:");
      for (const sess of report.recentSessions) {
        const cats = sess.categories ? ` [${sess.categories}]` : "";
        lines.push(`  ${sess.id.slice(0, 8)}  ${sess.title || "(untitled)"}${cats}`);
        lines.push(`             ${sess.updated_at.slice(0, 16)}  ${sess.agent_id || "-"}`);
      }
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Tag Usage Formatting
// =============================================================================

export function formatTagUsage(
  usage: Array<{ category_id: string; session_count: number; display_name?: string | null }>,
  projectFilter?: string
): string {
  if (usage.length === 0) {
    return "No tags in use.";
  }

  const scope = projectFilter ? `project: ${projectFilter}` : "global";
  const lines: string[] = [
    `Tags in use (${scope}):`,
    "",
  ];

  for (const tag of usage) {
    const name = tag.display_name || tag.category_id;
    lines.push(`  ${name.padEnd(30)}  ${tag.session_count} session${tag.session_count === 1 ? "" : "s"}`);
  }

  return lines.join("\n");
}
