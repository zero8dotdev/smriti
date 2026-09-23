/**
 * Real implementation of `status` on the new blueprint (see the `status`
 * case in ../index.ts). Retrieves memory statistics and session/agent/category
 * breakdowns, with optional project filtering.
 *
 * The command takes no required positional arguments, only an optional --project
 * flag for filtering to a specific project. Output includes counts from the QMD
 * memory layer (sessions, messages, embeddings) plus Smriti-specific counts
 * (agents, projects, categories).
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { getMemoryStatus as qmdGetMemoryStatus } from "../qmd";

export interface StatusResult {
  sessions: number;
  activeSessions: number;
  messages: number;
  embeddedMessages: number;
  summarizedSessions: number;
  agentCounts: Record<string, number>;
  projectCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  projectFilter?: string;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface StatusBackend {
  /** Gets QMD memory statistics. */
  getMemoryStatus(): {
    sessions: number;
    activeSessions: number;
    messages: number;
    embeddedMessages: number;
    summarizedSessions: number;
  };
  /** Gets agent session counts, optionally filtered by project. */
  getAgentCounts(projectFilter?: string): Record<string, number>;
  /** Gets project session counts (always empty if projectFilter is set). */
  getProjectCounts(projectFilter?: string): Record<string, number>;
  /** Gets category tag counts, optionally filtered by project. */
  getCategoryCounts(projectFilter?: string): Record<string, number>;
}

const simulateBackend: StatusBackend = {
  getMemoryStatus() {
    return {
      sessions: 15,
      activeSessions: 12,
      messages: 342,
      embeddedMessages: 300,
      summarizedSessions: 8,
    };
  },
  getAgentCounts() {
    return {
      claude: 8,
      copilot: 4,
      cursor: 3,
    };
  },
  getProjectCounts() {
    return {
      "my-app": 10,
      "other-app": 5,
    };
  },
  getCategoryCounts() {
    return {
      decision: 6,
      bug: 4,
      feature: 5,
    };
  },
};

/**
 * Real backend - wires the injected seam to the actual QMD memory tables
 * (via qmd.ts's getMemoryStatus, which is memory.ts's getMemoryStatus) and
 * to the Smriti-specific `smriti_session_meta` / `smriti_session_tags`
 * tables via raw `db.prepare(...)` queries. Mirrors the real `status` case
 * in index.ts (~line 1051) exactly:
 *
 * - getMemoryStatus() -> `getMemoryStatus(db)` from qmd.ts (re-exporting
 *   memory.ts's getMemoryStatus(db: Database)), same zero-arg call, same
 *   five-field return shape (sessions/activeSessions/messages/
 *   embeddedMessages/summarizedSessions) - no conversion needed, the
 *   backend interface's getMemoryStatus() return type is structurally
 *   identical to the real function's return type.
 * - getAgentCounts(projectFilter) -> the real case's agentCounts block:
 *   groups `smriti_session_meta` by `agent_id` (excluding NULL agent_id),
 *   filtered to `project_id = ?` when projectFilter is set, unfiltered
 *   otherwise - same two-query branch (parameterized vs. not), same
 *   row -> Record<string, number> reduction.
 * - getProjectCounts(projectFilter) -> the real case's projectCounts
 *   block: when projectFilter is set the real code does not query at all
 *   and leaves projectCounts as `{}` (project counts are meaningless once
 *   already filtered to one project), so this returns `{}` immediately
 *   without touching the DB; when unset it groups `smriti_session_meta`
 *   by `project_id` (excluding NULL project_id), same reduction.
 * - getCategoryCounts(projectFilter) -> the real case's categoryCounts
 *   block: groups `smriti_session_tags` by `category_id`, joined to
 *   `smriti_session_meta` on `session_id` and filtered to
 *   `sm.project_id = ?` when projectFilter is set, unfiltered (no join)
 *   otherwise - both branches `ORDER BY count DESC` (irrelevant once
 *   reduced into a Record, but preserved for fidelity), same reduction.
 *
 * projectFilter itself, and the `projectFilter` field on the returned
 * result, are already handled entirely in StatusCommand.execute() below
 * (via `--project` / ParsedArgs) - this factory only supplies the four
 * data-fetching methods the interface declares. Not wired into any
 * default - callers opt in explicitly via createRealStatusBackend(db).
 */
export function createRealStatusBackend(db: Database): StatusBackend {
  return {
    getMemoryStatus() {
      return qmdGetMemoryStatus(db);
    },
    getAgentCounts(projectFilter) {
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
      return agentCounts;
    },
    getProjectCounts(projectFilter) {
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
      return projectCounts;
    },
    getCategoryCounts(projectFilter) {
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
      return categoryCounts;
    },
  };
}

export class StatusCommand extends BaseCommand<StatusResult> {
  constructor(private readonly backend: StatusBackend = simulateBackend) {
    super();
  }

  name = "status";
  summary = "Memory statistics and usage breakdown";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    { flag: "--project", type: "string", description: "filter to a specific project" },
  ];
  output = {
    description: "prints session, message, and categorization statistics, optionally filtered by project",
    jsonShape: "{ sessions: number, activeSessions: number, messages: number, embeddedMessages: number, summarizedSessions: number, agentCounts: Record<string, number>, projectCounts: Record<string, number>, categoryCounts: Record<string, number>, projectFilter?: string }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti status", description: "show global memory statistics" },
    { command: "smriti status --project myapp", description: "show statistics for a single project" },
    { command: "smriti status --json", description: "output as JSON for scripting" },
  ];
  detailedSummary =
    "Displays memory statistics including total sessions, messages, and embeddings from the QMD layer, " +
    "plus agent, project, and category breakdowns from Smriti session metadata. " +
    "With --project, all counts are filtered to that project only.";

  protected async execute(parsed: ParsedArgs, ctx: CommandContext): Promise<StatusResult> {
    const projectFilter = parsed.flags["--project"] as string | undefined;

    const baseStatus = this.backend.getMemoryStatus();
    const agentCounts = this.backend.getAgentCounts(projectFilter);
    const projectCounts = this.backend.getProjectCounts(projectFilter);
    const categoryCounts = this.backend.getCategoryCounts(projectFilter);

    const result: StatusResult = {
      ...baseStatus,
      agentCounts,
      projectCounts,
      categoryCounts,
    };

    // Matches the original CLI: projectFilter is only added to non-JSON
    // output, keeping the JSON shape consistent for programmatic consumers.
    if (projectFilter && !ctx.json) {
      result.projectFilter = projectFilter;
    }

    return result;
  }
}
