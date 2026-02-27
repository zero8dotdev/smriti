import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { ingest } from "../src/ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function makeCodexJsonl(messages: number): string {
  const lines: string[] = [];
  for (let i = 0; i < messages; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const content =
      role === "user"
        ? `User prompt ${i}: auth cache schema vector query`
        : `Assistant reply ${i}: implementation details for indexing and recall`;
    lines.push(
      JSON.stringify({
        role,
        content,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      })
    );
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const sessions = Math.max(1, Number(arg("--sessions") || "120"));
  const messagesPerSession = Math.max(1, Number(arg("--messages") || "12"));

  const tempDir = mkdtempSync(join(tmpdir(), "smriti-ingest-pipeline-"));
  const logsDir = join(tempDir, "codex-logs");
  const dbPath = join(tempDir, "bench.sqlite");
  mkdirSync(logsDir, { recursive: true });

  for (let s = 0; s < sessions; s++) {
    const subDir = join(logsDir, `2026-02-${String((s % 28) + 1).padStart(2, "0")}`);
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, `session-${s}.jsonl`);
    writeFileSync(filePath, makeCodexJsonl(messagesPerSession));
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);
  initializeSmritiTables(db);
  seedDefaults(db);

  const started = Bun.nanoseconds();
  const result = await ingest(db, "codex", { logsDir });
  const totalMs = (Bun.nanoseconds() - started) / 1_000_000;
  const throughput = result.messagesIngested / (totalMs / 1000);

  console.log(
    JSON.stringify(
      {
        sessions,
        messages_per_session: messagesPerSession,
        sessions_ingested: result.sessionsIngested,
        messages_ingested: result.messagesIngested,
        elapsed_ms: Number(totalMs.toFixed(2)),
        throughput_msgs_per_sec: Number(throughput.toFixed(2)),
        errors: result.errors.length,
      },
      null,
      2
    )
  );

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
