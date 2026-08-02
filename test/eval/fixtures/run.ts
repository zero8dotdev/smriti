/**
 * test/eval/fixtures/run.ts - Shared probe runner for the recall-quality
 * harness (Tier 1 CI test and Tier 2 manual eval both call this).
 */

import type { Database } from "bun:sqlite";
import { recall } from "../../../src/search/recall";
import { scoreProbe, type ProbeScore } from "./score";
import type { Probe, RecallScenario } from "./types";

export const DEFAULT_TOP_K = 5;

export async function runProbe(
  db: Database,
  scenario: RecallScenario,
  probe: Probe,
  options: { fast: boolean }
): Promise<{ score: ProbeScore; latencyMs: number; sources: string[] }> {
  const limit = probe.topK ?? DEFAULT_TOP_K;
  const started = performance.now();
  const { results } = probe.useRecallMemories
    ? await recall(db, probe.query, { fast: options.fast, limit })
    : await recall(db, probe.query, { project: probe.project ?? scenario.project, fast: options.fast, limit });
  const latencyMs = performance.now() - started;
  const score = scoreProbe(results, probe);
  return { score, latencyMs, sources: [...new Set(results.map((r) => r.source))] };
}
