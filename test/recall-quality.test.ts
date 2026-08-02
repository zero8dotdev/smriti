/**
 * test/recall-quality.test.ts - Tier 1 of the recall-quality harness: the
 * BM25-only scenarios from test/eval/fixtures/, run deterministically with
 * no embedding backend needed (recall's project-filtered path never touches
 * vectors; recallMemories's vector search silently no-ops with none).
 *
 * This is the CI-safe subset — it catches regressions in recall()'s
 * filtering/dedup/RRF/density-blending wiring automatically. The full
 * fixture set (including embedding-dependent scenarios) runs manually via
 * `bun run eval:recall` (test/eval/recall-quality.eval.ts).
 */

import { test, expect } from "bun:test";
import { initSmriti, closeDb } from "../src/db";
import { CI_SCENARIOS } from "./eval/fixtures/index";
import { seedScenario } from "./eval/fixtures/seed";
import { runProbe } from "./eval/fixtures/run";

for (const scenario of CI_SCENARIOS) {
  test(`recall quality: ${scenario.name}`, async () => {
    const db = await initSmriti(":memory:");
    try {
      await seedScenario(db, scenario);

      for (const probe of scenario.probes) {
        const { score } = await runProbe(db, scenario, probe, { fast: true });

        expect(score.recall, `recall for "${probe.query}" (${probe.description})`).toBe(1);
        if (score.precision !== null) {
          expect(score.precision, `precision for "${probe.query}" (${probe.description})`).toBe(1);
        }
        expect(score.substringOk, `substring check for "${probe.query}" (${probe.description})`).toBe(true);
      }
    } finally {
      await closeDb();
    }
  });
}
