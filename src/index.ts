#!/usr/bin/env bun
/**
 * index.ts - Smriti CLI entry point
 *
 * Unified memory layer across all AI agents.
 * Builds on QMD's memory infrastructure with multi-agent ingestion,
 * schema-based categorization, and team knowledge sharing.
 */

import { initSmriti, closeDb, getCategories, getCategoryTree, addCategory, listProjects, tagSession, getProjectReport, type ProjectInspectReport, getTagUsage, type TagUsageEntry, computeDensityScore, updateDensityScore, insertSessionQueries, getUnenrichedSessionIds, listKnowledgeUnits, forgetSession } from "./db";
import { getMessages, getSession, getMemoryStatus, embedMemoryMessages } from "./qmd";
import { ingest, ingestAll } from "./ingest/index";
import { categorizeUncategorized } from "./categorize/classifier";
import { formatCategoryTree as schemaFormatCategoryTree, isValidCategory } from "./categorize/schema";
import { searchFiltered, listSessions } from "./search/index";
import { recall } from "./search/recall";
import { shareKnowledge } from "./team/share";
import { syncTeamKnowledge, listTeamContributions } from "./team/sync";
import { consolidateKnowledge } from "./learn/consolidate";
import { findEntity, getUnitsForEntity, getRelationships } from "./learn/entities";
import {
  generateContext,
  compareSessions,
  resolveSessionId,
  recentSessionIds,
  formatCompare,
} from "./context";
import {
  getOverview,
  getSessionInsights,
  getProjectInsights,
  getCostBreakdown,
  getErrorAnalysis,
  getToolStats,
  getRecommendations,
} from "./insights/index";
import {
  formatOverview,
  formatSessionInsights,
  formatProjectInsights,
  formatCostBreakdown,
  formatErrorAnalysis,
  formatToolStats,
} from "./insights/format";
import {
  formatSessionList,
  formatSearchResults,
  formatStatus,
  formatIngestResult,
  formatCategoryTree,
  formatTeamContributions,
  formatShareResult,
  formatSyncResult,
  formatProjectReport,
  formatTagUsage,
  formatDensityBreakdown,
  formatDigest,
  formatConsolidateResult,
  formatLearnings,
  formatEntityGraph,
  json,
} from "./format";
import { generateDigest } from "./digest";
import { ollamaAsk, ollamaDrift, ollamaCheckConflicts } from "./ollama";
import { clusterSessions, getClusterSessionIds } from "./cluster";

// =============================================================================
// New command blueprint - read-only commands (cutover in progress)
// =============================================================================
import type { CommandResult } from "./command";
import { StatusCommand, createRealStatusBackend } from "./commands/status";
import { ListCommand, createRealListBackend } from "./commands/list";
import { ShowCommand, createRealShowBackend } from "./commands/show";
import { TagsCommand, createRealTagsBackend } from "./commands/tags";
import { CategoriesCommand, CategoriesAddCommand, createRealCategoriesBackend } from "./commands/categories";
import { ProjectsCommand, createRealProjectsBackend } from "./commands/projects";
import { LearningsCommand, createRealLearningsBackend } from "./commands/learnings";
import { GraphCommand, createRealGraphBackend } from "./commands/graph";
import { TeamCommand, createRealTeamBackend } from "./commands/team";
import { DigestCommand, createRealDigestBackend } from "./commands/digest";
import { ClustersCommand, createRealClustersBackend } from "./commands/clusters";
import {
  InsightsCommand,
  InsightsSessionCommand,
  InsightsProjectCommand,
  InsightsCostsCommand,
  InsightsErrorsCommand,
  InsightsToolsCommand,
  createRealInsightsSessionBackend,
  createRealInsightsProjectBackend,
  createRealInsightsCostsBackend,
  createRealInsightsErrorsBackend,
  createRealInsightsToolsBackend,
  createRealInsightsOverviewBackend,
  createRealInsightsRecommendationsBackend,
} from "./commands/insights";
import { SearchCommand, createRealSearchBackend } from "./commands/search";
import { RecallCommand, createRealRecallBackend } from "./commands/recall";
import { AskCommand, createRealAskBackend } from "./commands/ask";
import { DriftCommand, createRealDriftBackend } from "./commands/drift";
import { CompareCommand, createRealCompareBackend } from "./commands/compare";
import { IngestCommand, createRealIngestBackend } from "./commands/ingest";
import { CategorizeCommand, createRealCategorizeBackend } from "./commands/categorize";
import { TagCommand, createRealTagBackend } from "./commands/tag";
import { EmbedCommand, createRealEmbedBackend } from "./commands/embed";
import { ContextCommand, createRealContextBackend } from "./commands/context";
import { SyncCommand, createRealSyncBackend } from "./commands/sync";
import { ShareCommand, createRealShareBackend } from "./commands/share";
import { ConsolidateCommand, createRealConsolidateBackend } from "./commands/consolidate";
import { EnrichCommand, createRealEnrichBackend } from "./commands/enrich";

// =============================================================================
// Arg Parsing Helpers
// =============================================================================

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getPositional(args: string[], index: number): string | undefined {
  // Skip flags and their values
  let pos = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++; // skip flag value
      continue;
    }
    if (pos === index) return args[i];
    pos++;
  }
  return undefined;
}

