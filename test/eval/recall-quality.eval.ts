/**
 * test/eval/recall-quality.eval.ts - Tier 2 of the recall-quality harness:
 * the full fixture set from test/eval/fixtures/, including scenarios that
 * need a live embedding backend to exercise genuinely semantic (non-lexical)
 * matches — the CI-safe BM25-only subset already runs automatically as
 * test/recall-quality.test.ts.
 *
 * NOT a bun:test file (no *.test.ts suffix) — needs a live embedding model
 * (local llama.cpp, already a dependency, or Ollama via QMD_MEMORY_MODEL) and
 * is slower than the CI subset, so it's excluded from `bun test` and run
 * manually:
 *
 *   bun run test/eval/recall-quality.eval.ts
 */

import { initSmriti, closeDb } from "../../src/db";
import { embedMemoryMessages } from "../../src/qmd";
import { ALL_SCENARIOS } from "./fixtures/index";
import { seedScenario } from "./fixtures/seed";
import { runProbe, DEFAULT_TOP_K } from "./fixtures/run";
import { summarizeScores, type ProbeScore } from "./fixtures/score";
import type { RecallScenario } from "./fixtures/types";

type ProbeRun = { scenario: RecallScenario; query: string; description: string; score: ProbeScore; latencyMs: number; usedVectors: boolean };

async function runScenario(scenario: RecallScenario): Promise<ProbeRun[]> {
  const db = await initSmriti(":memory:");
  const runs: ProbeRun[] = [];
  try {
    await seedScenario(db, scenario);

    let embedded = 0;
    try {
      embedded = await embedMemoryMessages(db as any);
    } catch (err: any) {
      console.log(`  [warn] embedMemoryMessages failed for "${scenario.name}": ${err.message}`);
    }
    if (scenario.requiresEmbeddings && embedded === 0) {
      console.log(`  [warn] "${scenario.name}" needs embeddings but none were generated — results below may be BM25-only.`);
    }

    for (const probe of scenario.probes) {
      const { score, latencyMs, sources } = await runProbe(db, scenario, probe, { fast: false });
      runs.push({
        scenario,
        query: probe.query,
        description: probe.description,
        score,
        latencyMs,
        usedVectors: sources.includes("vec"),
      });
    }
  } finally {
    await closeDb();
  }
  return runs;
}

async function main() {
  const embeddingScenarioCount = ALL_SCENARIOS.filter((s) => s.requiresEmbeddings).length;
  console.log(`Running ${ALL_SCENARIOS.length} scenarios (${embeddingScenarioCount} require embeddings)...\n`);

  const allRuns: ProbeRun[] = [];

  for (const scenario of ALL_SCENARIOS) {
    console.log(`## ${scenario.name}${scenario.requiresEmbeddings ? " (requires embeddings)" : ""}`);
    const runs = await runScenario(scenario);
    allRuns.push(...runs);

    for (const r of runs) {
      const status = r.score.pass ? "PASS" : "FAIL";
      const vecTag = scenario.requiresEmbeddings ? (r.usedVectors ? " [vec]" : " [vec DID NOT FIRE]") : "";
      console.log(
        `  [${status}] "${r.query}" — recall=${r.score.recall.toFixed(2)} precision=${r.score.precision === null ? "n/a" : r.score.precision.toFixed(2)} substrings=${r.score.substringOk}${vecTag} (${r.latencyMs.toFixed(0)}ms)`
      );
      if (!r.score.pass) console.log(`         ${r.description}`);
    }
    console.log();
  }

  const summary = summarizeScores(allRuns.map((r) => r.score));
  const vectorScenarios = allRuns.filter((r) => r.scenario.requiresEmbeddings);
  const vectorsFired = vectorScenarios.filter((r) => r.usedVectors).length;

  console.log("=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Probes graded:        ${summary.total}`);
  console.log(`Probes passed:        ${summary.passed}/${summary.total}`);
  console.log(`Avg recall:           ${summary.avgRecall.toFixed(2)}`);
  console.log(`Avg precision:        ${summary.avgPrecision === null ? "n/a" : summary.avgPrecision.toFixed(2)}`);
  console.log(`Top-K:                ${DEFAULT_TOP_K} (per-probe override via topK)`);
  if (vectorScenarios.length > 0) {
    console.log(`Vector search fired:  ${vectorsFired}/${vectorScenarios.length} embedding-dependent probes`);
    if (vectorsFired < vectorScenarios.length) {
      console.log(`  -> some embedding-dependent probes silently fell back to BM25-only. Check that a local embedding model or Ollama is reachable.`);
    }
  }
}

await main();
