/**
 * antigravity.ts - Antigravity IDE artifact ingestion
 *
 * Scans ~/.gemini/antigravity/brain for task artifacts and ingest them
 * as structured sessions.
 */

import { existsSync, statSync } from "fs";
import { join, basename } from "path";
import { ANTIGRAVITY_BRAIN_DIR, PROJECTS_ROOT } from "../config";
import { addMessage } from "../qmd";
import type { IngestResult, IngestOptions } from "./index";
import type { StructuredMessage, MessageBlock } from "./types";
import { extractBlocks } from "./blocks"; // Reuse block extractor if helpful, or build simple text blocks

// =============================================================================
// Session Discovery
// =============================================================================

export async function discoverAntigravitySessions(
  brainDir?: string
): Promise<Array<{
  sessionId: string;
  dirPath: string;
}>> {
  const dir = brainDir || ANTIGRAVITY_BRAIN_DIR;
  if (!existsSync(dir)) return [];

  const glob = new Bun.Glob("*");
  const sessions: Array<{ sessionId: string; dirPath: string }> = [];

  for await (const match of glob.scan({ cwd: dir, absolute: false, onlyFiles: false })) {
    const fullPath = join(dir, match);
    if (statSync(fullPath).isDirectory()) {
        // Validation: expecting UUID-like directories
        // But let's just take all directories for now
        sessions.push({
            sessionId: match,
            dirPath: fullPath
        });
    }
  }

  return sessions;
}

// =============================================================================
// Ingestion
// =============================================================================

export async function ingestAntigravity(
  options: IngestOptions = {}
): Promise<IngestResult> {
  const { db, existingSessionIds, onProgress } = options;
  if (!db) throw new Error("Database required for ingestion");

  const { upsertProject, upsertSessionMeta } = await import("../db");

  const sessions = await discoverAntigravitySessions(options.logsDir);
  const result: IngestResult = {
    agent: "antigravity",
    sessionsFound: sessions.length,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  for (const session of sessions) {
    if (existingSessionIds?.has(session.sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      const messages: StructuredMessage[] = [];
      const sessionDir = session.dirPath;

      // 1. Task (User)
      const taskPath = join(sessionDir, "task.md");
      const taskContent = existsSync(taskPath) ? await Bun.file(taskPath).text() : null;
      
      // 2. Implementation Plan (Assistant)
      const planPath = join(sessionDir, "implementation_plan.md");
      const planContent = existsSync(planPath) ? await Bun.file(planPath).text() : null;

      // 3. Walkthrough (Assistant)
      const walkthroughPath = join(sessionDir, "walkthrough.md");
      const walkthroughContent = existsSync(walkthroughPath) ? await Bun.file(walkthroughPath).text() : null;

      if (!taskContent && !planContent && !walkthroughContent) {
          result.skipped++; // Empty or unrecognized session structure
          continue;
      }

      const timestamp = new Date().toISOString(); // Fallback if file times aren't used

      // Helper to build message
      const addMsg = (role: "user" | "assistant", content: string, type: string, seq: number) => {
           messages.push({
               id: `${session.sessionId}-${type}`,
               sessionId: session.sessionId,
               sequence: seq,
               timestamp,
               role,
               agent: "antigravity",
               blocks: [{ type: "text", text: content }] as MessageBlock[],
               metadata: { sourceFile: type } as any,
               plainText: content
           });
      };

      if (taskContent) addMsg("user", taskContent, "task", 0);
      if (planContent) addMsg("assistant", `## Implementation Plan\n\n${planContent}`, "plan", 1);
      if (walkthroughContent) addMsg("assistant", `## Walkthrough\n\n${walkthroughContent}`, "walkthrough", 2);

      // Derive Project ID
      // Antigravity doesn't explicitly link to project path in brain dir structure usually
      // We might fallback to a generic project or try to heuristically find it from task text?
      // For now, let's use "antigravity" or try to find a mention. 
      // Actually, check if there is a way to find project. 
      // If not, put in "antigravity-brain" project.
      const projectId = "antigravity-workspace";
      upsertProject(db, projectId, ANTIGRAVITY_BRAIN_DIR, undefined);
      
      // Extract title from task
      const title = taskContent 
        ? taskContent.split("\n")[0].replace(/^#+\s*/, "").slice(0, 100)
        : `Antigravity Session ${session.sessionId.slice(0,8)}`;

      // Save to QMD
      for (const msg of messages) {
           await addMessage(
               db,
               session.sessionId,
               msg.role,
               msg.plainText,
               {
                   title,
                   metadata: msg.metadata
               }
           );
      }
      
      // Upsert Session Meta
      upsertSessionMeta(db, session.sessionId, "antigravity", projectId);

      result.sessionsIngested++;
      result.messagesIngested += messages.length;
      
      if (onProgress) {
        onProgress(`Ingested ${session.sessionId} (${messages.length} artifacts)`);
      }

    } catch (err: any) {
        result.errors.push(`${session.sessionId}: ${err.message}`);
    }
  }

  return result;
}
