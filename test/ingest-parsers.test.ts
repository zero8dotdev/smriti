import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseClaude } from "../src/ingest/parsers/claude";
import { parseCodex } from "../src/ingest/parsers/codex";
import { parseCursor } from "../src/ingest/parsers/cursor";
import { parseCline } from "../src/ingest/parsers/cline";
import { parseCopilot } from "../src/ingest/parsers/copilot";
import { parseGeneric } from "../src/ingest/parsers/generic";

async function withTmpDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "smriti-parsers-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseClaude returns ParsedSession with structured messages", async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, "s.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({
          type: "user",
          sessionId: "s1",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "How do we deploy this?" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "s1",
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: "Use blue/green." }] },
        }),
      ].join("\n")
    );

    const parsed = await parseClaude(p, "s1");
    expect(parsed.session.id).toBe("s1");
    expect(parsed.session.title).toContain("How do we deploy this?");
    expect(parsed.messages.length).toBe(2);
  });
});

test("parseCodex returns ParsedSession with title from first user", async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, "c.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ role: "user", content: "Plan caching strategy" }),
        JSON.stringify({ role: "assistant", content: "Use layered cache" }),
      ].join("\n")
    );

    const parsed = await parseCodex(p, "codex-1");
    expect(parsed.session.id).toBe("codex-1");
    expect(parsed.messages.length).toBe(2);
    expect(parsed.session.title).toContain("Plan caching strategy");
  });
});

test("parseCursor returns ParsedSession", async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, "cursor.json");
    writeFileSync(
      p,
      JSON.stringify({
        messages: [
          { role: "user", content: "Implement metrics" },
          { role: "assistant", content: "Added counters." },
        ],
      })
    );

    const parsed = await parseCursor(p, "cursor-1");
    expect(parsed.session.id).toBe("cursor-1");
    expect(parsed.messages.length).toBe(2);
  });
});

test("parseCline returns structured ParsedSession", async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, "task.json");
    writeFileSync(
      p,
      JSON.stringify({
        id: "task-1",
        name: "Fix lint",
        timestamp: new Date().toISOString(),
        history: [
          { ts: new Date().toISOString(), type: "say", text: "I will fix this" },
          { ts: new Date().toISOString(), type: "ask", question: "Proceed?", options: "yes,no" },
        ],
      })
    );

    const parsed = await parseCline(p, "task-1");
    expect(parsed.session.id).toBe("task-1");
    expect(parsed.session.title).toBe("Fix lint");
    expect(parsed.messages.length).toBe(2);
  });
});

test("parseCopilot returns ParsedSession", async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, "copilot.json");
    writeFileSync(
      p,
      JSON.stringify({
        turns: [
          { role: "user", content: "Add tracing" },
          { role: "assistant", content: "Added OpenTelemetry hooks." },
        ],
      })
    );

    const parsed = await parseCopilot(p, "copilot-1");
    expect(parsed.session.id).toBe("copilot-1");
    expect(parsed.messages.length).toBe(2);
  });
});

test("parseGeneric supports chat and jsonl formats", async () => {
  await withTmpDir(async (dir) => {
    const chatPath = join(dir, "chat.txt");
    writeFileSync(chatPath, "user: hello\n\nassistant: hi");

    const jsonlPath = join(dir, "chat.jsonl");
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({ role: "user", content: "u1" }),
        JSON.stringify({ role: "assistant", content: "a1" }),
      ].join("\n")
    );

    const chat = await parseGeneric(chatPath, "g-chat", "chat");
    const jsonl = await parseGeneric(jsonlPath, "g-jsonl", "jsonl");

    expect(chat.messages.length).toBe(2);
    expect(jsonl.messages.length).toBe(2);
  });
});
