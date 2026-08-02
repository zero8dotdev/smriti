import { AUTH_MIGRATION } from "./auth-migration";
import { DEPLOY_PIPELINE } from "./deploy-pipeline";
import { DENSITY_BLENDING } from "./density-recency";
import { SEMANTIC_CACHING } from "./semantic-caching";
import type { RecallScenario } from "./types";

/** BM25-only scenarios — deterministic, no embeddings needed. Safe for CI. */
export const CI_SCENARIOS: RecallScenario[] = [AUTH_MIGRATION, DEPLOY_PIPELINE, DENSITY_BLENDING];

/** Needs a live embedding backend — manual-only (see test/eval/recall-quality.eval.ts). */
export const QUALITY_ONLY_SCENARIOS: RecallScenario[] = [SEMANTIC_CACHING];

/** Full set — quality mode runs all of these; CI mode filters to CI_SCENARIOS. */
export const ALL_SCENARIOS: RecallScenario[] = [...CI_SCENARIOS, ...QUALITY_ONLY_SCENARIOS];

export type { RecallScenario, FixtureSession, Probe } from "./types";
