/**
 * bench/types.ts - Shared types for Smriti benchmarking
 */

// =============================================================================
// Profile Configuration
// =============================================================================

export type ProfileName = "ci-small" | "small" | "medium";

export type BenchProfile = {
  sessions: number;
  messagesPerSession: number;
  warmupQueries: number;
  measureQueries: number;
};

export const PROFILES: Record<ProfileName, BenchProfile> = {
  "ci-small": { sessions: 12, messagesPerSession: 8, warmupQueries: 3, measureQueries: 20 },
  small: { sessions: 24, messagesPerSession: 10, warmupQueries: 5, measureQueries: 30 },
  medium: { sessions: 48, messagesPerSession: 12, warmupQueries: 10, measureQueries: 60 },
};

// =============================================================================
// Corpus
// =============================================================================

export type SessionDef = {
  id: string;
  title: string;
  project: string;
  agent: string;
  category: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  sidecar?: {
    thinking?: string;
    artifact?: { title: string; content: string; language: string };
    attachment?: { fileName: string; content: string };
  };
};

export type CorpusManifest = {
  sessions: SessionDef[];
  projects: string[];
  agents: string[];
  categories: string[];
  /** Map session ID -> last inserted message ID (for sidecar attachment) */
  messageIds: Map<string, number>;
};

// =============================================================================
// Queries
// =============================================================================

export type BenchQuery = {
  id: string;
  query: string;
  difficulty: "easy" | "medium" | "hard";
  expectedSessionIds: string[];
  filters?: {
    project?: string;
    category?: string;
    agent?: string;
    includeThinking?: boolean;
  };
  method: "fts" | "filtered" | "recall";
};

// =============================================================================
// Results
// =============================================================================

export type QueryResult = {
  queryId: string;
  difficulty: "easy" | "medium" | "hard";
  method: string;
  reciprocalRank: number;
  hitAt3: boolean;
  hitAt5: boolean;
  latencyMs: number;
  resultCount: number;
};

export type TierMetrics = {
  hitAt3: number;
  hitAt5: number;
  mrr: number;
  queryCount: number;
};

export type TimedStats = {
  p50_ms: number;
  p95_ms: number;
  mean_ms: number;
  runs: number;
};

export type BenchReport = {
  profile: string;
  generated_at: string;
  corpus: {
    sessions: number;
    messages: number;
    projects: number;
  };
  quality: {
    easy: TierMetrics;
    medium: TierMetrics;
    hard: TierMetrics;
    byMethod: Record<string, TierMetrics>;
    combined: number;
  };
  performance: {
    fts: TimedStats;
    filtered: TimedStats;
    recall: TimedStats;
  } | null;
  thresholds: {
    passed: boolean;
    checks: Array<{
      name: string;
      actual: number;
      required: number;
      passed: boolean;
    }>;
  };
  queryDetails: QueryResult[];
};

// =============================================================================
// Tunable Parameters (for future autonomous optimization)
// =============================================================================

export type TunableParams = {
  bm25Weights: number[];
  rrfK: number;
  rrfWeights: [number, number];
  overfetchMultiplier: number;
};

// =============================================================================
// CLI Options
// =============================================================================

export type BenchOptions = {
  profile: ProfileName;
  json: boolean;
  outPath?: string;
  comparePath?: string;
  skipPerf: boolean;
  save: boolean;
  history: boolean;
  realDb?: import("bun:sqlite").Database;
};
