import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { addMessage, initializeMemoryTables } from "../src/qmd";

type HotpathReport = {
  generated_at: string;
  cases: {
    single_session: {
      messages: number;
      throughput_msgs_per_sec: number;
      p95_ms_per_message: number;
    };
    rotating_sessions: {
      sessions: number;
      messages_per_session: number;
      total_messages: number;
      throughput_msgs_per_sec: number;
      p95_ms_per_message: number;
    };
  };
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] || 0;
}

async function runSingleSession(db: Database, messages: number) {
  const perMsgMs: number[] = [];
  const started = Bun.nanoseconds();
  for (let i = 0; i < messages; i++) {
    const t0 = Bun.nanoseconds();
    await addMessage(
      db,
      "bench-single",
      i % 2 === 0 ? "user" : "assistant",
      `Single session message ${i} auth cache vector schema ${i % 17}`,
      { title: "Bench Single" }
    );
    perMsgMs.push((Bun.nanoseconds() - t0) / 1_000_000);
  }
  const totalMs = (Bun.nanoseconds() - started) / 1_000_000;
  return {
    throughput_msgs_per_sec: Number((messages / (totalMs / 1000)).toFixed(2)),
    p95_ms_per_message: Number(percentile([...perMsgMs].sort((a, b) => a - b), 95).toFixed(3)),
  };
}

async function runRotatingSessions(db: Database, sessions: number, messagesPerSession: number) {
  const perMsgMs: number[] = [];
  const totalMessages = sessions * messagesPerSession;
  const started = Bun.nanoseconds();
  for (let s = 0; s < sessions; s++) {
    const sessionId = `bench-rot-${s}`;
    for (let i = 0; i < messagesPerSession; i++) {
      const t0 = Bun.nanoseconds();
      await addMessage(
        db,
        sessionId,
        i % 2 === 0 ? "user" : "assistant",
        `Rotating session ${s} message ${i} index query latency throughput`,
        { title: `Bench Rotating ${s}` }
      );
      perMsgMs.push((Bun.nanoseconds() - t0) / 1_000_000);
    }
  }
  const totalMs = (Bun.nanoseconds() - started) / 1_000_000;
  return {
    total_messages: totalMessages,
    throughput_msgs_per_sec: Number((totalMessages / (totalMs / 1000)).toFixed(2)),
    p95_ms_per_message: Number(percentile([...perMsgMs].sort((a, b) => a - b), 95).toFixed(3)),
  };
}

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "smriti-ingest-hotpath-"));
  const dbPath = join(tempDir, "bench.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);

  const single = await runSingleSession(db, 3000);
  const rotating = await runRotatingSessions(db, 300, 10);

  const report: HotpathReport = {
    generated_at: new Date().toISOString(),
    cases: {
      single_session: {
        messages: 3000,
        ...single,
      },
      rotating_sessions: {
        sessions: 300,
        messages_per_session: 10,
        ...rotating,
      },
    },
  };

  console.log(JSON.stringify(report, null, 2));
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
