/**
 * Real implementation of `forget` on the new blueprint (see the `forget`
 * case in ../index.ts). Blueprint only - no real DB is touched; the delete
 * backend is injected, defaulting to a safe simulation.
 *
 * The interesting shape here: `<session-id>` is required UNLESS `--all` is
 * given (`forget sess1` vs `forget --all --project x`) - the
 * positional-required-unless-flag pattern that ArgSpec.requiredUnless now
 * models, matching the same alternate-calling-convention shape as
 * `compare <a> <b>` vs `compare --last`. Faithful to the real CLI: if both
 * a session-id and --all are given, --all wins (mirrors index.ts's
 * `all ? listSessions(...) : [sessionId!]` ternary) rather than erroring -
 * not invented behavior, just replicated.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { forgetSession } from "../db";
import { listSessions } from "../search/index";

export interface ForgetResult {
  targetCount: number;
  hard: boolean;
  unitsDeleted: number;
  unitsPurged: number;
  canonicalKept: number;
}

export interface ForgetFilters {
  project?: string;
  category?: string;
  agent?: string;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface ForgetBackend {
  /** Resolves which session ids `--all` (+ filters) targets. */
  listMatchingSessions(filters: ForgetFilters): Promise<string[]>;
  /** Deletes one session, returns per-session counts to aggregate. */
  forgetSession(id: string, opts: { hard: boolean; purgeShared: boolean }): Promise<{ unitsDeleted: number; unitsPurged: number; canonicalKept: number }>;
}

const simulateBackend: ForgetBackend = {
  async listMatchingSessions() {
    return []; // simulate an empty project by default - exercises the "no matches" success path
  },
  async forgetSession() {
    return { unitsDeleted: 2, unitsPurged: 0, canonicalKept: 1 };
  },
};

/**
 * Real backend, backed by the shared sqlite Database handle opened once in
 * main() and threaded through every case block in ../index.ts.
 *
 * Mirrors ../index.ts case "forget": exactly:
 *   - listMatchingSessions -> listSessions(db, { project, category, agent,
 *     includeInactive: true }).map(s => s.id)   from ../search/index
 *     (includeInactive: true is hardcoded in the original case block so
 *     --all also targets sessions already soft-deleted/inactive - not a
 *     filter exposed on ForgetFilters, so it's baked in here rather than
 *     threaded through)
 *   - forgetSession -> forgetSession(db, id, { hard, purgeShared })
 *     from ../db
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealForgetBackend(db).
 */
export function createRealForgetBackend(db: Database): ForgetBackend {
  return {
    async listMatchingSessions(filters: ForgetFilters): Promise<string[]> {
      const sessions = listSessions(db, {
        project: filters.project,
        category: filters.category,
        agent: filters.agent,
        includeInactive: true,
      });
      return sessions.map((s) => s.id);
    },
    async forgetSession(
      id: string,
      opts: { hard: boolean; purgeShared: boolean }
    ): Promise<{ unitsDeleted: number; unitsPurged: number; canonicalKept: number }> {
      return forgetSession(db, id, { hard: opts.hard, purgeShared: opts.purgeShared });
    },
  };
}

export class ForgetCommand extends BaseCommand<ForgetResult> {
  constructor(private readonly backend: ForgetBackend = simulateBackend) {
    super();
  }

  name = "forget";
  summary = "Delete a session (soft by default) or bulk-delete matching sessions";
  args: ArgSpec[] = [
    {
      name: "session-id",
      type: "string",
      required: true,
      requiredUnless: ["--all"],
      description: "session to forget",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--all", type: "boolean", description: "bulk forget, using --project/--category/--agent as filters" },
    { flag: "--hard", type: "boolean", description: "permanently delete instead of soft delete" },
    { flag: "--yes", type: "boolean", description: "confirm --hard" },
    { flag: "--purge-shared", type: "boolean", description: "with --hard, also delete promoted/canonical units" },
    { flag: "--project", type: "string", description: "filter for --all" },
    { flag: "--category", type: "string", description: "filter for --all" },
    { flag: "--agent", type: "string", description: "filter for --all" },
  ];
  confirmationGates = [{ flag: "--hard", confirmFlag: ["--yes"] }];
  output = {
    description: "prints how many sessions were forgotten and, for --hard, unit counts",
    jsonShape: "{ targetCount: number, hard: boolean, unitsDeleted: number, unitsPurged: number, canonicalKept: number }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti forget sess1", description: "soft delete one session" },
    { command: "smriti forget sess1 --hard --yes", description: "permanently delete one session" },
    { command: "smriti forget --all --project stale-app --hard --yes", description: "bulk permanent delete, filtered" },
  ];
  detailedSummary =
    "Soft delete (default) is reversible; --hard is not and requires --yes. " +
    "--all bulk-deletes everything matching the filters instead of one session-id.";

  protected async execute(parsed: ParsedArgs): Promise<ForgetResult> {
    const hard = parsed.flags["--hard"] === true;
    const purgeShared = parsed.flags["--purge-shared"] === true;
    const all = parsed.flags["--all"] === true;

    const targetIds = all
      ? await this.backend.listMatchingSessions({
          project: parsed.flags["--project"] as string | undefined,
          category: parsed.flags["--category"] as string | undefined,
          agent: parsed.flags["--agent"] as string | undefined,
        })
      : [parsed.positionals[0]];

    let unitsDeleted = 0;
    let unitsPurged = 0;
    let canonicalKept = 0;
    for (const id of targetIds) {
      const r = await this.backend.forgetSession(id, { hard, purgeShared });
      unitsDeleted += r.unitsDeleted;
      unitsPurged += r.unitsPurged;
      canonicalKept += r.canonicalKept;
    }

    return { targetCount: targetIds.length, hard, unitsDeleted, unitsPurged, canonicalKept };
  }
}
