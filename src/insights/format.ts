/**
 * insights/format.ts - CLI formatters for insights reports
 */

import { table } from "../format";
import type {
  OverviewReport,
  SessionReport,
  ProjectReport,
  CostReport,
  ErrorReport,
  ToolReport,
  Recommendation,
} from "./index";

// =============================================================================
// Helpers
// =============================================================================

function dollar(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function num(n: number): string {
  return n.toLocaleString();
}

// =============================================================================
// Overview
// =============================================================================

export function formatOverview(report: OverviewReport, recs: Recommendation[]): string {
  const lines: string[] = [];

  lines.push("## Smriti Insights Dashboard\n");
  lines.push(`Sessions: ${num(report.totalSessions)}  |  Messages: ${num(report.totalMessages)}  |  Total Cost: ${dollar(report.totalCost)}\n`);

  // Cost by model
  if (report.costByModel.length > 0) {
    lines.push("### Cost by Model\n");
    lines.push(table(
      ["Model", "Cost", "Turns", "% of Total"],
      report.costByModel.map((r) => [
        r.model,
        dollar(r.cost),
        num(r.turns),
        pct(report.totalCost > 0 ? r.cost / report.totalCost : 0),
      ]),
    ));
    lines.push("");
  }

  // Top projects
  if (report.topProjects.length > 0) {
    lines.push("### Top Projects by Spend\n");
    lines.push(table(
      ["Project", "Cost", "Sessions"],
      report.topProjects.map((r) => [r.project, dollar(r.cost), String(r.sessions)]),
    ));
    lines.push("");
  }

  // Failing tools
  if (report.topFailingTools.length > 0) {
    lines.push("### Tool Failures\n");
    lines.push(table(
      ["Tool", "Failures", "Total", "Fail Rate"],
      report.topFailingTools.map((r) => [r.tool, String(r.failures), String(r.total), pct(r.rate)]),
    ));
    lines.push("");
  }

  // Error hotspots
  if (report.errorHotspots.length > 0) {
    lines.push("### Error Hotspots\n");
    lines.push(table(
      ["Session", "Title", "Errors"],
      report.errorHotspots.map((r) => [r.sessionId.slice(0, 8), r.title || "-", String(r.errorCount)]),
    ));
    lines.push("");
  }

  // Recommendations
  if (recs.length > 0) {
    lines.push("### Recommendations\n");
    for (const rec of recs) {
      const icon = rec.severity === "high" ? "[!]" : rec.severity === "medium" ? "[~]" : "[.]";
      lines.push(`${icon} ${rec.message}`);
      lines.push(`    ${rec.detail}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Session
// =============================================================================

export function formatSessionInsights(report: SessionReport): string {
  const lines: string[] = [];

  lines.push(`## Session: ${report.title}\n`);
  lines.push(`ID: ${report.sessionId}`);
  lines.push(`Created: ${report.createdAt}`);
  lines.push(`Total Cost: ${dollar(report.totalCost)}\n`);

  // Cost by model
  if (report.costByModel.length > 0) {
    lines.push("### Cost by Model\n");
    lines.push(table(
      ["Model", "Cost", "Input Tok", "Output Tok", "Cache Tok", "Turns"],
      report.costByModel.map((r) => [
        r.model,
        dollar(r.cost),
        num(r.inputTokens),
        num(r.outputTokens),
        num(r.cacheTokens),
        String(r.turns),
      ]),
    ));
    lines.push("");
  }

  // Tools
  if (report.tools.length > 0) {
    lines.push("### Tool Usage\n");
    lines.push(table(
      ["Tool", "Calls", "OK", "Fail"],
      report.tools.map((r) => [r.name, String(r.count), String(r.successes), String(r.failures)]),
    ));
    lines.push("");
  }

  // Errors
  if (report.errors.length > 0) {
    lines.push("### Errors\n");
    lines.push(table(
      ["Type", "Message", "Count"],
      report.errors.map((r) => [r.type, (r.message || "").slice(0, 60), String(r.count)]),
    ));
    lines.push("");
  }

  // File operations
  if (report.fileOps.length > 0) {
    lines.push("### File Operations\n");
    lines.push(table(
      ["Path", "Reads", "Edits", "Writes"],
      report.fileOps.slice(0, 15).map((r) => [r.path, String(r.reads), String(r.edits), String(r.writes)]),
    ));
    lines.push("");
  }

  // Git operations
  if (report.gitOps.length > 0) {
    lines.push("### Git Operations\n");
    lines.push(table(
      ["Operation", "Branch", "PR"],
      report.gitOps.map((r) => [r.operation, r.branch || "-", r.prUrl || "-"]),
    ));
    lines.push("");
  }

  // Commands
  if (report.commands.length > 0) {
    lines.push("### Commands\n");
    lines.push(table(
      ["Command", "Exit", "Git?"],
      report.commands.slice(0, 20).map((r) => [
        r.command.slice(0, 60),
        r.exitCode != null ? String(r.exitCode) : "-",
        r.isGit ? "yes" : "",
      ]),
    ));
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Project
// =============================================================================

export function formatProjectInsights(report: ProjectReport): string {
  const lines: string[] = [];

  lines.push(`## Project: ${report.projectId}\n`);
  lines.push(`Sessions: ${report.sessionCount}  |  Total Cost: ${dollar(report.totalCost)}  |  Avg/Session: ${dollar(report.avgCostPerSession)}`);
  lines.push(`Error Rate: ${report.errorRate.toFixed(1)} errors/session  |  Build/Test Fail Rate: ${pct(report.buildTestFailRate)}\n`);

  if (report.toolDistribution.length > 0) {
    lines.push("### Tool Distribution\n");
    lines.push(table(
      ["Tool", "Calls"],
      report.toolDistribution.map((r) => [r.tool, String(r.count)]),
    ));
    lines.push("");
  }

  if (report.mostAccessedFiles.length > 0) {
    lines.push("### Most Read Files (knowledge bottlenecks)\n");
    lines.push(table(
      ["File", "Reads"],
      report.mostAccessedFiles.map((r) => [r.path, String(r.count)]),
    ));
    lines.push("");
  }

  if (report.mostEditedFiles.length > 0) {
    lines.push("### Most Edited Files (churn hotspots)\n");
    lines.push(table(
      ["File", "Edits"],
      report.mostEditedFiles.map((r) => [r.path, String(r.count)]),
    ));
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Costs
// =============================================================================

export function formatCostBreakdown(report: CostReport): string {
  const lines: string[] = [];

  lines.push(`## Cost Breakdown\n`);
  lines.push(`Total: ${dollar(report.totalCost)}\n`);

  if (report.byModel.length > 0) {
    lines.push("### By Model\n");
    lines.push(table(
      ["Model", "Cost", "Input Tok", "Output Tok", "Cache Tok", "Turns"],
      report.byModel.map((r) => [
        r.model,
        dollar(r.cost),
        num(r.inputTokens),
        num(r.outputTokens),
        num(r.cacheTokens),
        String(r.turns),
      ]),
    ));
    lines.push("");
  }

  if (report.byProject.length > 0) {
    lines.push("### By Project\n");
    lines.push(table(
      ["Project", "Cost", "Sessions"],
      report.byProject.map((r) => [r.project, dollar(r.cost), String(r.sessions)]),
    ));
    lines.push("");
  }

  if (report.byDay.length > 0) {
    lines.push("### By Day\n");
    lines.push(table(
      ["Date", "Cost", "Sessions"],
      report.byDay.map((r) => [r.date, dollar(r.cost), String(r.sessions)]),
    ));
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Errors
// =============================================================================

export function formatErrorAnalysis(report: ErrorReport): string {
  const lines: string[] = [];

  lines.push(`## Error Analysis\n`);
  lines.push(`Total Errors: ${num(report.totalErrors)}\n`);

  if (report.byType.length > 0) {
    lines.push("### By Type\n");
    lines.push(table(
      ["Type", "Count"],
      report.byType.map((r) => [r.type, String(r.count)]),
    ));
    lines.push("");
  }

  if (report.bySession.length > 0) {
    lines.push("### By Session\n");
    lines.push(table(
      ["Session", "Title", "Errors"],
      report.bySession.map((r) => [r.sessionId.slice(0, 8), r.title || "-", String(r.count)]),
    ));
    lines.push("");
  }

  if (report.recentErrors.length > 0) {
    lines.push("### Recent Errors\n");
    lines.push(table(
      ["Type", "Message", "When"],
      report.recentErrors.slice(0, 10).map((r) => [
        r.type,
        (r.message || "").slice(0, 50),
        r.createdAt?.slice(0, 16) || "-",
      ]),
    ));
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Tools
// =============================================================================

export function formatToolStats(report: ToolReport): string {
  const lines: string[] = [];

  lines.push(`## Tool Reliability\n`);
  lines.push(`Total Calls: ${num(report.totalCalls)}\n`);

  if (report.tools.length > 0) {
    lines.push(table(
      ["Tool", "Calls", "OK", "Fail", "Fail%", "Avg ms"],
      report.tools.map((r) => [
        r.name,
        String(r.count),
        String(r.successes),
        String(r.failures),
        pct(r.rate),
        r.avgDurationMs != null ? Math.round(r.avgDurationMs).toString() : "-",
      ]),
    ));
    lines.push("");
  }

  return lines.join("\n");
}
