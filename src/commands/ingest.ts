/**
 * Real implementation of `ingest` on the new blueprint (see the `ingest`
 * case in ../index.ts). Blueprint only - no real DB is touched; the ingest
 * backend is injected, defaulting to a safe simulation.
 *
 * The ingest command has two modes:
 * - `smriti ingest <agent>` - ingest from one agent (claude, codex, cursor, cline, copilot, claude-web, file, all)
 * - `smriti ingest all` - ingest from all known agents (returns array of results)
 *
 * Special handling:
 * - "all" agent returns multiple IngestResult objects
 * - filePath can be passed as positional arg #2 or via --file flag
 * - Markdown files without --whole trigger a warning
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { ingest as realIngest, ingestAll as realIngestAll } from "../ingest/index";

export type IngestResult = {
  agent: string;
  sessionsFound: number;
  sessionsIngested: number;
  messagesIngested: number;
  skipped: number;
  errors: string[];
};

export type IngestCommandResult = IngestResult | IngestResult[];

/** Injected backend seams - default simulations, no real DB access. */
export interface IngestBackend {
  /** Ingest from a specific agent. */
  ingest(
    agent: string,
    options: {
      onProgress?: (msg: string) => void;
      projectPath?: string;
      filePath?: string;
      format?: "chat" | "jsonl";
      title?: string;
      sessionId?: string;
      projectId?: string;
      force?: boolean;
      whole?: boolean;
    }
  ): Promise<IngestResult>;

  /** Ingest from all known agents. */
  ingestAll(options: {
    onProgress?: (msg: string) => void;
  }): Promise<IngestResult[]>;
}

const simulateBackend: IngestBackend = {
  async ingest() {
    return {
      agent: "simulated",
      sessionsFound: 5,
      sessionsIngested: 5,
      messagesIngested: 42,
      skipped: 0,
      errors: [],
    };
  },
  async ingestAll() {
    return [
      {
        agent: "claude-code",
        sessionsFound: 3,
        sessionsIngested: 3,
        messagesIngested: 28,
        skipped: 0,
        errors: [],
      },
      {
        agent: "codex",
        sessionsFound: 2,
        sessionsIngested: 2,
        messagesIngested: 14,
        skipped: 0,
        errors: [],
      },
    ];
  },
};

/**
 * Real backend for IngestCommand - delegates to the actual ingest orchestrator
 * in ../ingest/index.ts (the same functions the `ingest` case in ../index.ts
 * calls, threaded through the shared `db: Database` handle opened in main()).
 */
export function createRealIngestBackend(db: Database): IngestBackend {
  return {
    async ingest(agent, options) {
      return realIngest(db, agent, options);
    },
    async ingestAll(options) {
      return realIngestAll(db, options);
    },
  };
}

export class IngestCommand extends BaseCommand<IngestCommandResult> {
  constructor(private readonly backend: IngestBackend = simulateBackend) {
    super();
  }

  name = "ingest";
  summary = "Ingest conversations from an agent";
  args: ArgSpec[] = [
    {
      name: "agent",
      type: "string",
      required: true,
      // No enum constraint: the real ingest() function accepts several
      // aliases (claude-code, claude-web-memory, generic, ...) and falls
      // back to a graceful "Unknown agent" IngestResult (not a hard error)
      // for anything else - matching that permissive behavior exactly.
      description: "agent to ingest from (claude, claude-code, claude-web, claude-web-memory, codex, cursor, cline, copilot, file, generic, all)",
    },
    {
      name: "file-path",
      type: "string",
      required: false,
      description: "path to file for agent=file (can also use --file flag)",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--file", type: "string", description: "file path for agent=file" },
    { flag: "--format", type: "string", enum: ["chat", "jsonl"], description: "file format (chat or jsonl)" },
    { flag: "--title", type: "string", description: "custom session title" },
    { flag: "--project-path", type: "string", description: "filter to a specific project path (cursor, cline)" },
    { flag: "--session", type: "string", description: "explicit session ID" },
    { flag: "--project", type: "string", description: "explicit project ID" },
    { flag: "--force", type: "boolean", description: "re-ingest sessions (delete sidecar data, re-extract)" },
    { flag: "--whole", type: "boolean", description: "store file as single document (for .md files)" },
  ];
  output = {
    description: "prints ingest statistics (sessions found, ingested, messages, errors)",
    jsonShape: "{ agent: string, sessionsFound: number, sessionsIngested: number, messagesIngested: number, skipped: number, errors: string[] } | array of such objects for agent=all",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti ingest claude", description: "ingest from Claude Code" },
    { command: "smriti ingest file ./chat.md --whole", description: "ingest a markdown file as single document" },
    { command: "smriti ingest all", description: "ingest from all known agents" },
  ];
  detailedSummary =
    "Ingest conversations and messages from AI agents and tools. Agents: claude (Claude Code sessions), claude-web (claude.ai export JSON), " +
    "codex (Codex CLI), cursor (Cursor editor), cline (Cline agent), copilot (VS Code Copilot), file (external chat/jsonl files), all (all agents). " +
    "The file agent requires --file flag or positional file-path; use --format to specify chat or jsonl; use --whole to store markdown as single document instead of splitting paragraphs. " +
    "--force re-ingests all sessions (deletes sidecar data first). Returns counts of sessions found, ingested, messages ingested, and any errors.";

  protected async execute(parsed: ParsedArgs, ctx: CommandContext): Promise<IngestCommandResult> {
    const agent = parsed.positionals[0];

    // Handle "all" agent
    if (agent === "all") {
      return await this.backend.ingestAll({
        onProgress: (msg) => console.log(`  ${msg}`),
      });
    }

    // Extract file path: positional[1] or --file flag
    const filePath = parsed.positionals[1] || (parsed.flags["--file"] as string | undefined);
    const isMarkdown = filePath?.endsWith(".md");
    const whole = parsed.flags["--whole"] === true;

    // Warn if .md file is being ingested without --whole
    if (isMarkdown && !whole) {
      console.warn(
        "⚠️  Warning: ingesting .md file as chat format splits paragraphs into separate messages. " +
          "Use --whole to store as a single document."
      );
    }

    const result = await this.backend.ingest(agent, {
      onProgress: (msg) => console.log(`  ${msg}`),
      projectPath: parsed.flags["--project-path"] as string | undefined,
      filePath,
      format: parsed.flags["--format"] as "chat" | "jsonl" | undefined,
      title: parsed.flags["--title"] as string | undefined,
      sessionId: parsed.flags["--session"] as string | undefined,
      projectId: parsed.flags["--project"] as string | undefined,
      force: parsed.flags["--force"] === true,
      whole,
    });

    return result;
  }
}
