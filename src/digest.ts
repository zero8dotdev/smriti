/**
 * digest.ts - Structured work summary for a time window (#63)
 *
 * Aggregates session activity from sidecar tables into a digest report
 * grouped by project. Optionally synthesizes a narrative via Ollama.
 */

import type { Database } from "bun:sqlite";
import { ollamaChat } from "./ollama";

// =============================================================================
// Types
// =============================================================================

export type DigestSession = {
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
};

export type DigestProject = {
  projectId: string | null;
  sessionCount: number;
  totalTokens: number;
  estimatedCost: number;
  filesChanged: number;
  gitOps: number;
  errorCount: number;
  topTools: Array<{ toolName: string; count: number }>;
  sessions: DigestSession[];
};

export type DigestReport = {
  period: { from: string; to: string; days: number };
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCost: number;
  byProject: DigestProject[];
  topErrors: Array<{ message: string; count: number }>;
  synthesis?: string;
};

// =============================================================================
// Core
// =============================================================================

export async function generateDigest(
  db: Database,
  options: {
    days?: number;
    project?: string;
    synthesize?: boolean;
    model?: string;
    maxTokens?: number;
  } = {}
): Promise<DigestReport> {
  const days = options.days ?? 7;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const now = new Date().toISOString();

  // Fetch sessions within the window
  let sessionQuery = `
    SELECT
      ms.id,
      ms.title,
      ms.updated_at,
      sm.agent_id,
      sm.project_id,
      COALESCE(sm.density_score, 0) as density_score
    FROM memory_sessions ms
    JOIN smriti_session_meta sm ON sm.session_id = ms.id
    WHERE ms.active = 1 AND ms.updated_at >= ?
  `;
  const sessionParams: (string | number)[] = [cutoff];

  if (options.project) {
    sessionQuery += ` AND sm.project_id = ?`;
    sessionParams.push(options.project);
  }

  sessionQuery += ` ORDER BY ms.updated_at DESC`;

  const sessionRows = db.prepare(sessionQuery).all(...sessionParams) as Array<{
    id: string;
    title: string;
    updated_at: string;
    agent_id: string | null;
    project_id: string | null;
    density_score: number;
  }>;

  if (sessionRows.length === 0) {
    return {
      period: { from: cutoff, to: now, days },
      totalSessions: 0,
      totalMessages: 0,
      totalTokens: 0,
      estimatedCost: 0,
      byProject: [],
      topErrors: [],
    };
  }

  const sessionIds = sessionRows.map((s) => s.id);
  const inPlaceholders = sessionIds.map(() => "?").join(",");

  // Total message count
  const msgCountRow = db
    .prepare(`SELECT COUNT(*) as n FROM memory_messages WHERE session_id IN (${inPlaceholders})`)
    .get(...sessionIds) as { n: number };

  // Tool counts per session
  const toolCountRows = db
    .prepare(
      `SELECT session_id, COUNT(*) as n FROM smriti_tool_usage
       WHERE session_id IN (${inPlaceholders}) GROUP BY session_id`
    )
    .all(...sessionIds) as { session_id: string; n: number }[];
  const toolCountMap = new Map(toolCountRows.map((r) => [r.session_id, r.n]));

  // File write counts per session
  const fileCountRows = db
    .prepare(
      `SELECT session_id, COUNT(*) as n FROM smriti_file_operations
       WHERE session_id IN (${inPlaceholders})
         AND operation IN ('write', 'edit', 'create')
       GROUP BY session_id`
    )
    .all(...sessionIds) as { session_id: string; n: number }[];
  const fileCountMap = new Map(fileCountRows.map((r) => [r.session_id, r.n]));

  // Git op counts per session
  const gitCountRows = db
    .prepare(
      `SELECT session_id, COUNT(*) as n FROM smriti_git_operations
       WHERE session_id IN (${inPlaceholders}) GROUP BY session_id`
    )
    .all(...sessionIds) as { session_id: string; n: number }[];
  const gitCountMap = new Map(gitCountRows.map((r) => [r.session_id, r.n]));

  // Error counts per session
  const errorCountRows = db
    .prepare(
      `SELECT session_id, COUNT(*) as n FROM smriti_errors
       WHERE session_id IN (${inPlaceholders}) GROUP BY session_id`
    )
    .all(...sessionIds) as { session_id: string; n: number }[];
  const errorCountMap = new Map(errorCountRows.map((r) => [r.session_id, r.n]));

  // Costs per session
  const costRows = db
    .prepare(
      `SELECT session_id,
              SUM(total_input_tokens + total_output_tokens + total_cache_tokens) as tokens,
              SUM(estimated_cost_usd) as cost
       FROM smriti_session_costs
       WHERE session_id IN (${inPlaceholders})
       GROUP BY session_id`
    )
    .all(...sessionIds) as { session_id: string; tokens: number; cost: number }[];
  const costMap = new Map(costRows.map((r) => [r.session_id, r]));

  // Build DigestSession list
  const digestSessions: DigestSession[] = sessionRows.map((s) => {
    const costs = costMap.get(s.id);
    return {
      id: s.id,
      title: s.title || "(untitled)",
      projectId: s.project_id,
      agentId: s.agent_id,
      toolCount: toolCountMap.get(s.id) ?? 0,
      fileCount: fileCountMap.get(s.id) ?? 0,
      gitCount: gitCountMap.get(s.id) ?? 0,
      errorCount: errorCountMap.get(s.id) ?? 0,
      totalTokens: costs?.tokens ?? 0,
      estimatedCost: costs?.cost ?? 0,
      densityScore: s.density_score,
      updatedAt: s.updated_at,
    };
  });

  // Group by project
  const projectMap = new Map<string | null, DigestSession[]>();
  for (const s of digestSessions) {
    const key = s.projectId;
    if (!projectMap.has(key)) projectMap.set(key, []);
    projectMap.get(key)!.push(s);
  }

  // Build per-project tool summaries
  const byProject: DigestProject[] = [];
  for (const [projectId, sessions] of projectMap) {
    const projSessionIds = sessions.map((s) => s.id);
    const projPlaceholders = projSessionIds.map(() => "?").join(",");

    const topToolRows = db
      .prepare(
        `SELECT tool_name, COUNT(*) as n FROM smriti_tool_usage
         WHERE session_id IN (${projPlaceholders})
         GROUP BY tool_name ORDER BY n DESC LIMIT 5`
      )
      .all(...projSessionIds) as { tool_name: string; n: number }[];

    byProject.push({
      projectId,
      sessionCount: sessions.length,
      totalTokens: sessions.reduce((s, r) => s + r.totalTokens, 0),
      estimatedCost: sessions.reduce((s, r) => s + r.estimatedCost, 0),
      filesChanged: sessions.reduce((s, r) => s + r.fileCount, 0),
      gitOps: sessions.reduce((s, r) => s + r.gitCount, 0),
      errorCount: sessions.reduce((s, r) => s + r.errorCount, 0),
      topTools: topToolRows.map((r) => ({ toolName: r.tool_name, count: r.n })),
      sessions,
    });
  }

  // Sort projects by activity (token volume descending)
  byProject.sort((a, b) => b.totalTokens - a.totalTokens);

  // Top errors across all sessions
  const topErrorRows = db
    .prepare(
      `SELECT message, COUNT(*) as n FROM smriti_errors
       WHERE session_id IN (${inPlaceholders})
       GROUP BY message ORDER BY n DESC LIMIT 5`
    )
    .all(...sessionIds) as { message: string; n: number }[];

  const totalTokens = digestSessions.reduce((s, r) => s + r.totalTokens, 0);
  const estimatedCost = digestSessions.reduce((s, r) => s + r.estimatedCost, 0);

  const report: DigestReport = {
    period: { from: cutoff, to: now, days },
    totalSessions: digestSessions.length,
    totalMessages: msgCountRow.n,
    totalTokens,
    estimatedCost,
    byProject,
    topErrors: topErrorRows.map((r) => ({ message: r.message, count: r.n })),
  };

  // Optional Ollama synthesis
  if (options.synthesize && digestSessions.length > 0) {
    const summaryLines: string[] = [
      `Period: last ${days} days`,
      `Sessions: ${digestSessions.length}`,
      "",
    ];
    for (const proj of byProject) {
      summaryLines.push(`Project: ${proj.projectId ?? "(no project)"}`);
      for (const s of proj.sessions.slice(0, 5)) {
        summaryLines.push(
          `  - ${s.title} | tools:${s.toolCount} files:${s.fileCount} git:${s.gitCount} errors:${s.errorCount}`
        );
      }
      if (proj.sessions.length > 5) {
        summaryLines.push(`  ... and ${proj.sessions.length - 5} more sessions`);
      }
    }

    try {
      const response = await ollamaChat(
        [
          {
            role: "system",
            content:
              "You are a work digest generator. Given a summary of recent AI-assisted engineering sessions, " +
              "produce a concise narrative (3-5 sentences) describing what was accomplished. " +
              "Focus on outcomes: what was built, fixed, or decided. Be specific about projects. " +
              "Output only the narrative, no preamble.",
          },
          { role: "user", content: summaryLines.join("\n") },
        ],
        {
          model: options.model,
          temperature: 0.3,
          maxTokens: options.maxTokens ?? 512,
        }
      );
      report.synthesis = response.message.content.trim();
    } catch {
      // Synthesis is best-effort
    }
  }

  return report;
}
