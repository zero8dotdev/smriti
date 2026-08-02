/**
 * test/eval/fixtures/seed.ts - Seed a RecallScenario's sessions directly into
 * a Smriti DB, bypassing real agent-log parsing entirely (mirrors the
 * seedSession() helper in test/learn-consolidate.test.ts).
 */

import type { Database } from "bun:sqlite";
import { addMessage } from "../../../src/qmd";
import { upsertProject, upsertSessionMeta, updateDensityScore } from "../../../src/db";
import type { RecallScenario } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function seedScenario(db: Database, scenario: RecallScenario): Promise<void> {
  const projects = new Set([scenario.project, ...scenario.sessions.map((s) => s.project ?? scenario.project)]);
  for (const project of projects) upsertProject(db, project);

  for (const session of scenario.sessions) {
    const createdAt = new Date(Date.now() - (session.daysAgo ?? 0) * DAY_MS).toISOString();
    for (const m of session.messages) {
      await addMessage(db as any, session.id, m.role, m.content, { timestamp: createdAt });
    }
    upsertSessionMeta(db, session.id, "claude-code", session.project ?? scenario.project);
    if (session.densityScore !== undefined) {
      updateDensityScore(db, session.id, session.densityScore);
    }
  }
}
