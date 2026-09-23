/**
 * Real implementation of `search` on the new blueprint (see the `search`
 * case in ../index.ts). Blueprint only - no real DB is touched; the search
 * backend is injected, defaulting to a safe simulation.
 *
 * The search command searches across sessions using full-text search with
 * optional filtering by category, project, and agent. It supports inclusion/exclusion
 * of thinking, artifacts, attachments, and voice notes.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example, OutputSpec } from "../help/types";
import { searchFiltered as realSearchFiltered } from "../search/index";

export interface SearchResult {
  session_id: string;
  session_title: string;
  message_id: number;
  role: string;
  content: string;
  score: number;
  source: string;
  category?: string;
  project?: string;
  agent?: string;
}

export interface SearchFilters {
  category?: string;
  project?: string;
  agent?: string;
  limit?: number;
  includeThinking?: boolean;
  includeArtifacts?: boolean;
  includeAttachments?: boolean;
  includeVoiceNotes?: boolean;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface SearchBackend {
  /** Performs filtered search and returns matching results. */
  searchFiltered(query: string, filters: SearchFilters): SearchResult[];
}

const simulateBackend: SearchBackend = {
  searchFiltered() {
    // Simulate some search results
    return [
      {
        session_id: "sess-001",
        session_title: "Example Session",
        message_id: 1,
        role: "assistant",
        content: "This is an example search result demonstrating the search functionality.",
        score: 0.95,
        source: "fts",
      },
      {
        session_id: "sess-002",
        session_title: "Another Session",
        message_id: 2,
        role: "user",
        content: "A different example result that matches the search query.",
        score: 0.87,
        source: "query_alias",
      },
    ];
  },
};

/**
 * Real backend factory - wraps `searchFiltered` from ../search/index, which
 * is exactly what the `search` case in ../index.ts calls. `db` is the shared
 * Database handle opened once in main() and threaded through every command.
 */
export function createRealSearchBackend(db: Database): SearchBackend {
  return {
    searchFiltered(query: string, filters: SearchFilters): SearchResult[] {
      return realSearchFiltered(db, query, filters);
    },
  };
}

export class SearchCommand extends BaseCommand<SearchResult[]> {
  constructor(private readonly backend: SearchBackend = simulateBackend) {
    super();
  }

  name = "search";
  summary = "Search sessions using full-text search with optional filters";
  args: ArgSpec[] = [
    {
      name: "query",
      type: "string",
      required: true,
      description: "search term or phrase to find across sessions",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--category", type: "string", description: "filter results by category" },
    { flag: "--project", type: "string", description: "filter results by project" },
    { flag: "--agent", type: "string", description: "filter results by agent" },
    { flag: "--limit", type: "number", default: "20", description: "maximum number of results" },
    { flag: "--include-thinking", type: "boolean", description: "include thinking content in search" },
    { flag: "--no-artifacts", type: "boolean", description: "exclude artifacts from search" },
    { flag: "--no-attachments", type: "boolean", description: "exclude attachments from search" },
    { flag: "--no-voice-notes", type: "boolean", description: "exclude voice notes from search" },
    { flag: "--json", type: "boolean", description: "output results as JSON" },
  ];
  output: OutputSpec = {
    description: "prints matching sessions with scores and snippets; --json returns structured result array",
    jsonShape: "SearchResult[] { session_id, session_title, message_id, role, content, score, source }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti search 'authentication flow'",
      description: "search for sessions containing 'authentication flow'",
    },
    {
      command: "smriti search 'bug fix' --project api-server --limit 10",
      description: "search within specific project, limiting to 10 results",
    },
    {
      command: "smriti search 'performance' --include-thinking --json",
      description: "search including thinking content, output as JSON",
    },
  ];
  detailedSummary =
    "Full-text search across all sessions, with optional category/project/agent filtering. " +
    "By default searches across title, role, and content; --include-thinking adds thinking content (opt-in for privacy). " +
    "Use --no-artifacts/--no-attachments/--no-voice-notes to exclude specific content types.";

  protected async execute(parsed: ParsedArgs, ctx: CommandContext): Promise<SearchResult[]> {
    const query = parsed.positionals[0];

    // Build filters from flags
    const filters: SearchFilters = {
      category: parsed.flags["--category"] as string | undefined,
      project: parsed.flags["--project"] as string | undefined,
      agent: parsed.flags["--agent"] as string | undefined,
      limit: parsed.flags["--limit"] ? Number(parsed.flags["--limit"]) : undefined,
      includeThinking: parsed.flags["--include-thinking"] === true,
      includeArtifacts: parsed.flags["--no-artifacts"] !== true,
      includeAttachments: parsed.flags["--no-attachments"] !== true,
      includeVoiceNotes: parsed.flags["--no-voice-notes"] !== true,
    };

    const results = this.backend.searchFiltered(query, filters);

    // Format output based on --json flag
    if (ctx.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(this.formatSearchResults(results));
    }

    return results;
  }

  private formatSearchResults(results: SearchResult[]): string {
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
}