/**
 * Unwraps a new-blueprint CommandResult: prints the error and exits 1 on
 * failure, otherwise returns the data. Bridges the new BaseCommand.run()
 * contract onto this file's existing process.exit(1)-on-error convention.
 */
async function unwrap<T>(result: CommandResult<T>): Promise<T> {
  if (!result.ok) {
    console.error(result.error.message);
    process.exit(1);
  }
  return result.data;
}

// =============================================================================
// Daemon subcommand dispatch
// =============================================================================

async function runDaemonCommand(args: string[]): Promise<void> {
  const sub = args[1];

  if (!sub) {
    // Foreground daemon — never returns until SIGTERM / SIGINT.
    const { runDaemon } = await import("./daemon");
    const daemon = await runDaemon();
    const watched = daemon.watchedAgents.length > 0
      ? daemon.watchedAgents.join(", ")
      : "(none — no agent log dirs found)";
    console.error(`[smriti] daemon started, pid=${daemon.pid}, watching=${watched}`);
    // Block forever; server.ts's signal handlers handle shutdown + exit.
    await new Promise<never>(() => {});
    return;
  }

  if (sub === "install") {
    const { installDaemon } = await import("./daemon/install");
    const result = await installDaemon({ force: hasFlag(args, "--force") });
    console.log(`Service file: ${result.servicePath}`);
    console.log(`  wrote: ${result.wrote}`);
    console.log(`  already registered: ${result.alreadyRegistered}`);
    return;
  }

  if (sub === "uninstall") {
    const { uninstallDaemon } = await import("./daemon/install");
    const result = await uninstallDaemon();
    console.log(`Service file: ${result.servicePath}`);
    console.log(`  removed: ${result.removedFile}`);
    console.log(`  unregistered: ${result.unregistered}`);
    return;
  }

  if (sub === "status") {
    const { getDaemonStatus } = await import("./daemon/client");
    const s = getDaemonStatus();
    if (!s.running) {
      console.log("daemon: not running");
      console.log(`  PID file: ${s.pidFile}`);
      return;
    }
    console.log("daemon: running");
    console.log(`  PID:     ${s.pid}`);
    if (s.startedAt) {
      const uptimeSec = Math.floor((Date.now() - s.startedAt.getTime()) / 1000);
      console.log(`  started: ${s.startedAt.toISOString()}`);
      console.log(`  uptime:  ${formatUptime(uptimeSec)}`);
    }
    return;
  }

  if (sub === "stop") {
    const { stopDaemon } = await import("./daemon/client");
    const r = await stopDaemon();
    if (r.state === "not-running") {
      console.log("daemon: not running");
    } else if (r.state === "stopped") {
      console.log(`daemon: stopped (PID ${r.pid})`);
    } else {
      console.log(`daemon: did not exit in time (PID ${r.pid}). Send SIGKILL manually or retry.`);
      process.exit(1);
    }
    return;
  }

  if (sub === "logs") {
    const { DAEMON_LOG_FILE } = await import("./config");
    const file = Bun.file(DAEMON_LOG_FILE);
    if (!(await file.exists())) {
      console.error(`No log file at ${DAEMON_LOG_FILE}. Has the daemon ever run?`);
      process.exit(1);
    }
    // tail -F follows the file across rotation, which is what LaunchAgents
    // and systemd will do over time.
    const proc = Bun.spawn(["tail", "-F", DAEMON_LOG_FILE], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return;
  }

  console.error(`Unknown daemon subcommand: ${sub}`);
  console.error("Usage: smriti daemon [install|uninstall|status|stop|logs]");
  console.error("       smriti daemon       (run in foreground)");
  process.exit(1);
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// =============================================================================
// Commands
// =============================================================================

const HELP = `
smriti - Unified memory layer for AI agents

Usage:
  smriti <command> [options]

Commands:
  ingest <agent> [options]     Ingest conversations from an agent
  search <query> [filters]     Search across all memory
  recall <query> [options]     Smart recall with optional synthesis
  categorize [options]         Auto-categorize sessions
  tag <session-id> <category>  Manually tag a session
  forget <session-id> [opts]   Delete a session (soft by default; --hard --yes for real deletion)
  forget --all [filters]       Bulk forget, reusing list's --project/--category/--agent filters
  categories                   List category tree
  categories add <id> [opts]   Add a custom category
  tags [options]               Show tag usage in sessions
  context [options]             Generate project context for .smriti/CLAUDE.md
  compare <a> <b>              Compare two sessions (tokens, tools, files)
  compare --last               Compare last 2 sessions for current project
  share [filters]              Export knowledge to .smriti/
  consolidate [options]        Segment dense sessions, promote reused units, prune stale/superseded ones
  learnings [options]          List extracted knowledge units (tier, retrievals, relevance)
  graph <entity>               Show a canonical entity's mentions and relationship edges
  sync                         Import team knowledge from .smriti/
  team                         View team contributions
  list [filters]               List sessions
  show <session-id>            Show session messages
  status                       Memory statistics
  projects [id]                List projects or inspect a project
  insights [subcommand]        Cost & usage analysis dashboard
  embed                        Embed new messages for vector search
  enrich [--density] [--queries] [--clusters] Compute/update density scores, query labels, or clusters
  ask <question>               Answer a question from work history (RAG)
  drift <topic>                Show how thinking on a topic evolved over time
  clusters [options]           Discover topic clusters from session embeddings
  digest [options]             Show work digest for a time window
  config show                  Show current .smriti/config.json
  config add-category <id>     Add a custom category to DB and team config
  daemon [subcommand]          Cross-agent capture daemon (see Daemon options)
  upgrade                      Update smriti to the latest version
  help                         Show this help

Filters (apply to search, recall, list, share):
  --category <id>              Filter by category
  --project <id>               Filter by project
  --agent <id>                 Filter by agent
  --limit <n>                  Max results (default varies by command)

Forget options:
  --hard                        Permanently delete instead of soft delete (requires --yes)
  --yes                         Confirm --hard (required — no confirmation prompt otherwise)
  --purge-shared                With --hard, also delete canonical (promoted) units, their
                                 smriti_shares row, and their .smriti/knowledge/*.md doc

Ingest options:
  smriti ingest claude         Ingest Claude Code sessions
  smriti ingest claude-web <conversations.json>  Claude.ai data export
  smriti ingest claude-web-memory <memories.json> Claude.ai memories
  smriti ingest codex          Ingest Codex CLI sessions
  smriti ingest cline          Ingest Cline CLI sessions
  smriti ingest copilot        Ingest GitHub Copilot (VS Code) sessions
  smriti ingest cursor                    Ingest Cursor sessions (all workspaces)
  smriti ingest cursor --project-path <path>  Filter to a specific project path
  smriti ingest file <path> [--format chat|jsonl] [--title <t>] [--whole]
  smriti ingest all            Ingest from all known agents (claude, codex, cline, copilot)
  --force                      Re-ingest sessions (delete sidecar data, re-extract)
  --whole                      Store file as single document (for .md files)

Search content options:
  --include-thinking           Include thinking blocks in search (opt-in)
  --no-artifacts               Exclude artifacts from search
  --no-attachments             Exclude attachments from search
  --no-voice-notes             Exclude voice notes from search

Recall options:
  --synthesize                 Synthesize results via Ollama
  --model <name>               Ollama model for synthesis
  --max-tokens <n>             Max synthesis tokens
  --fast                       Skip query expansion and reranking
  --wide                       Search all projects (rerank with current project as intent)
  --check-conflicts            Detect contradictions among recall results (opt-in, uses Ollama)
  --cluster <name>             Filter recall to sessions in a named cluster

Context options:
  --project <id>               Project filter (auto-detect from cwd)
  --days <n>                   Lookback window (default: 7)
  --dry-run                    Print to stdout, don't write file

Share options:
  --session <id>               Share specific session
  --output <dir>               Custom output directory
  --no-reflect                 Skip LLM reflections (on by default)
  --reflect-model <name>       Ollama model for reflections
  --segmented                  Use 3-stage segmentation pipeline (beta)
  --min-relevance <float>      Relevance threshold for segmented mode (default: 6)

Consolidate options:
  --prune                      Also run the prune phase (dry-run by default — prints candidates, deletes nothing)
  --yes, --apply                Actually delete/archive prune candidates (requires --prune)
  --prune-stale-days <n>        Age threshold for stale segmented units (default: 30)

Insights options:
  smriti insights                          Full dashboard
  smriti insights session <id>             Session deep dive
  smriti insights project <id>             Project analysis
  smriti insights costs [--days N]         Cost breakdown
  smriti insights errors [--project <id>]  Error analysis
  smriti insights tools [--project <id>]   Tool reliability

Daemon options:
  smriti daemon                            Run daemon in foreground (debugging)
  smriti daemon install [--force]          Install LaunchAgent (macOS) or systemd unit (Linux)
  smriti daemon uninstall                  Reverse install — stop daemon, remove service file
  smriti daemon status                     Show PID, uptime, watched agents
  smriti daemon stop                       Send SIGTERM to the running daemon
  smriti daemon logs                       Tail the daemon log file

Examples:
  smriti ingest claude
  smriti ingest copilot
  smriti search "auth" --project myapp
  smriti recall "how did we set up auth" --synthesize
  smriti categorize
  smriti consolidate
  smriti consolidate --prune
  smriti consolidate --prune --yes
  smriti list --category decision --project myapp
  smriti share --category decision
  smriti sync
  smriti insights --json
  smriti enrich --density
  smriti enrich --queries
  smriti enrich --queries --project myapp --dry-run
  smriti digest
  smriti digest --days 14 --project myapp --synthesize
  smriti upgrade

Enrich options:
  --density                    Recompute density scores for all sessions
  --queries                    Generate search aliases via LLM query expansion
  --dry-run                    Print what would be generated, don't write

Digest options:
  --days <n>                   Lookback window in days (default: 7)
  --project <id>               Filter to a specific project
  --synthesize                 Generate narrative summary via Ollama
  --model <name>               Ollama model for synthesis
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }

  // Handle --version early (doesn't need DB)
  if (command === "--version" || command === "-v") {
    const pkg = require("../package.json");
    console.log(`smriti ${pkg.version}`);
    return;
  }

  // Daemon subcommands — handled before initSmriti() because the foreground
  // daemon opens its own DB handle per flush (smoke-test finding 3).
  if (command === "daemon") {
    await runDaemonCommand(args);
    return;
  }

  // Initialize DB
  const db = await initSmriti();

  try {
    switch (command) {
      // =====================================================================
      // INGEST
      // =====================================================================
      case "ingest": {
        const result = await unwrap(
          await new IngestCommand(createRealIngestBackend(db)).run({ argv: args.slice(1), json: false })
        );

        if (Array.isArray(result)) {
          for (const r of result) {
            console.log(formatIngestResult(r));
            console.log();
          }
        } else {
          console.log(formatIngestResult(result));
        }
        break;
      }

      // =====================================================================
      // SEARCH
      // =====================================================================
      case "search": {
        // SearchCommand.execute() prints its own output (text/json).
        await unwrap(
          await new SearchCommand(createRealSearchBackend(db)).run({ argv: args.slice(1), json: hasFlag(args, "--json") })
        );
        break;
      }

      // =====================================================================
      // RECALL
      // =====================================================================
      case "recall": {
        const isJson = hasFlag(args, "--json");
        const recallProject = getArg(args, "--project");
        const wideMode = hasFlag(args, "--wide");

        const result = await unwrap(
          await new RecallCommand(createRealRecallBackend(db)).run({ argv: args.slice(1), json: isJson })
        );

        // Cross-project badge enrichment (--wide + --project): no home in
        // RecallBackend (recallQuery only returns {results, synthesis}), so
        // this stays here in the bridge, exactly as the original did it -
        // a direct query against smriti_session_meta, not core recall logic.
        if (wideMode && recallProject && result.results.length > 0) {
          const sessionIds = result.results.map((r) => r.session_id);
          const placeholders = sessionIds.map(() => "?").join(",");
          const projRows = db
            .prepare(`SELECT session_id, project_id FROM smriti_session_meta WHERE session_id IN (${placeholders})`)
            .all(...sessionIds) as { session_id: string; project_id: string }[];
          const projMap = new Map(projRows.map((r) => [r.session_id, r.project_id]));
          for (const r of result.results) {
            const proj = projMap.get(r.session_id);
            if (proj && proj !== recallProject && !r.project) {
              r.project = proj;
            }
          }
        }

        if (isJson) {
          console.log(json(result));
        } else {
          console.log(formatSearchResults(result.results));
          if (result.synthesis) {
            console.log("\n--- Synthesis ---\n");
            console.log(result.synthesis);
          }
          if (result.conflicts.length > 0) {
            console.log("\n⚠  Conflicts detected:");
            for (const c of result.conflicts) {
              const a = result.results[c.pair[0] - 1];
              const b = result.results[c.pair[1] - 1];
              console.log(`  [${c.pair[0]}] vs [${c.pair[1]}]: ${c.description}`);
              if (a && b) {
                console.log(`    ${a.session_id} — ${a.session_title || "(untitled)"}`);
                console.log(`    ${b.session_id} — ${b.session_title || "(untitled)"}`);
              }
            }
          }
        }
        break;
      }

      // =====================================================================
      // ASK (RAG question-answering)
      // =====================================================================
      case "ask": {
        const isJson = hasFlag(args, "--json");
        const noSynthesize = hasFlag(args, "--no-synthesize");

        const result = await unwrap(
          await new AskCommand(createRealAskBackend(db)).run({ argv: args.slice(1), json: isJson })
        );

        if (isJson) {
          console.log(json({ question: result.question, sources: result.sources }));
          break;
        }

        if (noSynthesize || result.results.length === 0) {
          console.log(formatSearchResults(result.results));
          break;
        }

        if (result.answer) {
          console.log(result.answer);
          console.log("\nSources:");
          result.results.forEach((r, i) => {
            const date = r.session_id ? new Date(r.session_id).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
            console.log(`  [${i + 1}] ${r.session_id} — ${r.session_title || "(untitled)"}${date ? ` (${date})` : ""}`);
          });
        } else {
          console.log("(Ollama unavailable — returning sources)\n");
          console.log(formatSearchResults(result.results));
        }

        break;
      }

      // =====================================================================
      // CATEGORIZE
      // =====================================================================
      case "categorize": {
        console.log("Categorizing...");
        const result = await unwrap(
          await new CategorizeCommand(createRealCategorizeBackend(db)).run({ argv: args.slice(1), json: false })
        );

        console.log(`Categorized: ${result.categorized}`);
        console.log(`Skipped: ${result.skipped}`);
        break;
      }

      // =====================================================================
      // TAG
      // =====================================================================
      case "tag": {
        const isJson = hasFlag(args, "--json");
        const result = await unwrap(
          await new TagCommand(createRealTagBackend(db)).run({ argv: args.slice(1), json: isJson })
        );

        if (isJson) {
          console.log(json(result));
        } else {
          console.log(`Tagged session ${result.sessionId} with ${result.categoryId}`);
        }
        break;
      }

      // =====================================================================
      // FORGET
      // =====================================================================
      case "forget": {
        const all = hasFlag(args, "--all");
        const sessionId = getPositional(args, 1);
        if (!sessionId && !all) {
          console.error("Usage: smriti forget <session-id> [--hard] [--yes] [--purge-shared]");
          console.error("       smriti forget --all [--project <id>] [--category <id>] [--agent <id>] [--hard] [--yes] [--purge-shared]");
          process.exit(1);
        }

        const hard = hasFlag(args, "--hard");
        const purgeShared = hasFlag(args, "--purge-shared");
        if (hard && !hasFlag(args, "--yes")) {
          console.error("--hard permanently deletes session data. Re-run with --yes to confirm.");
          process.exit(1);
        }

        const targetIds = all
          ? listSessions(db, {
              project: getArg(args, "--project"),
              category: getArg(args, "--category"),
              agent: getArg(args, "--agent"),
              includeInactive: true,
            }).map((s) => s.id)
          : [sessionId!];

        if (targetIds.length === 0) {
          console.log("No matching sessions to forget.");
          break;
        }

        let deleted = 0;
        let purged = 0;
        let kept = 0;
        for (const id of targetIds) {
          const r = forgetSession(db, id, { hard, purgeShared });
          deleted += r.unitsDeleted;
          purged += r.unitsPurged;
          kept += r.canonicalKept;
        }

        console.log(`Forgot ${targetIds.length} session(s) (${hard ? "hard delete" : "soft delete"}).`);
        if (hard) {
          console.log(`  Unpromoted knowledge units removed: ${deleted}`);
          if (purgeShared) {
            console.log(`  Canonical knowledge units purged: ${purged}`);
          } else if (kept > 0) {
            console.log(`  Canonical knowledge units kept (already shared — pass --purge-shared to also remove): ${kept}`);
          }
        }
        break;
      }

      // =====================================================================
      // CATEGORIES
      // =====================================================================
      case "categories": {
        if (args[1] === "add") {
          const added = await unwrap(
            await new CategoriesAddCommand(createRealCategoriesBackend(db)).run({
              argv: args.slice(2),
              json: hasFlag(args, "--json"),
            })
          );
          console.log(`Added category: ${added.id} (${added.name})`);
          break;
        }

        const data = await unwrap(
          await new CategoriesCommand(createRealCategoriesBackend(db)).run({ argv: args.slice(1), json: hasFlag(args, "--json") })
        );
        const lines: string[] = [];
        for (const node of data.tree) {
          lines.push(`${node.id} - ${node.description || node.name}`);
          for (const child of node.children) {
            lines.push(`  ${child.id} - ${child.description || child.name}`);
          }
        }
        console.log(lines.join("\n"));
        break;
      }

      // =====================================================================
      // TAGS
      // =====================================================================
      case "tags": {
        // TagsCommand.execute() prints its own output (both modes, text/json).
        await unwrap(
          await new TagsCommand(createRealTagsBackend(db)).run({ argv: args.slice(1), json: hasFlag(args, "--json") })
        );
        break;
      }

      // =====================================================================
      // CONTEXT
      // =====================================================================
      case "context": {
        const isJson = hasFlag(args, "--json");
        const result = await unwrap(
          await new ContextCommand(createRealContextBackend(db)).run({ argv: args.slice(1), json: isJson })
        );

        if (isJson) {
          console.log(json(result));
        } else if (result.written) {
          console.log(result.context);
          console.log(`\nWritten to ${result.path} (~${result.tokenEstimate} tokens)`);
        } else {
          console.log(result.context);
          if (result.tokenEstimate > 0) {
            console.log(`\n~${result.tokenEstimate} tokens`);
          }
        }
        break;
      }

      // =====================================================================
      // COMPARE
      // =====================================================================
      case "compare": {
        const isJson = hasFlag(args, "--json");
        const result = await unwrap(
          await new CompareCommand(createRealCompareBackend(db)).run({ argv: args.slice(1), json: isJson })
        );
        console.log(isJson ? json(result) : formatCompare(result));
        break;
      }

      // =====================================================================
      // SHARE
      // =====================================================================
      case "share": {
        const result = await unwrap(
          await new ShareCommand(createRealShareBackend(db)).run({ argv: args.slice(1), json: false })
        );

        console.log(formatShareResult(result));
        break;
      }

      // =====================================================================
      // CONSOLIDATE
      // =====================================================================
      case "consolidate": {
        const prune = hasFlag(args, "--prune");
        const pruneApply = hasFlag(args, "--yes") || hasFlag(args, "--apply");
        const result = await unwrap(
          await new ConsolidateCommand(createRealConsolidateBackend(db)).run({ argv: args.slice(1), json: false })
        );

        console.log(formatConsolidateResult(result));
        if (prune && !pruneApply && result.pruneCandidates && result.pruneCandidates.length > 0) {
          console.log("\nRun again with --prune --yes to apply.");
        }
        break;
      }

      // =====================================================================
      // LEARNINGS
      // =====================================================================
      case "learnings": {
        const isJson = hasFlag(args, "--json");
        const units = await unwrap(
          await new LearningsCommand(createRealLearningsBackend(db)).run({ argv: args.slice(1), json: isJson })
        );
        console.log(isJson ? json(units) : formatLearnings(units));
        break;
      }

      // =====================================================================
      // GRAPH
      // =====================================================================
      case "graph": {
        const isJson = hasFlag(args, "--json");
        const data = await unwrap(
          await new GraphCommand(createRealGraphBackend(db)).run({ argv: args.slice(1), json: isJson })
        );
        if (!data.entity) {
          const query = getPositional(args, 1);
          console.log(`No entity found matching "${query}".`);
          break;
        }
        console.log(isJson ? json(data) : formatEntityGraph(data.entity, data.units, data.edges));
        break;
      }

      // =====================================================================
      // SYNC
      // =====================================================================
      case "sync": {
        const result = await unwrap(
          await new SyncCommand(createRealSyncBackend(db)).run({ argv: args.slice(1), json: false })
        );

        console.log(formatSyncResult(result));
        break;
      }

      // =====================================================================
      // TEAM
      // =====================================================================
      case "team": {
        // Original never branches on --json for this command - faithfully unchanged.
        const data = await unwrap(
          await new TeamCommand(createRealTeamBackend(db)).run({ argv: args.slice(1), json: hasFlag(args, "--json") })
        );
        console.log(formatTeamContributions(data.contributions));
        break;
      }

      // =====================================================================
      // LIST
      // =====================================================================
      case "list": {
        const isJson = hasFlag(args, "--json");
        const data = await unwrap(
          await new ListCommand(createRealListBackend(db)).run({ argv: args.slice(1), json: isJson })
        );
        console.log(isJson ? json(data.sessions) : formatSessionList(data.sessions));
        break;
      }

      // =====================================================================
      // SHOW
      // =====================================================================
      case "show": {
        const isJson = hasFlag(args, "--json");
        const data = await unwrap(
          await new ShowCommand(createRealShowBackend(db)).run({ argv: args.slice(1), json: isJson })
        );
        console.log(`Session: ${data.session.title || data.session.id}`);
        console.log(`Created: ${data.session.created_at}`);
        if (data.session.summary) {
          console.log(`Summary: ${data.session.summary}`);
        }
        console.log("---");
        if (isJson) {
          console.log(json(data.messages));
        } else {
          for (const msg of data.messages) {
            console.log(`\n${msg.role}: ${msg.content}`);
          }
        }
        break;
      }

      // =====================================================================
      // STATUS
      // =====================================================================
      case "status": {
        const isJson = hasFlag(args, "--json");
        const data = await unwrap(
          await new StatusCommand(createRealStatusBackend(db)).run({ argv: args.slice(1), json: isJson })
        );
        console.log(isJson ? json(data) : formatStatus(data));
        break;
      }

      // =====================================================================
      // PROJECTS
      // =====================================================================
      case "projects": {
        const isJson = hasFlag(args, "--json");
        const data = await unwrap(
          await new ProjectsCommand(createRealProjectsBackend(db)).run({ argv: args.slice(1), json: isJson })
        );

        if ("report" in data) {
          if (isJson) {
            console.log(json(data.report));
          } else {
            console.log(
              formatProjectReport(data.report, {
                tagsOnly: data.format === "tags",
                decisionsOnly: data.format === "decisions",
              })
            );
          }
          break;
        }

        if (data.projects.length === 0) {
          console.log("No projects registered. Run 'smriti ingest' first.");
          break;
        }
        if (isJson) {
          console.log(json(data.projects));
        } else {
          for (const p of data.projects) {
            console.log(`${p.id} - ${p.path || "(no path)"}`);
            if (p.description) console.log(`  ${p.description}`);
          }
        }
        break;
      }

      // =====================================================================
      // EMBED
      // =====================================================================
      case "embed": {
        console.log("Embedding new messages...");
        const result = await unwrap(
          await new EmbedCommand(createRealEmbedBackend(db)).run({ argv: args.slice(1), json: false })
        );

        console.log(`Embedded ${result.count} new messages.`);
        break;
      }

      // =====================================================================
      // UPGRADE
      // =====================================================================
      case "upgrade": {
        const { SMRITI_HOME } = await import("./config");
        const { existsSync } = await import("fs");

        if (!existsSync(SMRITI_HOME)) {
          console.error(`smriti install directory not found: ${SMRITI_HOME}`);
          console.error("If you installed smriti manually, set SMRITI_HOME in your environment.");
          process.exit(1);
        }

        console.log(`Upgrading smriti in ${SMRITI_HOME}...`);

        // git pull
        const pull = Bun.spawnSync(["git", "pull", "--ff-only"], { cwd: SMRITI_HOME });
        const pullOut = pull.stdout.toString().trim();
        const pullErr = pull.stderr.toString().trim();
        if (pull.exitCode !== 0) {
          console.error("git pull failed:");
          console.error(pullErr || pullOut);
          process.exit(1);
        }
        console.log(pullOut || "Already up to date.");

        // bun install (pick up any new dependencies)
        console.log("Installing dependencies...");
        const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: SMRITI_HOME });
        if (install.exitCode !== 0) {
          // Retry without frozen lockfile (lockfile may have been updated)
          Bun.spawnSync(["bun", "install"], { cwd: SMRITI_HOME });
        }

        console.log("Done. smriti is up to date.");
        break;
      }

      // =====================================================================
      // INIT (Project initialization with language detection)
      // =====================================================================
      case "init": {
        const projectPath = args[1] || process.cwd();
        const forceDetection = hasFlag(args, "--force");
        const overrideLanguage = getArg(args, "--language");
        const dryRun = hasFlag(args, "--dry-run");

        console.log(`Initializing Smriti for project: ${projectPath}`);

        // TODO: Implement in Phase 1 completion
        console.log("(This feature is coming in Phase 1 completion)");
        break;
      }

      // =====================================================================
      // RULES (Rule management)
      // =====================================================================
      case "rules": {
        const subcommand = args[1];

        if (!subcommand || subcommand === "list") {
          // TODO: Implement in Phase 1 completion
          console.log("Available rules: (coming soon)");
          break;
        } else if (subcommand === "add") {
          const id = args[2];
          const pattern = args[3];
          const category = args[4];

          if (!id || !pattern || !category) {
            console.error(
              "Usage: smriti rules add <id> <pattern> <category> [--weight <w>] [--description <desc>]"
            );
            process.exit(1);
          }

          // TODO: Implement in Phase 1 completion
          console.log("(This feature is coming in Phase 1 completion)");
          break;
        } else if (subcommand === "validate") {
          const filePath = args[2] || ".smriti/rules/custom.yml";

          // TODO: Implement in Phase 1 completion
          console.log(`Validating rules from ${filePath}...`);
          console.log("(This feature is coming in Phase 1 completion)");
          break;
        } else if (subcommand === "update") {
          // TODO: Implement in Phase 1 completion
          console.log("Checking for rule updates...");
          console.log("(This feature is coming in Phase 1 completion)");
          break;
        } else {
          console.error("Unknown rules subcommand. Use: list, add, validate, update");
          process.exit(1);
        }
      }

      // =====================================================================
      // INSIGHTS
      // =====================================================================
      case "insights": {
        const sub = args[1];
        const useJson = hasFlag(args, "--json");

        if (sub === "session") {
          const report = await unwrap(
            await new InsightsSessionCommand(createRealInsightsSessionBackend(db)).run({ argv: args.slice(2), json: useJson })
          );
          console.log(useJson ? json(report) : formatSessionInsights(report));
        } else if (sub === "project") {
          const report = await unwrap(
            await new InsightsProjectCommand(createRealInsightsProjectBackend(db)).run({ argv: args.slice(2), json: useJson })
          );
          console.log(useJson ? json(report) : formatProjectInsights(report));
        } else if (sub === "costs") {
          const report = await unwrap(
            await new InsightsCostsCommand(createRealInsightsCostsBackend(db)).run({ argv: args.slice(2), json: useJson })
          );
          console.log(useJson ? json(report) : formatCostBreakdown(report));
        } else if (sub === "errors") {
          const report = await unwrap(
            await new InsightsErrorsCommand(createRealInsightsErrorsBackend(db)).run({ argv: args.slice(2), json: useJson })
          );
          console.log(useJson ? json(report) : formatErrorAnalysis(report));
        } else if (sub === "tools") {
          const report = await unwrap(
            await new InsightsToolsCommand(createRealInsightsToolsBackend(db)).run({ argv: args.slice(2), json: useJson })
          );
          console.log(useJson ? json(report) : formatToolStats(report));
        } else {
          // Default: full dashboard. Matches the real CLI's lenient dispatch -
          // any unrecognized sub (not just an absent one) falls through here too.
          const result = await unwrap(
            await new InsightsCommand(
              createRealInsightsOverviewBackend(db),
              createRealInsightsRecommendationsBackend(db)
            ).run({ argv: args.slice(1), json: useJson })
          );
          console.log(useJson ? json(result) : formatOverview(result, result.recommendations));
        }
        break;
      }

      // =====================================================================
      // ENRICH
      // =====================================================================
      case "enrich": {
        // EnrichCommand.execute() prints its own progress inline (mirrors
        // ingest/categorize) - nothing else to render here.
        await unwrap(
          await new EnrichCommand(createRealEnrichBackend(db)).run({ argv: args.slice(1), json: false })
        );
        break;
      }

      // =====================================================================
      // CLUSTERS
      // =====================================================================
      case "clusters": {
        console.log("Clustering sessions...");
        const clusterResult = await unwrap(
          await new ClustersCommand(createRealClustersBackend(db)).run({ argv: args.slice(1), json: hasFlag(args, "--json") })
        );

        if (clusterResult.clusters.length === 0) {
          console.log("Not enough sessions with embeddings to cluster.");
          console.log("Run 'smriti embed' first to build embeddings, then re-run.");
          break;
        }

        if (hasFlag(args, "--json")) {
          console.log(json(clusterResult));
          break;
        }

        console.log(`\n${clusterResult.clusters.length} clusters across ${clusterResult.totalSessions} sessions\n`);
        for (const c of clusterResult.clusters) {
          const lastActive = c.lastActive ? new Date(c.lastActive).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
          console.log(`  ${c.name}`);
          console.log(`    ${c.sessionIds.length} session${c.sessionIds.length === 1 ? "" : "s"}${lastActive ? `  · last active ${lastActive}` : ""}`);
        }
        break;
      }

      // =====================================================================
      // DRIFT (temporal evolution)
      // =====================================================================
      case "drift": {
        const isJson = hasFlag(args, "--json");
        const driftProject = getArg(args, "--project");

        const result = await unwrap(
          await new DriftCommand(createRealDriftBackend(db)).run({ argv: args.slice(1), json: isJson })
        );

        if (result.insufficientHistory) {
          console.log("Not enough history to show evolution.");
          if (result.rawResults && result.rawResults.length === 1) {
            console.log(formatSearchResults(result.rawResults));
          }
          break;
        }

        if (isJson) {
          console.log(json({ topic: result.topic, timeline: result.timeline }));
          break;
        }

        console.log(`\n${result.topic} — evolution across ${result.timeline.length} session${result.timeline.length === 1 ? "" : "s"}\n`);
        const timelineText = result.timeline.map(entry => {
          const date = entry.date ? new Date(entry.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
          const proj = entry.project ? ` [${entry.project}]` : (driftProject ? ` [${driftProject}]` : "");
          return `${date}${proj}  ${entry.session_title || entry.session_id}\n  ${entry.content.slice(0, 200)}`;
        }).join("\n\n");

        console.log(timelineText);

        if (result.narrative !== undefined) {
          console.log("\n--- Evolution narrative ---\n");
          console.log(result.narrative);
        }

        break;
      }

      // =====================================================================
      // DIGEST
      // =====================================================================
      case "digest": {
        const isJson = hasFlag(args, "--json");
        const report = await unwrap(
          await new DigestCommand(createRealDigestBackend(db)).run({ argv: args.slice(1), json: isJson })
        );
        console.log(isJson ? json(report) : formatDigest(report));
        break;
      }

      // =====================================================================
      // CONFIG (team config.json management)
      // =====================================================================
      case "config": {
        const { readConfig, writeConfig, exportCustomCategories } = await import("./team/config");
        const sub = args[1];
        const smritiDir = (() => {
          const project = getArg(args, "--project");
          if (project) {
            const p = db.prepare(`SELECT path FROM smriti_projects WHERE id = ?`).get(project) as { path: string } | null;
            if (p?.path) return require("path").join(p.path, ".smriti");
          }
          return require("path").join(process.cwd(), ".smriti");
        })();

        if (!sub || sub === "show") {
          const config = readConfig(smritiDir);
          if (hasFlag(args, "--json")) {
            console.log(json(config));
          } else {
            console.log(`Config: ${smritiDir}/config.json`);
            console.log(`  version: ${config.version}`);
            const cats = config.categories ?? [];
            if (cats.length > 0) {
              console.log(`  custom categories (${cats.length}):`);
              for (const c of cats) {
                console.log(`    ${c.id}${c.parent ? ` (parent: ${c.parent})` : ""}  — ${c.name}`);
              }
            } else {
              console.log("  custom categories: none");
            }
          }
        } else if (sub === "add-category") {
          const id = args[2];
          const name = getArg(args, "--name");
          if (!id || !name) {
            console.error("Usage: smriti config add-category <id> --name <name> [--parent <parent>] [--description <desc>] [--project <id>]");
            process.exit(1);
          }
          const parent = getArg(args, "--parent");
          const description = getArg(args, "--description");

          // Add to local DB
          const { addCategory } = await import("./db");
          addCategory(db, id, name, parent, description);
          console.log(`Added category: ${id} (${name})`);

          // Write to config.json
          const { mkdirSync } = await import("fs");
          mkdirSync(smritiDir, { recursive: true });
          const config = readConfig(smritiDir);
          const categories = config.categories ?? [];
          if (!categories.find(c => c.id === id)) {
            categories.push({ id, name, ...(parent ? { parent } : {}), ...(description ? { description } : {}) });
          }
          await writeConfig(smritiDir, { ...config, version: 2, categories });
          console.log(`Written to ${smritiDir}/config.json`);
        } else if (sub === "sync-categories") {
          // Export current DB custom categories into config.json
          const { mkdirSync } = await import("fs");
          mkdirSync(smritiDir, { recursive: true });
          const config = readConfig(smritiDir);
          const categories = exportCustomCategories(db);
          await writeConfig(smritiDir, { ...config, version: categories.length > 0 ? 2 : config.version, categories });
          console.log(`Synced ${categories.length} custom category${categories.length === 1 ? "" : "ies"} to ${smritiDir}/config.json`);
        } else {
          console.error(`Unknown config subcommand: ${sub}`);
          console.error("Usage: smriti config show | add-category | sync-categories");
          process.exit(1);
        }
        break;
      }

      // =====================================================================
      // UNKNOWN
      // =====================================================================
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run 'smriti help' for usage.");
        process.exit(1);
    }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
