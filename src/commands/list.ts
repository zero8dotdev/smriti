/**
 * Real implementation of `list` on the new blueprint (see the `list`
 * case in ../index.ts, ~line 995). Blueprint only - no real DB is touched;
 * the session listing backend is injected, defaulting to a safe simulated
 * implementation.
 *
 * The `list` command is straightforward: accepts optional filters
 * (--category, --project, --agent), an optional --limit, and --all to
 * include inactive sessions. No required positional arguments.
 * Returns a list of sessions, formatted as text or JSON.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { listSessions as realListSessions } from "../search/index";

/** Mirrors search/index.ts's listSessions row shape exactly - full fidelity, nothing dropped. */
export interface SessionRecord {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  agent_id: string | null;
  project_id: string | null;
  summary: string | null;
  active: number;
  /** Comma-joined category ids (a session can have more than one tag), '' if none. */
  categories: string;
}

export interface ListFilters {
  category?: string;
  project?: string;
  agent?: string;
  limit?: number;
  includeInactive?: boolean;
}

/** Injected backend seam - default simulation, no real DB access. */
export interface ListBackend {
  /** Returns sessions matching the given filters. */
  listSessions(filters: ListFilters): Promise<SessionRecord[]>;
}

const simulateBackend: ListBackend = {
  async listSessions() {
    // Simulate an empty database by default - exercises the "no sessions" success path
    return [];
  },
};

/**
 * Real backend, backed by the shared sqlite Database handle.
 *
 * Mirrors ../index.ts case "list": exactly:
 *   - listSessions(db, { category, project, agent, limit, includeInactive })
 *     from ../search/index
 *
 * ../search/index.ts's `ListFilters` type is structurally identical to this
 * file's `ListFilters` (category?, project?, agent?, limit?, includeInactive?),
 * so the filters object is passed straight through - no conversion needed there.
 * Note the real listSessions() defaults `limit` to 50 internally when
 * `filters.limit` is falsy/undefined, matching index.ts's behavior of passing
 * `Number(getArg(args, "--limit")) || undefined` through unchanged.
 *
 * SessionRecord now mirrors the real row shape field-for-field (id, title,
 * created_at, updated_at, agent_id, project_id, summary, active, categories)
 * - the original blueprint interface dropped summary/active and collapsed
 * categories into a singular field, which would have silently changed
 * `smriti list --json`'s output shape for real consumers. Widened instead
 * of accepting that data loss.
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealListBackend(db).
 */
export function createRealListBackend(db: Database): ListBackend {
  return {
    async listSessions(filters: ListFilters): Promise<SessionRecord[]> {
      return realListSessions(db, filters);
    },
  };
}

export interface ListResult {
  sessions: SessionRecord[];
  count: number;
}

export class ListCommand extends BaseCommand<ListResult> {
  constructor(private readonly backend: ListBackend = simulateBackend) {
    super();
  }

  name = "list";
  summary = "List sessions with optional filters";
  args: ArgSpec[] = []; // No required positional arguments
  flags: FlagSpec[] = [
    { flag: "--category", type: "string", description: "filter by category id" },
    { flag: "--project", type: "string", description: "filter by project id" },
    { flag: "--agent", type: "string", description: "filter by agent id" },
    { flag: "--limit", type: "number", description: "maximum number of sessions to return" },
    { flag: "--all", type: "boolean", description: "include inactive sessions (default: active only)" },
  ];
  output = {
    description: "prints a formatted list of sessions, or JSON array when --json is passed",
    jsonShape: "{ sessions: Array<{ id, title, created_at, updated_at, agent_id, project_id }>, count: number }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti list", description: "show all active sessions" },
    { command: "smriti list --project myapp --limit 10", description: "show up to 10 active sessions for a project" },
    { command: "smriti list --category decision --all --json", description: "show all sessions (including inactive) tagged with decision, as JSON" },
  ];
  detailedSummary =
    "List sessions in memory with optional filtering. By default, shows only active sessions; " +
    "pass --all to include inactive (soft-deleted) ones. Filters are optional and can be combined.";

  protected async execute(parsed: ParsedArgs, _ctx: CommandContext): Promise<ListResult> {
    const limit = parsed.flags["--limit"]
      ? Number(parsed.flags["--limit"])
      : undefined;

    const sessions = await this.backend.listSessions({
      category: parsed.flags["--category"] as string | undefined,
      project: parsed.flags["--project"] as string | undefined,
      agent: parsed.flags["--agent"] as string | undefined,
      limit,
      includeInactive: parsed.flags["--all"] === true,
    });

    return {
      sessions,
      count: sessions.length,
    };
  }
}
