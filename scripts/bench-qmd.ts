import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  addMessage,
  initializeMemoryTables,
  searchMemoryFTS,
  searchMemoryVec,
  recallMemories,
  embedMemoryMessages,
} from "../src/qmd";

type ProfileName = "ci-small" | "small" | "medium";

type BenchProfile = {
  sessions: number;
  messagesPerSession: number;
  warmupQueries: number;
  measureQueries: number;
};

type TimedStats = { p50_ms: number; p95_ms: number; mean_ms: number; runs: number };

type BenchReport = {
  profile: ProfileName;
  mode: "no-llm" | "llm";
  generated_at: string;
  db_path: string;
  corpus: {
    sessions: number;
    messages_per_session: number;
    total_messages: number;
  };
  metrics: {
    ingest_throughput_msgs_per_sec: number;
    ingest_p95_ms_per_session: number;
    fts: TimedStats;
    recall: TimedStats;
    vector: TimedStats | null;
  };
  counts: {
    memory_sessions: number;
    memory_messages: number;
    content_vectors: number;
  };
};

const PROFILES: Record<ProfileName, BenchProfile> = {
  "ci-small": { sessions: 40, messagesPerSession: 10, warmupQueries: 5, measureQueries: 30 },
  small: { sessions: 120, messagesPerSession: 12, warmupQueries: 10, measureQueries: 60 },
  medium: { sessions: 300, messagesPerSession: 16, warmupQueries: 20, measureQueries: 120 },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] || 0;
}

function stats(values: number[]): TimedStats {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    p50_ms: Number(percentile(sorted, 50).toFixed(3)),
    p95_ms: Number(percentile(sorted, 95).toFixed(3)),
    mean_ms: Number(mean.toFixed(3)),
    runs: values.length,
  };
}

function randomWords(seed: number, count: number): string {
  const base = [
    "auth", "cache", "index", "vector", "schema", "session", "query", "deploy",
    "pipeline", "memory", "feature", "bug", "review", "latency", "throughput", "design",
  ];
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(base[(seed + i * 7) % base.length] || "token");
  }
  return parts.join(" ");
}

function makeUserMessage(s: number, m: number): string {
  return `User request ${s}-${m}: ${randomWords(s * 37 + m, 18)}`;
}

function makeAssistantMessage(s: number, m: number): string {
  return `Assistant response ${s}-${m}: ${randomWords(s * 53 + m, 28)} implementation details and tradeoffs.`;
}

async function main() {
  const profileName = (arg("--profile") as ProfileName) || "ci-small";
  const outPath = arg("--out") || join("bench", "results", `${profileName}.json`);
  const mode: "no-llm" | "llm" = has("--llm") ? "llm" : "no-llm";
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown profile: ${profileName}`);

  const tempDir = mkdtempSync(join(tmpdir(), "smriti-bench-"));
  const dbPath = join(tempDir, "bench.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);

  const ingestPerSessionMs: number[] = [];
  const totalMessages = profile.sessions * profile.messagesPerSession;

  for (let s = 0; s < profile.sessions; s++) {
    const sessionId = `bench-s-${s}`;
    const t0 = Bun.nanoseconds();

    for (let m = 0; m < profile.messagesPerSession; m++) {
      const role = m % 2 === 0 ? "user" : "assistant";
      const content = role === "user" ? makeUserMessage(s, m) : makeAssistantMessage(s, m);
      await addMessage(db, sessionId, role, content, { title: `Bench Session ${s}` });
    }

    const dtMs = (Bun.nanoseconds() - t0) / 1_000_000;
    ingestPerSessionMs.push(dtMs);
  }

  const ingestTotalMs = ingestPerSessionMs.reduce((a, b) => a + b, 0);
  const ingestThroughput = totalMessages / (ingestTotalMs / 1000);

  const queries: string[] = [];
  for (let i = 0; i < profile.measureQueries + profile.warmupQueries; i++) {
    queries.push(randomWords(i * 17, 3));
  }

  for (let i = 0; i < profile.warmupQueries; i++) {
    searchMemoryFTS(db, queries[i] || "auth", 10);
    await recallMemories(db, queries[i] || "auth", { limit: 10, synthesize: false });
  }

  const ftsDurations: number[] = [];
  const recallDurations: number[] = [];

  for (let i = profile.warmupQueries; i < queries.length; i++) {
    const q = queries[i] || "auth";

    const tFts = Bun.nanoseconds();
    searchMemoryFTS(db, q, 10);
    ftsDurations.push((Bun.nanoseconds() - tFts) / 1_000_000);

    const tRecall = Bun.nanoseconds();
    await recallMemories(db, q, { limit: 10, synthesize: false });
    recallDurations.push((Bun.nanoseconds() - tRecall) / 1_000_000);
  }

  let vectorStats: TimedStats | null = null;
  if (mode === "llm") {
    try {
      await embedMemoryMessages(db);
      const vecDurations: number[] = [];
      for (let i = profile.warmupQueries; i < queries.length; i++) {
        const q = queries[i] || "auth";
        const tVec = Bun.nanoseconds();
        await searchMemoryVec(db, q, 10);
        vecDurations.push((Bun.nanoseconds() - tVec) / 1_000_000);
      }
      vectorStats = stats(vecDurations);
    } catch {
      vectorStats = null;
    }
  }

  const counts = {
    memory_sessions: (db.prepare("SELECT COUNT(*) as c FROM memory_sessions").get() as { c: number }).c,
    memory_messages: (db.prepare("SELECT COUNT(*) as c FROM memory_messages").get() as { c: number }).c,
    content_vectors: (() => {
      try {
        return (db.prepare("SELECT COUNT(*) as c FROM content_vectors").get() as { c: number }).c;
      } catch {
        return 0;
      }
    })(),
  };

  const report: BenchReport = {
    profile: profileName,
    mode,
    generated_at: new Date().toISOString(),
    db_path: dbPath,
    corpus: {
      sessions: profile.sessions,
      messages_per_session: profile.messagesPerSession,
      total_messages: totalMessages,
    },
    metrics: {
      ingest_throughput_msgs_per_sec: Number(ingestThroughput.toFixed(2)),
      ingest_p95_ms_per_session: Number(percentile([...ingestPerSessionMs].sort((a, b) => a - b), 95).toFixed(3)),
      fts: stats(ftsDurations),
      recall: stats(recallDurations),
      vector: vectorStats,
    },
    counts,
  };

  mkdirSync(join(process.cwd(), "bench", "results"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Benchmark report written: ${outPath}`);
  console.log(JSON.stringify(report.metrics, null, 2));

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
