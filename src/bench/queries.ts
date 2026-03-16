/**
 * bench/queries.ts - Ground truth query suite for quality benchmarking
 *
 * 36 queries across 3 difficulty tiers and 3 search methods.
 * Each query maps to expected session IDs from the corpus.
 */

import type { BenchQuery } from "./types";

// =============================================================================
// Easy Queries (12) — exact keywords, tests FTS path
// =============================================================================

const EASY: BenchQuery[] = [
  {
    id: "easy-01",
    query: "JWT token refresh bug",
    difficulty: "easy",
    expectedSessionIds: ["bench-s02"],
    method: "fts",
  },
  {
    id: "easy-02",
    query: "Kubernetes helm charts namespace",
    difficulty: "easy",
    expectedSessionIds: ["bench-s09"],
    method: "fts",
  },
  {
    id: "easy-03",
    query: "PyTorch DataLoader GPU utilization",
    difficulty: "easy",
    expectedSessionIds: ["bench-s05"],
    method: "fts",
  },
  {
    id: "easy-04",
    query: "rate limiting middleware Redis",
    difficulty: "easy",
    expectedSessionIds: ["bench-s04"],
    method: "fts",
  },
  {
    id: "easy-05",
    query: "model overfitting dropout regularization",
    difficulty: "easy",
    expectedSessionIds: ["bench-s06"],
    method: "fts",
  },
  {
    id: "easy-06",
    query: "database sharding consistent hashing",
    difficulty: "easy",
    expectedSessionIds: ["bench-s11"],
    method: "fts",
  },
  {
    id: "easy-07",
    query: "OAuth2 Google authorization PKCE",
    difficulty: "easy",
    expectedSessionIds: ["bench-s03"],
    method: "fts",
  },
  {
    id: "easy-08",
    query: "GitHub Actions matrix strategy CI pipeline",
    difficulty: "easy",
    expectedSessionIds: ["bench-s10"],
    method: "fts",
  },
  {
    id: "easy-09",
    query: "batch inference scaling Ray Serve",
    difficulty: "easy",
    expectedSessionIds: ["bench-s08"],
    method: "fts",
  },
  {
    id: "easy-10",
    query: "incident postmortem connection pool outage",
    difficulty: "easy",
    expectedSessionIds: ["bench-s12"],
    method: "fts",
  },
  {
    id: "easy-11",
    query: "RBAC bcrypt password hashing authentication",
    difficulty: "easy",
    expectedSessionIds: ["bench-s01"],
    method: "fts",
  },
  {
    id: "easy-12",
    query: "feature store Parquet versioning",
    difficulty: "easy",
    expectedSessionIds: ["bench-s07"],
    method: "fts",
  },
];

// =============================================================================
// Medium Queries (12) — paraphrased, tests recall path
// =============================================================================

const MEDIUM: BenchQuery[] = [
  {
    id: "med-01",
    query: "how did we handle user login security",
    difficulty: "medium",
    expectedSessionIds: ["bench-s01"],
    method: "recall",
  },
  {
    id: "med-02",
    query: "what was wrong with the token expiration",
    difficulty: "medium",
    expectedSessionIds: ["bench-s02"],
    method: "recall",
  },
  {
    id: "med-03",
    query: "third party sign-in provider integration",
    difficulty: "medium",
    expectedSessionIds: ["bench-s03"],
    method: "recall",
  },
  {
    id: "med-04",
    query: "throttling API requests per user",
    difficulty: "medium",
    expectedSessionIds: ["bench-s04"],
    method: "recall",
  },
  {
    id: "med-05",
    query: "setting up the deep learning training loop",
    difficulty: "medium",
    expectedSessionIds: ["bench-s05"],
    method: "recall",
  },
  {
    id: "med-06",
    query: "why the model was memorizing training data",
    difficulty: "medium",
    expectedSessionIds: ["bench-s06"],
    method: "recall",
  },
  {
    id: "med-07",
    query: "where should computed features be stored",
    difficulty: "medium",
    expectedSessionIds: ["bench-s07"],
    method: "recall",
  },
  {
    id: "med-08",
    query: "running predictions at scale on multiple GPUs",
    difficulty: "medium",
    expectedSessionIds: ["bench-s08"],
    method: "recall",
  },
  {
    id: "med-09",
    query: "moving containers to cloud orchestration",
    difficulty: "medium",
    expectedSessionIds: ["bench-s09"],
    method: "recall",
  },
  {
    id: "med-10",
    query: "automating build and deploy workflow",
    difficulty: "medium",
    expectedSessionIds: ["bench-s10"],
    method: "recall",
  },
  {
    id: "med-11",
    query: "splitting the database across multiple nodes",
    difficulty: "medium",
    expectedSessionIds: ["bench-s11"],
    method: "recall",
  },
  {
    id: "med-12",
    query: "what caused the production downtime",
    difficulty: "medium",
    expectedSessionIds: ["bench-s12"],
    method: "recall",
  },
];

