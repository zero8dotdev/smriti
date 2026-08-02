/**
 * test/eval/fixtures/types.ts - Shared fixture format for the recall-quality
 * harness. A scenario is a small multi-session conversation (optionally
 * spanning sessions created at different points in time, via `daysAgo`)
 * paired with probes that check both recall (the right session surfaces)
 * and precision (a near-topic distractor does not).
 *
 * Shared by test/recall-quality.test.ts (Tier 1, CI-safe, BM25-only) and
 * test/eval/recall-quality.eval.ts (Tier 2, manual, requires embeddings).
 */

export type FixtureMessage = { role: "user" | "assistant"; content: string };

export type FixtureSession = {
  id: string;
  /** Overrides the scenario's default project — lets one scenario seed sessions across multiple projects to test project-filter isolation. */
  project?: string;
  /** How many days before "now" this session was created — exercises recency/density blending. Omit for "just now". */
  daysAgo?: number;
  /** density_score to set on this session (0-1). Omit to leave at the default (0). */
  densityScore?: number;
  messages: FixtureMessage[];
};

export type Probe = {
  query: string;
  /** Why a human would ask this — shown in the report, not asserted on. */
  description: string;
  /** Session ids that MUST appear in the top-K results. */
  expectHitSessionIds: string[];
  /** At least one of these substrings must appear in a retrieved row belonging to an expected-hit session. */
  expectHitSubstrings?: string[];
  /** Session ids that must NOT appear in the top-K results (precision). */
  expectMissSessionIds?: string[];
  /** Defaults to the harness-wide DEFAULT_TOP_K. */
  topK?: number;
  /** Overrides the scenario's default project for this probe's recall() call. */
  project?: string;
  /**
   * Route through recallMemories's unfiltered hybrid pipeline (RRF + density
   * blending) instead of the project-filtered searchFiltered path. Still
   * CI-safe without embeddings — vector search silently no-ops when none
   * exist. Needed for probes that specifically exercise density/recency
   * blending, which the project-filtered path never touches.
   */
  useRecallMemories?: boolean;
};

export type RecallScenario = {
  name: string;
  /** Default project for sessions/probes that don't override it. */
  project: string;
  sessions: FixtureSession[];
  probes: Probe[];
  /**
   * Only runs in Tier 2 (manual, quality mode) — needs a live embedding
   * backend to exercise genuinely non-lexical (semantic-only) matches.
   */
  requiresEmbeddings?: boolean;
};
