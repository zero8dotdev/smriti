/**
 * test/eval/relation-inference.eval.ts - Live A/B eval for relationship classification
 *
 * Compares classifyRelationshipsTextFormat ("before" — free-text RELATION
 * lines parsed with a regex) against classifyRelationshipsToolCall ("after"
 * — native tool calling) on a hand-labeled dataset, run against the real
 * configured Ollama model (QMD_MEMORY_MODEL).
 *
 * NOT a bun:test file (no *.test.ts suffix) — it hits a live Ollama server
 * and is slow/non-deterministic, so it's excluded from `bun test` and run
 * manually:
 *
 *   bun run test/eval/relation-inference.eval.ts
 */

import {
  classifyRelationshipsTextFormat,
  classifyRelationshipsToolCall,
  type RelationCandidate,
  type RelationGuess,
} from "../../src/learn/consolidate";

// =============================================================================
// Dataset
// =============================================================================

type Scenario = {
  name: string;
  unit: { topic: string; category: string; plainText: string };
  candidates: RelationCandidate[];
  expected: Array<RelationGuess["predicate"]>; // one expected predicate per candidate index
};

const SCENARIOS: Scenario[] = [
  {
    name: "supersedes (reverted retrieval strategy)",
    unit: {
      topic: "Post-filtering for vector search",
      category: "architecture/decision",
      plainText:
        "Switched the recall pipeline from pre-filtering to post-filtering with 3x overfetch, because pre-filtering caused sqlite-vec to hang when combined with JOINs on metadata tables.",
    },
    candidates: [
      { id: "c1", topic: "Pre-filtering for vector search", category: "architecture/decision", plain_text: "Decision: use pre-filtering — apply metadata filters directly inside the sqlite-vec query before ranking." },
    ],
    expected: ["supersedes"],
  },
  {
    name: "contradicts (daemon enrichment safety)",
    unit: {
      topic: "Inline LLM enrichment on daemon flush",
      category: "architecture/decision",
      plainText: "Team decided synchronous LLM enrichment on every daemon flush is safe and should run inline with ingestion.",
    },
    candidates: [
      { id: "c1", topic: "Daemon flush safety", category: "architecture/decision", plain_text: "Decision: LLM enrichment must never run inline with daemon flush — it blocks ingestion and risks corrupting the write path under load." },
    ],
    expected: ["contradicts"],
  },
  {
    name: "relatesTo (complementary recall features)",
    unit: {
      topic: "Cluster-scoped recall",
      category: "feature/implementation",
      plainText: "Added a --cluster flag to `smriti recall` for topic-scoped retrieval using O(1) Set membership checks.",
    },
    candidates: [
      { id: "c1", topic: "RRF for recall", category: "feature/implementation", plain_text: "Implemented reciprocal rank fusion (RRF) to combine BM25 and vector search results in `smriti recall`." },
    ],
    expected: ["relatesTo"],
  },
  {
    name: "none (unrelated domains)",
    unit: {
      topic: "Blog hover overlay CSS bug",
      category: "bug/fix",
      plainText: "Fixed a CSS bug where the hover overlay button showed a stray `.bv-tag` element on blog post cards.",
    },
    candidates: [
      { id: "c1", topic: "Content hashing for dedup", category: "architecture/decision", plain_text: "Chose SHA256 content-addressable hashing for deduplicating ingested messages in QMD's content table." },
    ],
    expected: ["none"],
  },
  {
    name: "supersedes (auth mechanism reversal)",
    unit: {
      topic: "Session cookies for auth",
      category: "architecture/decision",
      plainText: "Reverted from JWT-based session tokens to server-side session cookies after security review flagged JWT revocation as unsupported.",
    },
    candidates: [
      { id: "c1", topic: "JWT session tokens", category: "architecture/decision", plain_text: "Adopted JWT-based session tokens for stateless auth across services." },
    ],
    expected: ["supersedes"],
  },
  {
    name: "contradicts (MLX engine routing)",
    unit: {
      topic: "MLX engine routing in Ollama",
      category: "topic/learning",
      plainText: "Confirmed that `ollama pull` for MLX-tagged models requires model names ending in `-mlx`; regular GGUF pulls never use the MLX engine.",
    },
    candidates: [
      { id: "c1", topic: "MLX engine routing in Ollama", category: "topic/learning", plain_text: "Established that any GGUF model pulled via `ollama pull` automatically runs on the MLX engine on Apple Silicon." },
    ],
    expected: ["contradicts"],
  },
  {
    name: "relatesTo (ollama runner history)",
    unit: {
      topic: "Ollama runner architecture",
      category: "topic/learning",
      plainText: "Documented that Ollama's new llama-server-based runner replaced the old Go --ollama-engine runner starting in a later 0.x release.",
    },
    candidates: [
      { id: "c1", topic: "Ollama runner architecture", category: "topic/learning", plain_text: "Verified Ollama 0.18 uses the ggml/Metal engine via a custom Go runner (--ollama-engine), not MLX, for standard GGUF models." },
    ],
    expected: ["relatesTo"],
  },
  {
    name: "none (video upload vs tool-calling investigation)",
    unit: {
      topic: "Video metadata capture timeout",
      category: "bug/fix",
      plainText: "Fixed timeout and cancel handling in captureVideoMetadata to stop hangs during community photo/video upload.",
    },
    candidates: [
      { id: "c1", topic: "MLX tool calling", category: "topic/learning", plain_text: "Investigated whether qwen3.5:9b-mlx-tuned supports native tool calling; confirmed via a /api/chat request with a get_weather tool schema." },
    ],
    expected: ["none"],
  },
  {
    name: "multi-candidate index alignment",
    unit: {
      topic: "Standardize on post-filtering",
      category: "architecture/decision",
      plainText: "Standardized on post-filtering with 3x overfetch for all vector search filtering across projects.",
    },
    candidates: [
      { id: "c1", topic: "Pre-filtering for vector search", category: "architecture/decision", plain_text: "Decision: use pre-filtering — apply metadata filters directly inside the sqlite-vec query." },
      { id: "c2", topic: "RRF for recall", category: "feature/implementation", plain_text: "Implemented RRF to merge BM25 and vector search scores." },
      { id: "c3", topic: "Blog hover overlay CSS bug", category: "bug/fix", plain_text: "Fixed a CSS bug in blog post hover overlays." },
    ],
    expected: ["supersedes", "relatesTo", "none"],
  },
];

