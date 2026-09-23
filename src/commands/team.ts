/**
 * Real implementation of `team` on the new blueprint (see the `team`
 * case in ../index.ts). Blueprint only - no real DB is touched; the backend
 * is injected, defaulting to a safe simulation.
 *
 * The team command is simple: it lists team contributions (shared sessions
 * grouped by author) without any arguments or flags.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { listTeamContributions } from "../team/sync";

export interface TeamContribution {
  author: string;
  count: number;
  categories: string;
  latest: string;
}

export interface TeamResult {
  contributions: TeamContribution[];
  total: number;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface TeamBackend {
  /** Lists team contributions grouped by author. */
  listTeamContributions(): TeamContribution[];
}

const simulateBackend: TeamBackend = {
  listTeamContributions() {
    return [
      { author: "alice", count: 5, categories: "decision,pattern", latest: "2026-08-05T14:30:00Z" },
      { author: "bob", count: 3, categories: "bug-fix", latest: "2026-08-04T10:15:00Z" },
    ];
  },
};

/**
 * Real backend, backed by the shared sqlite Database handle.
 *
 * Mirrors ../index.ts case "team": exactly:
 *   - listTeamContributions(db)  from ../team/sync
 *
 * listTeamContributions(db) already returns an array of objects shaped
 * exactly like TeamContribution ({ author, count, categories, latest }),
 * so no conversion is needed here.
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealTeamBackend(db).
 */
export function createRealTeamBackend(db: Database): TeamBackend {
  return {
    listTeamContributions(): TeamContribution[] {
      return listTeamContributions(db);
    },
  };
}

export class TeamCommand extends BaseCommand<TeamResult> {
  constructor(private readonly backend: TeamBackend = simulateBackend) {
    super();
  }

  name = "team";
  summary = "View team contributions (shared sessions grouped by author)";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    { flag: "--json", type: "boolean", description: "output as JSON" },
  ];
  output = {
    description: "prints a table of team members and their shared contributions",
    jsonShape: "{ contributions: Array<{author, count, categories, latest}>, total: number }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti team", description: "view all team contributions" },
    { command: "smriti team --json", description: "output as JSON for scripting" },
    { command: "smriti team", description: "shows author, share count, categories, and latest share date" },
  ];
  detailedSummary =
    "Lists all team members who have shared knowledge (via `smriti share` and `smriti sync`), " +
    "grouped by author with counts and dates. No arguments or filters.";

  protected async execute(_parsed: ParsedArgs): Promise<TeamResult> {
    const contributions = this.backend.listTeamContributions();
    return {
      contributions,
      total: contributions.reduce((sum, c) => sum + c.count, 0),
    };
  }
}
