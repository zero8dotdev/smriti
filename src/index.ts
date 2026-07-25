#!/usr/bin/env bun
/**
 * index.ts - Smriti CLI entry point
 *
 * Unified memory layer across all AI agents.
 * Builds on QMD's memory infrastructure with multi-agent ingestion,
 * schema-based categorization, and team knowledge sharing.
 */

import { initSmriti, closeDb, getCategories, getCategoryTree, addCategory, listProjects, tagSession, getProjectReport, getTagUsage, computeDensityScore, updateDensityScore, insertSessionQueries, getUnenrichedSessionIds, listKnowledgeUnits } from "./db";
import { getMessages, getSession, getMemoryStatus, embedMemoryMessages } from "./qmd";
import { ingest, ingestAll } from "./ingest/index";
import { categorizeUncategorized } from "./categorize/classifier";
import { formatCategoryTree as schemaFormatCategoryTree, isValidCategory } from "./categorize/schema";
import { searchFiltered, listSessions } from "./search/index";
import { recall } from "./search/recall";
import { shareKnowledge } from "./team/share";
import { syncTeamKnowledge, listTeamContributions } from "./team/sync";
import { consolidateKnowledge } from "./learn/consolidate";
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
  json,
} from "./format";
import { generateDigest } from "./digest";
import { ollamaAsk, ollamaDrift, ollamaCheckConflicts } from "./ollama";
import { clusterSessions, getClusterSessionIds } from "./cluster";

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
  categories                   List category tree
  categories add <id> [opts]   Add a custom category
  tags [options]               Show tag usage in sessions
  context [options]             Generate project context for .smriti/CLAUDE.md
  compare <a> <b>              Compare two sessions (tokens, tools, files)
  compare --last               Compare last 2 sessions for current project
  share [filters]              Export knowledge to .smriti/
  consolidate [options]        Segment dense sessions, promote reused knowledge units
  learnings [options]          List extracted knowledge units (tier, retrievals, relevance)
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
        const agent = args[1];
        if (!agent) {
          console.error("Usage: smriti ingest <agent>");
          console.error("Agents: claude, codex, cursor, cline, copilot, claude-web, file, all");
          process.exit(1);
        }

        if (agent === "all") {
          const results = await ingestAll(db, {
            onProgress: (msg) => console.log(`  ${msg}`),
          });
          for (const r of results) {
            console.log(formatIngestResult(r));
            console.log();
          }
          break;
        }

        const filePath = args[2] && !args[2].startsWith("--") ? args[2] : getArg(args, "--file");
        const isMarkdown = filePath?.endsWith(".md");
        const whole = hasFlag(args, "--whole");

        // Warn if .md file is being ingested without --whole
        if (isMarkdown && !whole) {
          console.warn(
            "⚠️  Warning: ingesting .md file as chat format splits paragraphs into separate messages. " +
              "Use --whole to store as a single document."
          );
        }

        const result = await ingest(db, agent, {
          onProgress: (msg) => console.log(`  ${msg}`),
          projectPath: getArg(args, "--project-path"),
          filePath,
          format: getArg(args, "--format") as "chat" | "jsonl" | undefined,
          title: getArg(args, "--title"),
          sessionId: getArg(args, "--session"),
          projectId: getArg(args, "--project"),
          force: hasFlag(args, "--force"),
          whole,
        });

        console.log(formatIngestResult(result));
        break;
      }

      // =====================================================================
      // SEARCH
      // =====================================================================
      case "search": {
        const query = args[1];
        if (!query) {
          console.error("Usage: smriti search <query> [filters]");
          process.exit(1);
        }

        const results = searchFiltered(db, query, {
          category: getArg(args, "--category"),
          project: getArg(args, "--project"),
          agent: getArg(args, "--agent"),
          limit: Number(getArg(args, "--limit")) || undefined,
          includeThinking: hasFlag(args, "--include-thinking"),
          includeArtifacts: !hasFlag(args, "--no-artifacts"),
          includeAttachments: !hasFlag(args, "--no-attachments"),
          includeVoiceNotes: !hasFlag(args, "--no-voice-notes"),
        });

        if (hasFlag(args, "--json")) {
          console.log(json(results));
        } else {
          console.log(formatSearchResults(results));
        }
        break;
      }

      // =====================================================================
      // RECALL
      // =====================================================================
      case "recall": {
        const query = args[1];
        if (!query) {
          console.error("Usage: smriti recall <query> [options]");
          process.exit(1);
        }

        const recallProject = getArg(args, "--project");
        const wideMode = hasFlag(args, "--wide");
        const clusterFilter = getArg(args, "--cluster");
        const clusterSessionIds = clusterFilter ? getClusterSessionIds(db, clusterFilter) : null;

        if (clusterFilter && clusterSessionIds !== null && clusterSessionIds.length === 0) {
          console.error(`No sessions found for cluster: ${clusterFilter}`);
          console.error("Run 'smriti clusters' to see available clusters.");
          process.exit(1);
        }

        const result = await recall(db, query, {
          category: getArg(args, "--category"),
          project: recallProject || undefined,
          agent: getArg(args, "--agent"),
          limit: Number(getArg(args, "--limit")) || undefined,
          synthesize: hasFlag(args, "--synthesize"),
          model: getArg(args, "--model"),
          maxTokens: Number(getArg(args, "--max-tokens")) || undefined,
          includeThinking: hasFlag(args, "--include-thinking"),
          includeArtifacts: !hasFlag(args, "--no-artifacts"),
          includeAttachments: !hasFlag(args, "--no-attachments"),
          includeVoiceNotes: !hasFlag(args, "--no-voice-notes"),
          fast: hasFlag(args, "--fast"),
          wide: wideMode,
        });

        // Apply --cluster filter: keep only sessions belonging to the cluster
        if (clusterSessionIds && clusterSessionIds.length > 0) {
          const clusterSet = new Set(clusterSessionIds);
          result.results = result.results.filter(r => clusterSet.has(r.session_id));
        }

        const checkConflicts = hasFlag(args, "--check-conflicts");

        // In --wide mode, look up project info for cross-project badge
        if (wideMode && recallProject && result.results.length > 0) {
          const sessionIds = result.results.map(r => r.session_id);
          const placeholders = sessionIds.map(() => "?").join(",");
          const projRows = db.prepare(
            `SELECT session_id, project_id FROM smriti_session_meta WHERE session_id IN (${placeholders})`
          ).all(...sessionIds) as { session_id: string; project_id: string }[];
          const projMap = new Map(projRows.map(r => [r.session_id, r.project_id]));
          for (const r of result.results) {
            const proj = projMap.get(r.session_id);
            if (proj && proj !== recallProject && !(r as any).project) {
              (r as any).project = proj;
            }
          }
        }

        // Contradiction detection (opt-in)
        let conflicts: { pair: [number, number]; description: string }[] = [];
        if (checkConflicts && result.results.length >= 2) {
          const passages = result.results.slice(0, 5).map((r, i) => ({
            n: i + 1,
            title: r.session_title || r.session_id,
            content: r.content,
          }));
          try {
            conflicts = await ollamaCheckConflicts(query, passages);
          } catch {
            // Ollama unavailable — skip conflict detection
          }
        }

        if (hasFlag(args, "--json")) {
          console.log(json({ ...result, conflicts }));
        } else {
          console.log(formatSearchResults(result.results));
          if (result.synthesis) {
            console.log("\n--- Synthesis ---\n");
            console.log(result.synthesis);
          }
          if (conflicts.length > 0) {
            console.log("\n⚠  Conflicts detected:");
            for (const c of conflicts) {
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
        const question = args[1];
        if (!question) {
          console.error('Usage: smriti ask "<question>" [options]');
          process.exit(1);
        }

        const noSynthesize = hasFlag(args, "--no-synthesize");
        const askLimit = Number(getArg(args, "--limit")) || 5;
        const askModel = getArg(args, "--model");
        const askProject = getArg(args, "--project");
        const askAgent = getArg(args, "--agent");

        // Multi-angle recall (expandQuery + rerank already default-on)
        const askResult = await recall(db, question, {
          limit: askLimit,
          synthesize: false,
          project: askProject || undefined,
          agent: askAgent || undefined,
          fast: false,
        });

        if (hasFlag(args, "--json")) {
          const sources = askResult.results.map((r, i) => ({
            n: i + 1,
            session_id: r.session_id,
            session_title: r.session_title,
            score: r.score,
            content: r.content,
          }));
          console.log(json({ question, sources }));
          break;
        }

        if (noSynthesize || askResult.results.length === 0) {
          console.log(formatSearchResults(askResult.results));
          break;
        }

        // Format sources for Ollama
        const sourcesText = askResult.results
          .map((r, i) => `[${i + 1}] ${r.session_title || r.session_id}\n${r.content}`)
          .join("\n\n---\n\n");

        let answer: string | undefined;
        try {
          answer = await ollamaAsk(question, sourcesText, { model: askModel || undefined });
        } catch {
          answer = undefined;
        }

        if (answer) {
          console.log(answer);
          console.log("\nSources:");
          askResult.results.forEach((r, i) => {
            const date = r.session_id ? new Date(r.session_id).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
            console.log(`  [${i + 1}] ${r.session_id} — ${r.session_title || "(untitled)"}${date ? ` (${date})` : ""}`);
          });
        } else {
          console.log("(Ollama unavailable — returning sources)\n");
          console.log(formatSearchResults(askResult.results));
        }

        break;
      }

      // =====================================================================
      // CATEGORIZE
      // =====================================================================
      case "categorize": {
        const sessionId = getArg(args, "--session");
        const useLLM = hasFlag(args, "--llm");

        console.log("Categorizing...");
        const result = await categorizeUncategorized(db, {
          sessionId,
          useLLM,
          onProgress: (msg) => console.log(`  ${msg}`),
        });

        console.log(`Categorized: ${result.categorized}`);
        console.log(`Skipped: ${result.skipped}`);
        break;
      }

      // =====================================================================
      // TAG
      // =====================================================================
      case "tag": {
        const sessionId = args[1];
        const categoryId = args[2];
        if (!sessionId || !categoryId) {
          console.error("Usage: smriti tag <session-id> <category>");
          process.exit(1);
        }

        if (!isValidCategory(db, categoryId)) {
          console.error(`Invalid category: ${categoryId}`);
          console.error("Run 'smriti categories' to see available categories.");
          process.exit(1);
        }

        tagSession(db, sessionId, categoryId, 1.0, "manual");
        console.log(`Tagged session ${sessionId} with ${categoryId}`);
        break;
      }

      // =====================================================================
      // CATEGORIES
      // =====================================================================
      case "categories": {
        if (args[1] === "add") {
          const id = args[2];
          const name = getArg(args, "--name");
          const parentId = getArg(args, "--parent");
          const description = getArg(args, "--description");

          if (!id || !name) {
            console.error(
              "Usage: smriti categories add <id> --name <name> [--parent <parent>] [--description <desc>]"
            );
            process.exit(1);
          }

          addCategory(db, id, name, parentId, description);
          console.log(`Added category: ${id} (${name})`);
          break;
        }

        const tree = getCategoryTree(db);
        const allCats = getCategories(db);
        console.log(
          formatCategoryTree(
            tree,
            allCats.map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description,
            }))
          )
        );
        break;
      }

      // =====================================================================
      // TAGS
      // =====================================================================
      case "tags": {
        const showAvailable = hasFlag(args, "--available");

        if (showAvailable) {
          // Show all available categories (same as categories command)
          const tree = getCategoryTree(db);
          const allCats = getCategories(db);
          console.log(
            formatCategoryTree(
              tree,
              allCats.map((c) => ({
                id: c.id,
                name: c.name,
                description: c.description,
              }))
            )
          );
          break;
        }

        // Show tag usage
        const projectFilter = getArg(args, "--project");
        const usage = getTagUsage(db, projectFilter);

        if (hasFlag(args, "--json")) {
          console.log(json(usage));
        } else {
          console.log(formatTagUsage(usage, projectFilter));
          if (usage.length > 0) {
            console.log("");
            console.log("Run 'smriti tags --available' to see all available categories.");
          }
        }
        break;
      }

      // =====================================================================
      // CONTEXT
      // =====================================================================
      case "context": {
        const result = await generateContext(db, {
          project: getArg(args, "--project"),
          days: Number(getArg(args, "--days")) || undefined,
          dryRun: hasFlag(args, "--dry-run"),
          json: hasFlag(args, "--json"),
        });

        if (hasFlag(args, "--json")) {
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
        let idA: string | null = null;
        let idB: string | null = null;

        if (hasFlag(args, "--last")) {
          // Compare last 2 sessions for the detected project
          const projectId = getArg(args, "--project") || (() => {
            const { detectProject } = require("./context");
            return detectProject(db);
          })();
          const recent = recentSessionIds(db, 2, projectId);
          if (recent.length < 2) {
            console.error("Need at least 2 sessions to compare. Run 'smriti ingest' first.");
            process.exit(1);
          }
          idA = recent[1]; // older
          idB = recent[0]; // newer
        } else {
          const rawA = args[1];
          const rawB = args[2];
          if (!rawA || !rawB) {
            console.error("Usage: smriti compare <session-a> <session-b>");
            console.error("       smriti compare --last [--project <id>]");
            process.exit(1);
          }
          idA = resolveSessionId(db, rawA);
          idB = resolveSessionId(db, rawB);
          if (!idA) {
            console.error(`Could not resolve session: ${rawA}`);
            process.exit(1);
          }
          if (!idB) {
            console.error(`Could not resolve session: ${rawB}`);
            process.exit(1);
          }
        }

        const result = compareSessions(db, idA!, idB!);

        if (hasFlag(args, "--json")) {
          console.log(json(result));
        } else {
          console.log(formatCompare(result));
        }
        break;
      }

      // =====================================================================
      // SHARE
      // =====================================================================
      case "share": {
        const result = await shareKnowledge(db, {
          category: getArg(args, "--category"),
          project: getArg(args, "--project"),
          sessionId: getArg(args, "--session"),
          outputDir: getArg(args, "--output"),
          reflect: !hasFlag(args, "--no-reflect"),
          reflectModel: getArg(args, "--reflect-model"),
          segmented: hasFlag(args, "--segmented"),
          minRelevance: Number(getArg(args, "--min-relevance")) || undefined,
        });

        console.log(formatShareResult(result));
        break;
      }

      // =====================================================================
      // CONSOLIDATE
      // =====================================================================
      case "consolidate": {
        const result = await consolidateKnowledge(db, {
          minDensity: Number(getArg(args, "--min-density")) || undefined,
          minRetrievals: Number(getArg(args, "--min-retrievals")) || undefined,
          minRelevance: Number(getArg(args, "--min-relevance")) || undefined,
          model: getArg(args, "--model"),
          outputDir: getArg(args, "--output"),
          sessionLimit: Number(getArg(args, "--session-limit")) || undefined,
          onProgress: (msg) => console.log(`  ${msg}`),
        });

        console.log(formatConsolidateResult(result));
        break;
      }

      // =====================================================================
      // LEARNINGS
      // =====================================================================
      case "learnings": {
        const units = listKnowledgeUnits(db, {
          tier: getArg(args, "--tier") as "segmented" | "canonical" | undefined,
          minRetrievals: Number(getArg(args, "--min-retrievals")) || undefined,
          limit: Number(getArg(args, "--limit")) || 50,
        });

        if (hasFlag(args, "--json")) {
          console.log(json(units));
        } else {
          console.log(formatLearnings(units));
        }
        break;
      }

      // =====================================================================
      // SYNC
      // =====================================================================
      case "sync": {
        const result = await syncTeamKnowledge(db, {
          inputDir: getArg(args, "--input"),
          project: getArg(args, "--project"),
        });

        console.log(formatSyncResult(result));
        break;
      }

      // =====================================================================
      // TEAM
      // =====================================================================
      case "team": {
        const contributions = listTeamContributions(db);
        console.log(formatTeamContributions(contributions));
        break;
      }

      // =====================================================================
      // LIST
      // =====================================================================
      case "list": {
        const sessions = listSessions(db, {
          category: getArg(args, "--category"),
          project: getArg(args, "--project"),
          agent: getArg(args, "--agent"),
          limit: Number(getArg(args, "--limit")) || undefined,
          includeInactive: hasFlag(args, "--all"),
        });

        if (hasFlag(args, "--json")) {
          console.log(json(sessions));
        } else {
          console.log(formatSessionList(sessions));
        }
        break;
      }

      // =====================================================================
      // SHOW
      // =====================================================================
      case "show": {
        const sessionId = args[1];
        if (!sessionId) {
          console.error("Usage: smriti show <session-id>");
          process.exit(1);
        }

        const session = getSession(db, sessionId);
        if (!session) {
          console.error(`Session not found: ${sessionId}`);
          process.exit(1);
        }

        console.log(`Session: ${session.title || session.id}`);
        console.log(`Created: ${session.created_at}`);
        if (session.summary) {
          console.log(`Summary: ${session.summary}`);
        }
        console.log("---");

        const limit = Number(getArg(args, "--limit")) || undefined;
        const messages = getMessages(db, sessionId, { limit });

        if (hasFlag(args, "--json")) {
          console.log(json(messages));
        } else {
          for (const msg of messages) {
            console.log(`\n${msg.role}: ${msg.content}`);
          }
        }
        break;
      }

      // =====================================================================
      // STATUS
      // =====================================================================
      case "status": {
        const baseStatus = getMemoryStatus(db);
        const projectFilter = getArg(args, "--project");

        // Get Smriti-specific counts
        const agentCounts: Record<string, number> = {};
        const agentQuery = projectFilter
          ? `SELECT sm.agent_id, COUNT(*) as count FROM smriti_session_meta sm
             WHERE sm.agent_id IS NOT NULL AND sm.project_id = ?
             GROUP BY sm.agent_id`
          : `SELECT agent_id, COUNT(*) as count FROM smriti_session_meta
             WHERE agent_id IS NOT NULL GROUP BY agent_id`;
        const agentRows = (
          projectFilter
            ? db.prepare(agentQuery).all(projectFilter)
            : db.prepare(agentQuery).all()
        ) as { agent_id: string; count: number }[];
        for (const row of agentRows) {
          agentCounts[row.agent_id] = row.count;
        }

        const projectCounts: Record<string, number> = {};
        if (!projectFilter) {
          const projectRows = db
            .prepare(
              `SELECT project_id, COUNT(*) as count FROM smriti_session_meta
               WHERE project_id IS NOT NULL GROUP BY project_id`
            )
            .all() as { project_id: string; count: number }[];
          for (const row of projectRows) {
            projectCounts[row.project_id] = row.count;
          }
        }

        const categoryCounts: Record<string, number> = {};
        const catQuery = projectFilter
          ? `SELECT st.category_id, COUNT(*) as count FROM smriti_session_tags st
             JOIN smriti_session_meta sm ON st.session_id = sm.session_id
             WHERE sm.project_id = ?
             GROUP BY st.category_id ORDER BY count DESC`
          : `SELECT category_id, COUNT(*) as count FROM smriti_session_tags
             GROUP BY category_id ORDER BY count DESC`;
        const catRows = (
          projectFilter
            ? db.prepare(catQuery).all(projectFilter)
            : db.prepare(catQuery).all()
        ) as { category_id: string; count: number }[];
        for (const row of catRows) {
          categoryCounts[row.category_id] = row.count;
        }

        const output = { ...baseStatus, agentCounts, projectCounts, categoryCounts };
        if (projectFilter && !hasFlag(args, "--json")) {
          (output as any).projectFilter = projectFilter;
        }

        if (hasFlag(args, "--json")) {
          console.log(json(output));
        } else {
          console.log(
            formatStatus(output as any)
          );
        }
        break;
      }

      // =====================================================================
      // PROJECTS
      // =====================================================================
      case "projects": {
        // Check if a project ID is specified (inspect single project)
        const projectId = args[1];
        if (projectId && !projectId.startsWith("--")) {
          const report = getProjectReport(db, projectId);
          if (!report) {
            console.error(`Project not found: ${projectId}`);
            process.exit(1);
          }

          if (hasFlag(args, "--json")) {
            console.log(json(report));
          } else {
            const tagsOnly = hasFlag(args, "--tags");
            const decisionsOnly = hasFlag(args, "--decisions");
            console.log(formatProjectReport(report, { tagsOnly, decisionsOnly }));
          }
          break;
        }

        // List all projects
        const projects = listProjects(db);
        if (projects.length === 0) {
          console.log("No projects registered. Run 'smriti ingest' first.");
          break;
        }

        if (hasFlag(args, "--json")) {
          console.log(json(projects));
        } else {
          for (const p of projects) {
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
        const count = await embedMemoryMessages(db, {
          onProgress: (msg: string) => console.log(`  ${msg}`),
        });

        console.log(`Embedded ${count} new messages.`);
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
          const id = args[2];
          if (!id) {
            console.error("Usage: smriti insights session <session-id>");
            process.exit(1);
          }
          const report = getSessionInsights(db, id);
          if (!report) {
            console.error(`Session not found: ${id}`);
            process.exit(1);
          }
          console.log(useJson ? json(report) : formatSessionInsights(report));
        } else if (sub === "project") {
          const id = args[2];
          if (!id) {
            console.error("Usage: smriti insights project <project-id>");
            process.exit(1);
          }
          const report = getProjectInsights(db, id);
          if (!report) {
            console.error(`Project not found or has no data: ${id}`);
            process.exit(1);
          }
          console.log(useJson ? json(report) : formatProjectInsights(report));
        } else if (sub === "costs") {
          const days = Number(getArg(args, "--days")) || undefined;
          const report = getCostBreakdown(db, { days });
          console.log(useJson ? json(report) : formatCostBreakdown(report));
        } else if (sub === "errors") {
          const project = getArg(args, "--project");
          const report = getErrorAnalysis(db, { project });
          console.log(useJson ? json(report) : formatErrorAnalysis(report));
        } else if (sub === "tools") {
          const project = getArg(args, "--project");
          const report = getToolStats(db, { project });
          console.log(useJson ? json(report) : formatToolStats(report));
        } else {
          // Default: full dashboard
          const overview = getOverview(db);
          const recs = getRecommendations(db);
          if (useJson) {
            console.log(json({ ...overview, recommendations: recs }));
          } else {
            console.log(formatOverview(overview, recs));
          }
        }
        break;
      }

      // =====================================================================
      // ENRICH
      // =====================================================================
      case "enrich": {
        const density = hasFlag(args, "--density");
        const queries = hasFlag(args, "--queries");
        const clusters = hasFlag(args, "--clusters");
        const sessionFilter = getArg(args, "--session");
        const projectFilter = getArg(args, "--project");
        const dryRun = hasFlag(args, "--dry-run");

        if (!density && !queries && !clusters) {
          console.error("Usage: smriti enrich --density | --queries | --clusters [--session <id>] [--project <id>] [--dry-run]");
          process.exit(1);
        }

        if (density) {
          // Backfill density scores for all (or one) session
          let sessionIds: string[];
          if (sessionFilter) {
            sessionIds = [sessionFilter];
          } else {
            sessionIds = (
              db.prepare(`SELECT session_id FROM smriti_session_meta`).all() as { session_id: string }[]
            ).map((r) => r.session_id);
          }

          console.log(`Computing density scores for ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"}...`);
          let updated = 0;
          for (const sid of sessionIds) {
            const breakdown = computeDensityScore(db, sid);
            updateDensityScore(db, sid, breakdown.score);
            updated++;
            if (sessionFilter) {
              console.log(formatDensityBreakdown(breakdown));
            }
          }
          if (!sessionFilter) {
            console.log(`Updated ${updated} density scores.`);
          }
        }

        if (queries) {
          const { getQmdStore } = await import("./store");
          const sessionIds = sessionFilter
            ? [sessionFilter]
            : getUnenrichedSessionIds(db, projectFilter || undefined);

          console.log(`Enriching ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"} with query labels...`);
          let enriched = 0;
          let skipped = 0;

          for (let i = 0; i < sessionIds.length; i++) {
            const sid = sessionIds[i]!;
            const session = db.prepare(`SELECT title, summary FROM memory_sessions WHERE id = ?`).get(sid) as { title: string; summary: string | null } | null;
            if (!session?.title) { skipped++; continue; }

            const input = session.title + (session.summary ? ". " + session.summary : "");
            process.stdout.write(`  [${i + 1}/${sessionIds.length}] ${session.title.slice(0, 60)}...`);

            try {
              const store = getQmdStore();
              const expanded = await store.internal.expandQuery(input);
              const queryTexts = expanded.map(e => e.query).filter(Boolean);

              if (dryRun) {
                console.log(`\n    → ${queryTexts.join(" | ")}`);
              } else {
                const n = insertSessionQueries(db, sid, queryTexts);
                process.stdout.write(` +${n}\n`);
                enriched++;
              }
            } catch {
              process.stdout.write(` (LLM unavailable, skipped)\n`);
              skipped++;
            }
          }

          if (!dryRun) {
            console.log(`\nEnriched ${enriched} sessions${skipped > 0 ? `, skipped ${skipped}` : ""}.`);
          }
        }

        if (clusters) {
          const k = Number(getArg(args, "--k")) || undefined;
          const model = getArg(args, "--model");
          console.log("Clustering sessions...");
          const clusterResult = await clusterSessions(db as any, {
            projectId: projectFilter || undefined,
            k,
            model,
          });
          if (clusterResult.clusters.length === 0) {
            console.log("Not enough sessions with embeddings to cluster. Run 'smriti embed' first.");
          } else {
            for (const c of clusterResult.clusters) {
              const lastActive = c.lastActive ? new Date(c.lastActive).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
              console.log(`  ${c.name.padEnd(40)} ${c.sessionIds.length} session${c.sessionIds.length === 1 ? "" : "s"}${lastActive ? `  (${lastActive})` : ""}`);
            }
            console.log(`\n${clusterResult.clusters.length} clusters across ${clusterResult.totalSessions} sessions.`);
          }
        }

        break;
      }

      // =====================================================================
      // CLUSTERS
      // =====================================================================
      case "clusters": {
        const k = Number(getArg(args, "--k")) || undefined;
        const model = getArg(args, "--model");
        const projectId = getArg(args, "--project");

        console.log("Clustering sessions...");
        const clusterResult = await clusterSessions(db as any, { projectId, k, model });

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
        const driftTopic = args[1];
        if (!driftTopic) {
          console.error('Usage: smriti drift "<topic>" [options]');
          process.exit(1);
        }

        const driftProject = getArg(args, "--project");
        const driftSince = getArg(args, "--since");
        const driftLimit = Number(getArg(args, "--limit")) || 10;
        const noSynthesizeDrift = hasFlag(args, "--no-synthesize");

        // Recall all matching sessions (high limit, no session dedup — we want all mentions)
        const driftResult = await recall(db, driftTopic, {
          limit: driftLimit * 2,
          synthesize: false,
          project: driftProject || undefined,
          fast: false,
        });

        if (driftResult.results.length < 2) {
          console.log("Not enough history to show evolution.");
          if (driftResult.results.length === 1) {
            console.log(formatSearchResults(driftResult.results));
          }
          break;
        }

        // Enrich with session dates from memory_sessions
        const sessionIds = [...new Set(driftResult.results.map(r => r.session_id))];
        const placeholders = sessionIds.map(() => "?").join(",");
        const dateRows = db.prepare(
          `SELECT id, created_at, updated_at FROM memory_sessions WHERE id IN (${placeholders})`
        ).all(...sessionIds) as { id: string; created_at: string; updated_at: string }[];
        const dateMap = new Map(dateRows.map(r => [r.id, r]));

        // Filter by --since if given
        let filteredResults = driftResult.results;
        if (driftSince) {
          const sinceDate = new Date(driftSince).getTime();
          filteredResults = filteredResults.filter(r => {
            const d = dateMap.get(r.session_id);
            return d ? new Date(d.created_at).getTime() >= sinceDate : true;
          });
        }

        // Deduplicate by session and sort chronologically
        const seenSessions = new Set<string>();
        const chronological = filteredResults
          .filter(r => {
            if (seenSessions.has(r.session_id)) return false;
            seenSessions.add(r.session_id);
            return true;
          })
          .sort((a, b) => {
            const da = dateMap.get(a.session_id)?.created_at ?? "";
            const db2 = dateMap.get(b.session_id)?.created_at ?? "";
            return da.localeCompare(db2);
          })
          .slice(0, driftLimit);

        if (hasFlag(args, "--json")) {
          const timeline = chronological.map((r, i) => ({
            n: i + 1,
            session_id: r.session_id,
            session_title: r.session_title,
            date: dateMap.get(r.session_id)?.created_at,
            content: r.content,
          }));
          console.log(json({ topic: driftTopic, timeline }));
          break;
        }

        console.log(`\n${driftTopic} — evolution across ${chronological.length} session${chronological.length === 1 ? "" : "s"}\n`);
        const timelineText = chronological.map(r => {
          const d = dateMap.get(r.session_id);
          const date = d ? new Date(d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
          const proj = (r as any).project ? ` [${(r as any).project}]` : (driftProject ? ` [${driftProject}]` : "");
          return `${date}${proj}  ${r.session_title || r.session_id}\n  ${r.content.slice(0, 200)}`;
        }).join("\n\n");

        console.log(timelineText);

        if (!noSynthesizeDrift) {
          try {
            const narrative = await ollamaDrift(driftTopic, timelineText);
            console.log("\n--- Evolution narrative ---\n");
            console.log(narrative);
          } catch {
            // Ollama unavailable — timeline shown above is the fallback
          }
        }

        break;
      }

      // =====================================================================
      // DIGEST
      // =====================================================================
      case "digest": {
        const days = Number(getArg(args, "--days")) || 7;
        const project = getArg(args, "--project");
        const synthesize = hasFlag(args, "--synthesize");
        const model = getArg(args, "--model");

        const report = await generateDigest(db, {
          days,
          project,
          synthesize,
          model,
        });

        if (hasFlag(args, "--json")) {
          console.log(json(report));
        } else {
          console.log(formatDigest(report));
        }
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