// =============================================================================
// Runner
// =============================================================================

type MethodResult = {
  guesses: RelationGuess[];
  latencyMs: number;
  error?: string;
};

async function runMethod(
  fn: (unit: Scenario["unit"], candidates: RelationCandidate[], model?: string) => Promise<RelationGuess[]>,
  scenario: Scenario
): Promise<MethodResult> {
  const start = performance.now();
  try {
    const guesses = await fn(scenario.unit, scenario.candidates);
    return { guesses, latencyMs: performance.now() - start };
  } catch (err: any) {
    return { guesses: [], latencyMs: performance.now() - start, error: err.message };
  }
}

function grade(scenario: Scenario, guesses: RelationGuess[]) {
  const byIndex = new Map(guesses.map((g) => [g.index, g.predicate]));
  return scenario.expected.map((expected, index) => ({
    index,
    expected,
    got: byIndex.get(index) ?? "(missing)",
    correct: byIndex.get(index) === expected,
  }));
}

async function main() {
  console.log(`Running ${SCENARIOS.length} scenarios against both classifiers...\n`);

  let textCorrect = 0, toolCorrect = 0, total = 0;
  let textParseFailures = 0, toolParseFailures = 0;
  let textLatencyTotal = 0, toolLatencyTotal = 0;

  for (const scenario of SCENARIOS) {
    console.log(`## ${scenario.name}`);

    // Sequential, not Promise.all: this Ollama server has OLLAMA_NUM_PARALLEL=1,
    // so concurrent requests queue behind each other on the server anyway —
    // running them "in parallel" here would just make one eat into the
    // other's client-side timeout while it waits for a free slot.
    const textResult = await runMethod(classifyRelationshipsTextFormat, scenario);
    const toolResult = await runMethod(classifyRelationshipsToolCall, scenario);

    textLatencyTotal += textResult.latencyMs;
    toolLatencyTotal += toolResult.latencyMs;
    if (textResult.guesses.length === 0 && scenario.expected.length > 0) textParseFailures++;
    if (toolResult.guesses.length === 0 && scenario.expected.length > 0) toolParseFailures++;

    const textGrades = grade(scenario, textResult.guesses);
    const toolGrades = grade(scenario, toolResult.guesses);

    for (let i = 0; i < scenario.expected.length; i++) {
      total++;
      const t = textGrades[i]!;
      const m = toolGrades[i]!;
      if (t.correct) textCorrect++;
      if (m.correct) toolCorrect++;

      console.log(
        `  [${i}] expected=${t.expected.padEnd(11)} text-format=${String(t.got).padEnd(11)}${t.correct ? " ok " : " MISS"}  tool-call=${String(m.got).padEnd(11)}${m.correct ? " ok " : " MISS"}`
      );
    }
    console.log(
      `  latency: text-format=${textResult.latencyMs.toFixed(0)}ms  tool-call=${toolResult.latencyMs.toFixed(0)}ms`
    );
    if (textResult.error) console.log(`  text-format error: ${textResult.error}`);
    if (toolResult.error) console.log(`  tool-call error: ${toolResult.error}`);
    console.log();
  }

  console.log("=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Judgments graded:        ${total}`);
  console.log(`text-format accuracy:    ${textCorrect}/${total} (${((textCorrect / total) * 100).toFixed(1)}%)`);
  console.log(`tool-call accuracy:      ${toolCorrect}/${total} (${((toolCorrect / total) * 100).toFixed(1)}%)`);
  console.log(`text-format parse fails: ${textParseFailures}/${SCENARIOS.length} scenarios (zero guesses returned)`);
  console.log(`tool-call parse fails:   ${toolParseFailures}/${SCENARIOS.length} scenarios (zero guesses returned)`);
  console.log(`text-format avg latency: ${(textLatencyTotal / SCENARIOS.length).toFixed(0)}ms`);
  console.log(`tool-call avg latency:   ${(toolLatencyTotal / SCENARIOS.length).toFixed(0)}ms`);
}

await main();
