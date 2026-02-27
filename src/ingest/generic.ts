/**
 * generic.ts - Generic file parser for importing transcripts
 *
 * Supports chat format (role: content) and JSONL format.
 * Wraps QMD's importTranscript() with Smriti metadata.
 */

import type { IngestResult, IngestOptions } from "./index";

export type GenericIngestOptions = IngestOptions & {
  filePath: string;
  format?: "chat" | "jsonl";
  agentName?: string;
  title?: string;
  sessionId?: string;
  projectId?: string;
};

/**
 * Ingest a transcript file using QMD's importTranscript.
 */
export async function ingestGeneric(
  options: GenericIngestOptions
): Promise<IngestResult> {
  const { db, filePath, format, agentName, title, sessionId, projectId } = options;
  if (!db) throw new Error("Database required for ingestion");
  const { ingest } = await import("./index");
  return ingest(db, "generic", {
    filePath,
    format,
    title,
    sessionId,
    projectId,
  });
}