// =============================================================================
// Hard Queries (12) — conceptual, cross-cutting, uses filters
// =============================================================================

const HARD: BenchQuery[] = [
  {
    id: "hard-01",
    query: "bcrypt vs argon2 password comparison",
    difficulty: "hard",
    expectedSessionIds: ["bench-s01"],
    method: "recall",
  },
  {
    id: "hard-02",
    query: "401 race condition concurrent requests",
    difficulty: "hard",
    expectedSessionIds: ["bench-s02"],
    method: "recall",
  },
  {
    id: "hard-03",
    query: "sliding window algorithm",
    difficulty: "hard",
    expectedSessionIds: ["bench-s04"],
    method: "filtered",
    filters: { includeThinking: true },
  },
  {
    id: "hard-04",
    query: "wandb experiment tracking metrics logging",
    difficulty: "hard",
    expectedSessionIds: ["bench-s05"],
    method: "recall",
  },
  {
    id: "hard-05",
    query: "stratified cross validation class imbalance",
    difficulty: "hard",
    expectedSessionIds: ["bench-s06"],
    method: "recall",
  },
  {
    id: "hard-06",
    query: "columnar storage format for ML features",
    difficulty: "hard",
    expectedSessionIds: ["bench-s07"],
    method: "recall",
  },
  {
    id: "hard-07",
    query: "horizontal pod autoscaler resource limits",
    difficulty: "hard",
    expectedSessionIds: ["bench-s09"],
    method: "recall",
  },
  {
    id: "hard-08",
    query: "canary deploy auto rollback error rate",
    difficulty: "hard",
    expectedSessionIds: ["bench-s10"],
    method: "recall",
  },
  {
    id: "hard-09",
    query: "virtual nodes hash ring partition key",
    difficulty: "hard",
    expectedSessionIds: ["bench-s11"],
    method: "recall",
  },
  {
    id: "hard-10",
    query: "pg_stat_activity idle in transaction",
    difficulty: "hard",
    expectedSessionIds: ["bench-s12"],
    method: "recall",
  },
  {
    id: "hard-11",
    query: "ML training metrics plateau debugging",
    difficulty: "hard",
    expectedSessionIds: ["bench-s06"],
    method: "filtered",
    filters: { project: "ml-pipeline" },
  },
  {
    id: "hard-12",
    query: "auth decisions for the web application",
    difficulty: "hard",
    expectedSessionIds: ["bench-s01", "bench-s02", "bench-s03"],
    method: "filtered",
    filters: { project: "webapp" },
  },
];

// =============================================================================
// Exports
// =============================================================================

export const ALL_QUERIES: BenchQuery[] = [...EASY, ...MEDIUM, ...HARD];

export const QUERIES_BY_DIFFICULTY = {
  easy: EASY,
  medium: MEDIUM,
  hard: HARD,
} as const;
