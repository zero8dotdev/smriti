/**
 * Real implementation of `drift` on the new blueprint (see the `drift`
 * case in ../index.ts). Blueprint only - no real DB/Ollama is touched; the
 * recall and synthesis backends are injected, defaulting to safe simulations.
 *
 * The drift command shows how thinking on a topic evolved over time.
 * It retrieves all mentions of a topic across sessions, orders them chronologically,
 * and optionally synthesizes a narrative describing the evolution via Ollama.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { recall as realRecall } from "../search/recall";
import { ollamaDrift } from "../ollama";

export interface DriftTimelineEntry {
  n: number;
  session_id: string;
  session_title: string;
  date: string | undefined;
  content: string;
  project?: string;
}

export interface DriftRawResult {
  session_id: string;
  session_title: string;
  score: number;
  content: string;
  message_id: number;
  role: string;
  project?: string;
}

export interface DriftResult {
  topic: string;
  timeline: DriftTimelineEntry[];
  narrative?: string;
  /** Set when fewer than 2 results were found - original prints a plain-text message in this case regardless of --json. */
  insufficientHistory?: boolean;
  /** Raw recall results for the insufficientHistory path (needed by formatSearchResults, which requires role/message_id). */
  rawResults?: DriftRawResult[];
}

export interface RecallResult {
  results: DriftRawResult[];
}

export interface SessionDate {
  session_id: string;
  created_at: string;
}

/** Injected backend seams - default simulations, no real DB/Ollama access. */
export interface DriftBackend {
  /** Recalls all mentions of a topic across sessions. */
  recall(topic: string, opts: { limit?: number; project?: string }): Promise<RecallResult>;
  /** Fetches creation dates for sessions. */
  getSessionDates(sessionIds: string[]): Promise<SessionDate[]>;
  /** Synthesizes a narrative from timeline text via Ollama; returns undefined if unavailable. */
  synthesizeNarrative(topic: string, timelineText: string): Promise<string | undefined>;
}

const simulateBackend: DriftBackend = {
  async recall(topic: string) {
    // Simulate finding sessions about the topic
    return {
      results: [
        {
          session_id: "2024-01-15T10:30:00Z",
          session_title: "Initial auth design",
          score: 0.9,
          content: `We discussed implementing a simple JWT-based ${topic} system with refresh tokens.`,
          message_id: 1,
          role: "assistant",
        },
        {
          session_id: "2024-02-20T14:15:00Z",
          session_title: "Auth system improvements",
          score: 0.85,
          content: `Added OAuth2 support to the ${topic} layer after feedback from early users.`,
          message_id: 2,
          role: "assistant",
        },
      ],
    };
  },
  async getSessionDates(sessionIds: string[]) {
    return sessionIds.map((id) => ({
      session_id: id,
      created_at: id, // Assume session_id is an ISO 8601 timestamp
    }));
  },
  async synthesizeNarrative() {
    // Simulate Ollama being unavailable
    return undefined;
  },
};

/**
 * Real backend - wires the injected seam to the actual recall pipeline
 * (search/recall.ts's `recall(db, query, options)`), to the `memory_sessions`
 * table via a raw `db.prepare(...)` query, and to Ollama-based narrative
 * synthesis via ollama.ts's `ollamaDrift(topic, timeline)`. Mirrors the real
 * `drift` case in index.ts (~line 1464) exactly:
 *
 * - recall(topic, { limit, project }) -> `recall(db, topic, { limit,
 *   synthesize: false, project, fast: false })`, same as the real case's
 *   `driftResult = await recall(db, driftTopic, { limit: driftLimit * 2,
 *   synthesize: false, project: driftProject || undefined, fast: false })`.
 *   The real `recall()` return type (`{ results: SearchResult[], synthesis?
 *   }`) is a structural superset of the blueprint's `RecallResult` (extra
 *   `SearchResult` fields like message_id/role/source/category/agent and
 *   the `synthesis` field are simply not read by DriftCommand), so only
 *   `results` is passed through - no other conversion needed.
 * - getSessionDates(sessionIds) -> the real case's date-enrichment block:
 *   `SELECT id, created_at, updated_at FROM memory_sessions WHERE id IN
 *   (${placeholders})`, same parameterized IN-clause construction from the
 *   deduplicated session id list, mapped from `{ id, created_at,
 *   updated_at }` rows to the blueprint's `{ session_id, created_at }`
 *   shape (id -> session_id rename; updated_at is fetched by the real
 *   query but never used by the real case either, so it is dropped here
 *   too). Guards on an empty `sessionIds` array (the real case never hits
 *   this since it only enriches sessions from a >= 2-result recall) to
 *   avoid an invalid `IN ()` clause.
 * - synthesizeNarrative(topic, timelineText) -> `ollamaDrift(topic,
 *   timelineText)` from ollama.ts, same two positional args as the real
 *   case's `await ollamaDrift(driftTopic, timelineText)`. `ollamaDrift`
 *   returns `Promise<string>` (narrower than the blueprint's `Promise<string
 *   | undefined>`, so no conversion needed) and throws on failure exactly
 *   like the real case expects - DriftCommand.execute() already wraps this
 *   call in the same try/catch-and-fall-back-to-undefined the real case
 *   uses around its own `ollamaDrift` call, so errors are handled
 *   identically without any extra handling in this factory.
 *
 * Not wired into any default - callers opt in explicitly via
 * createRealDriftBackend(db).
 */
