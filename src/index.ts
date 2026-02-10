#!/usr/bin/env bun
/**
 * index.ts - Smriti CLI entry point
 *
 * Unified memory layer across all AI agents.
 * Builds on QMD's memory infrastructure with multi-agent ingestion,
 * schema-based categorization, and team knowledge sharing.
 */

import { initSmriti, closeDb, getCategories, getCategoryTree, addCategory, listProjects, tagSession } from "./db";
import { getMessages, getSession, getMemoryStatus, embedMemoryMessages } from "./qmd";
import { ingest, ingestAll } from "./ingest/index";
import { categorizeUncategorized } from "./categorize/classifier";
import { formatCategoryTree as schemaFormatCategoryTree, isValidCategory } from "./categorize/schema";
import { searchFiltered, listSessions } from "./search/index";
import { recall } from "./search/recall";
import { shareKnowledge } from "./team/share";
import { syncTeamKnowledge, listTeamContributions } from "./team/sync";
import {
  formatSessionList,
  formatSearchResults,
  formatStatus,
  formatIngestResult,
  formatCategoryTree,
  formatTeamContributions,
  formatShareResult,
  formatSyncResult,
  json,
} from "./format";

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
  share [filters]              Export knowledge to .smriti/
  sync                         Import team knowledge from .smriti/
  team                         View team contributions
  list [filters]               List sessions
  show <session-id>            Show session messages
  status                       Memory statistics
  projects                     List projects
  embed                        Embed new messages for vector search
  help                         Show this help

Filters (apply to search, recall, list, share):
  --category <id>              Filter by category
  --project <id>               Filter by project
  --agent <id>                 Filter by agent
  --limit <n>                  Max results (default varies by command)

Ingest options:
  smriti ingest claude         Ingest Claude Code sessions
  smriti ingest codex          Ingest Codex CLI sessions
  smriti ingest cursor --project-path <path>
  smriti ingest file <path> [--format chat|jsonl] [--title <t>]
  smriti ingest all            Ingest from all known agents

Recall options:
  --synthesize                 Synthesize results via Ollama
  --model <name>               Ollama model for synthesis
  --max-tokens <n>             Max synthesis tokens

Share options:
  --session <id>               Share specific session
  --output <dir>               Custom output directory
  --no-reflect                 Skip LLM reflections (on by default)
  --reflect-model <name>       Ollama model for reflections

Examples:
  smriti ingest claude
  smriti search "auth" --project myapp
  smriti recall "how did we set up auth" --synthesize
  smriti categorize
  smriti list --category decision --project myapp
  smriti share --category decision
  smriti sync
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }

  // Initialize DB
  const db = initSmriti();

  try {
    switch (command) {
      // =====================================================================
      // INGEST
      // =====================================================================
      case "ingest": {
        const agent = args[1];
        if (!agent) {
          console.error("Usage: smriti ingest <agent>");
          console.error("Agents: claude, codex, cursor, file, all");
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

        const result = await ingest(db, agent, {
          onProgress: (msg) => console.log(`  ${msg}`),
          projectPath: getArg(args, "--project-path"),
          filePath: args[2] && !args[2].startsWith("--") ? args[2] : getArg(args, "--file"),
          format: getArg(args, "--format") as "chat" | "jsonl" | undefined,
          title: getArg(args, "--title"),
          sessionId: getArg(args, "--session"),
          projectId: getArg(args, "--project"),
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

        const result = await recall(db, query, {
          category: getArg(args, "--category"),
          project: getArg(args, "--project"),
          agent: getArg(args, "--agent"),
          limit: Number(getArg(args, "--limit")) || undefined,
          synthesize: hasFlag(args, "--synthesize"),
          model: getArg(args, "--model"),
          maxTokens: Number(getArg(args, "--max-tokens")) || undefined,
        });

        if (hasFlag(args, "--json")) {
          console.log(json(result));
        } else {
          console.log(formatSearchResults(result.results));
          if (result.synthesis) {
            console.log("\n--- Synthesis ---\n");
            console.log(result.synthesis);
          }
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
        });

        console.log(formatShareResult(result));
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

        // Get Smriti-specific counts
        const agentCounts: Record<string, number> = {};
        const agentRows = db
          .prepare(
            `SELECT agent_id, COUNT(*) as count FROM smriti_session_meta
             WHERE agent_id IS NOT NULL GROUP BY agent_id`
          )
          .all() as { agent_id: string; count: number }[];
        for (const row of agentRows) {
          agentCounts[row.agent_id] = row.count;
        }

        const projectCounts: Record<string, number> = {};
        const projectRows = db
          .prepare(
            `SELECT project_id, COUNT(*) as count FROM smriti_session_meta
             WHERE project_id IS NOT NULL GROUP BY project_id`
          )
          .all() as { project_id: string; count: number }[];
        for (const row of projectRows) {
          projectCounts[row.project_id] = row.count;
        }

        const categoryCounts: Record<string, number> = {};
        const catRows = db
          .prepare(
            `SELECT category_id, COUNT(*) as count FROM smriti_session_tags
             GROUP BY category_id ORDER BY count DESC`
          )
          .all() as { category_id: string; count: number }[];
        for (const row of catRows) {
          categoryCounts[row.category_id] = row.count;
        }

        if (hasFlag(args, "--json")) {
          console.log(
            json({ ...baseStatus, agentCounts, projectCounts, categoryCounts })
          );
        } else {
          console.log(
            formatStatus({
              ...baseStatus,
              agentCounts,
              projectCounts,
              categoryCounts,
            })
          );
        }
        break;
      }

      // =====================================================================
      // PROJECTS
      // =====================================================================
      case "projects": {
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
      // UNKNOWN
      // =====================================================================
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run 'smriti help' for usage.");
        process.exit(1);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
