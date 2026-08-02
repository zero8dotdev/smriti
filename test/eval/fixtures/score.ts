/**
 * test/eval/fixtures/score.ts - Scoring for recall-quality probes.
 *
 * Precision is computed only against a probe's explicit expectMissSessionIds
 * (known distractors), not exhaustively against everything else — the same
 * "narrow but honest" approach test/eval/relation-inference.eval.ts uses for
 * exact-match grading. We can't exhaustively label every session a probe
 * shouldn't match, so we only assert on the ones we deliberately planted.
 */

import type { Probe } from "./types";

export type ProbeResult = { session_id: string; content: string };

export type ProbeScore = {
  recall: number; // |expected ∩ hit| / |expected|, 1 if no expected hits defined
  precision: number | null; // 1 - |miss ∩ hit| / |hit|, null if the probe defines no distractors
  substringOk: boolean; // true if no expectHitSubstrings, or one matched a retrieved expected-hit row
  pass: boolean;
};

export function scoreProbe(results: ProbeResult[], probe: Probe): ProbeScore {
  const hitIds = new Set(results.map((r) => r.session_id));

  const expected = probe.expectHitSessionIds;
  const hitCount = expected.filter((id) => hitIds.has(id)).length;
  const recall = expected.length ? hitCount / expected.length : 1;

  let precision: number | null = null;
  if (probe.expectMissSessionIds && probe.expectMissSessionIds.length > 0) {
    const missHits = probe.expectMissSessionIds.filter((id) => hitIds.has(id)).length;
    precision = hitIds.size > 0 ? 1 - missHits / hitIds.size : 1;
  }

  let substringOk = true;
  if (probe.expectHitSubstrings && probe.expectHitSubstrings.length > 0) {
    const expectedRows = results.filter((r) => expected.includes(r.session_id));
    substringOk = expectedRows.some((r) =>
      probe.expectHitSubstrings!.some((s) => r.content.toLowerCase().includes(s.toLowerCase()))
    );
  }

  const pass = recall === 1 && (precision === null || precision === 1) && substringOk;
  return { recall, precision, substringOk, pass };
}

export function summarizeScores(scores: ProbeScore[]): {
  total: number;
  passed: number;
  avgRecall: number;
  avgPrecision: number | null;
} {
  const total = scores.length;
  const passed = scores.filter((s) => s.pass).length;
  const avgRecall = total ? scores.reduce((sum, s) => sum + s.recall, 0) / total : 1;
  const withPrecision = scores.filter((s) => s.precision !== null);
  const avgPrecision = withPrecision.length
    ? withPrecision.reduce((sum, s) => sum + (s.precision as number), 0) / withPrecision.length
    : null;
  return { total, passed, avgRecall, avgPrecision };
}