export function createRealDriftBackend(db: Database): DriftBackend {
  return {
    async recall(topic, opts) {
      const result = await realRecall(db, topic, {
        limit: opts.limit,
        synthesize: false,
        project: opts.project,
        fast: false,
      });
      return { results: result.results };
    },
    async getSessionDates(sessionIds) {
      if (sessionIds.length === 0) return [];
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id, created_at, updated_at FROM memory_sessions WHERE id IN (${placeholders})`)
        .all(...sessionIds) as { id: string; created_at: string; updated_at: string }[];
      return rows.map((r) => ({ session_id: r.id, created_at: r.created_at }));
    },
    async synthesizeNarrative(topic, timelineText) {
      return await ollamaDrift(topic, timelineText);
    },
  };
}

export class DriftCommand extends BaseCommand<DriftResult> {
  constructor(private readonly backend: DriftBackend = simulateBackend) {
    super();
  }

  name = "drift";
  summary = "Show how thinking on a topic evolved over time";
  args: ArgSpec[] = [
    {
      name: "topic",
      type: "string",
      required: true,
      description: "topic to trace evolution of",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--project", type: "string", description: "filter to a specific project" },
    { flag: "--since", type: "string", description: "filter to sessions after this date (ISO 8601)" },
    { flag: "--limit", type: "number", default: "10", description: "max timeline entries to show" },
    { flag: "--no-synthesize", type: "boolean", description: "skip Ollama narrative synthesis" },
  ];
  output = {
    description: "chronological timeline of how a topic was discussed, with optional Ollama narrative synthesis",
    jsonShape: "{ topic: string, timeline: Array<{n, session_id, session_title, date, content}>, narrative?: string }",
  };
  examples: [Example, Example, Example] = [
    {
      command: 'smriti drift "authentication"',
      description: "show how authentication thinking evolved across all sessions",
    },
    {
      command: 'smriti drift "caching strategy" --project myapp --limit 5',
      description: "trace caching evolution in a specific project, max 5 entries",
    },
    {
      command: 'smriti drift "API design" --since 2024-01-01 --no-synthesize',
      description: "timeline of API design decisions from Jan 1 onwards, no synthesis",
    },
  ];
  detailedSummary =
    "Drift retrieves all mentions of a topic across sessions, orders them chronologically, " +
    "and shows how the thinking evolved. Optionally synthesizes an evolution narrative via Ollama. " +
    "Returns at least 2 session mentions (else 'not enough history' error). " +
    "--since filters to sessions after a date. --limit caps the timeline (default 10).";

  protected async execute(parsed: ParsedArgs, ctx: CommandContext): Promise<DriftResult> {
    const topic = parsed.positionals[0];
    const project = parsed.flags["--project"] as string | undefined;
    const since = parsed.flags["--since"] as string | undefined;
    const limit = Number(parsed.flags["--limit"]) || 10;
    const noSynthesize = parsed.flags["--no-synthesize"] === true;

    // Recall all matching sessions (high limit, no session dedup — we want all mentions)
    const recallResult = await this.backend.recall(topic, {
      limit: limit * 2,
      project: project || undefined,
    });

    if (recallResult.results.length < 2) {
      // Not enough history to show evolution - the caller prints this as
      // plain text (via formatSearchResults on the raw results) regardless
      // of --json, same as the original case block.
      return {
        topic,
        timeline: [],
        insufficientHistory: true,
        rawResults: recallResult.results,
      };
    }

    // Enrich with session dates
    const sessionIds = [...new Set(recallResult.results.map((r) => r.session_id))];
    const sessionDates = await this.backend.getSessionDates(sessionIds);
    const dateMap = new Map(sessionDates.map((d) => [d.session_id, d.created_at]));

    // Filter by --since if given
    let filteredResults = recallResult.results;
    if (since) {
      const sinceDate = new Date(since).getTime();
      filteredResults = filteredResults.filter((r) => {
        const d = dateMap.get(r.session_id);
        return d ? new Date(d).getTime() >= sinceDate : true;
      });
    }

    // Deduplicate by session and sort chronologically
    const seenSessions = new Set<string>();
    const chronological = filteredResults
      .filter((r) => {
        if (seenSessions.has(r.session_id)) return false;
        seenSessions.add(r.session_id);
        return true;
      })
      .sort((a, b) => {
        const da = dateMap.get(a.session_id) ?? "";
        const db = dateMap.get(b.session_id) ?? "";
        return da.localeCompare(db);
      })
      .slice(0, limit);

    // Build timeline entries
    const timeline = chronological.map((r, i) => ({
      n: i + 1,
      session_id: r.session_id,
      session_title: r.session_title,
      date: dateMap.get(r.session_id),
      content: r.content,
      project: r.project,
    }));

    // Optionally synthesize narrative (gated only by --no-synthesize, same as
    // the original - it does not skip on an empty timeline either).
    let narrative: string | undefined;
    if (!noSynthesize) {
      const timelineText = timeline
        .map((entry) => {
          const date = entry.date ? new Date(entry.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
          const proj = entry.project ? ` [${entry.project}]` : (project ? ` [${project}]` : "");
          return `${date}${proj}  ${entry.session_title || entry.session_id}\n  ${entry.content.slice(0, 200)}`;
        })
        .join("\n\n");

      try {
        narrative = await this.backend.synthesizeNarrative(topic, timelineText);
      } catch {
        // Ollama unavailable - narrative stays undefined
      }
    }

    return { topic, timeline, narrative };
  }
}
