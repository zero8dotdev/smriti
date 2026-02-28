/**
 * team/segment.ts - Stage 1: Session segmentation into knowledge units
 *
 * Analyzes a session using LLM to identify distinct knowledge units
 * (e.g., "token expiry bug", "redis caching decision") that can be
 * documented independently.
 */

import { join } from "path";
import type { Database } from "bun:sqlite";
import type { RawMessage } from "./formatter";
import { filterMessages, mergeConsecutive } from "./formatter";
import { callOllama } from "./ollama";
import { isValidCategory } from "../categorize/schema";
import type {
  KnowledgeUnit,
  SegmentationResult,
  SegmentationOptions,
} from "./types";

// =============================================================================
// Prompt Loading
// =============================================================================

const PROMPT_PATH = join(import.meta.dir, "prompts", "stage1-segment.md");

async function loadSegmentationPrompt(): Promise<string> {
  const file = Bun.file(PROMPT_PATH);
  return file.text();
}

// =============================================================================
// Session Metadata Extraction
// =============================================================================

/**
 * Extract operational metadata from session for LLM context injection.
 * This helps the LLM understand session phases and detect distinct topics.
 */
function extractSessionMetadata(
  db: Database,
  sessionId: string,
  messages: RawMessage[]
): Record<string, string> {
  // Get tool usage summary
  const toolUse = db
    .prepare(
      `SELECT tool_name, COUNT(*) as count FROM smriti_tool_usage
       WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC LIMIT 10`
    )
    .all(sessionId) as Array<{ tool_name: string; count: number }>;
  const toolsUsed = toolUse.map((t) => `${t.tool_name} (${t.count}x)`).join(", ");

  // Get file operations
  const files = db
    .prepare(
      `SELECT DISTINCT file_path FROM smriti_file_operations
       WHERE session_id = ? LIMIT 20`
    )
    .all(sessionId) as Array<{ file_path: string }>;
  const filesModified = files.map((f) => f.file_path).join(", ");

  // Get git operations
  const gitOps = db
    .prepare(
      `SELECT operation, COUNT(*) as count FROM smriti_git_operations
       WHERE session_id = ? GROUP BY operation`
    )
    .all(sessionId) as Array<{ operation: string; count: number }>;
  const gitOperations = gitOps.map((g) => `${g.operation} (${g.count}x)`).join(", ");

  // Get error counts
  const errorCount = db
    .prepare(`SELECT COUNT(*) as count FROM smriti_errors WHERE session_id = ?`)
    .get(sessionId) as { count: number };

  // Get test results (rough heuristic)
  const testResults = messages.some((m) => m.content.includes("bun test"))
    ? "Tests run"
    : "No tests recorded";

  // Calculate duration from message timestamps
  const msgTimestamps = db
    .prepare(
      `SELECT MIN(created_at) as first_at, MAX(created_at) as last_at
       FROM memory_messages WHERE session_id = ?`
    )
    .get(sessionId) as { first_at: string | null; last_at: string | null } | null;

  let duration = 0;
  if (msgTimestamps?.first_at && msgTimestamps?.last_at) {
    const diffMs = new Date(msgTimestamps.last_at).getTime() - new Date(msgTimestamps.first_at).getTime();
    duration = Math.max(1, Math.ceil(diffMs / 60_000));
  }

  return {
    duration_minutes: String(duration),
    total_messages: String(messages.length),
    tools_used: toolsUsed || "None",
    files_modified: filesModified || "None",
    git_operations: gitOperations || "None",
    error_count: String(errorCount.count),
    test_results: testResults,
  };
}

// =============================================================================
// Conversation Formatting
// =============================================================================

/**
 * Format messages for LLM injection (with line number tracking)
 */
function formatConversationForPrompt(
  messages: RawMessage[]
): { text: string; lineCount: number } {
  const filtered = filterMessages(messages);
  const merged = mergeConsecutive(filtered);

  const lines: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    lines.push(`[${i}] **${m.role}**: ${m.content}`);
  }

  let text = lines.join("\n\n");

  // Truncate if too large (keep end)
  const MAX_CHARS = 12000;
  if (text.length > MAX_CHARS) {
    text = "[... earlier conversation ...]\n\n" + text.slice(-MAX_CHARS);
  }

  return { text, lineCount: merged.length };
}

// =============================================================================
// JSON Parsing
// =============================================================================

interface RawSegmentationUnit {
  topic: string;
  category: string;
  relevance: number;
  entities?: string[];
  lineRanges?: Array<{ start: number; end: number }>;
}

interface RawSegmentationResponse {
  units: RawSegmentationUnit[];
}

/**
 * Parse JSON response from LLM, with fallback
 */
function parseSegmentationResponse(text: string): RawSegmentationUnit[] {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : text;

  try {
    const parsed = JSON.parse(jsonStr) as RawSegmentationResponse;
    return parsed.units || [];
  } catch (err) {
    console.warn("Failed to parse segmentation JSON, falling back to single unit");
    return [];
  }
}

// =============================================================================
// Segmentation
// =============================================================================

/**
 * Validate and normalize a category against known taxonomy.
 * Falls back to parent category, then "uncategorized".
 */
function validateCategory(db: Database, category: string): string {
  if (isValidCategory(db, category)) return category;

  // Try parent category
  const parts = category.split("/");
  if (parts.length > 1) {
    const parent = parts[0];
    if (isValidCategory(db, parent)) return parent;
  }

  return "uncategorized";
}

/**
 * Convert raw units to KnowledgeUnit with proper formatting
 */
function normalizeUnits(
  rawUnits: RawSegmentationUnit[],
  db: Database,
  allMessages: RawMessage[]
): KnowledgeUnit[] {
  const units: KnowledgeUnit[] = [];

  for (const raw of rawUnits) {
    const category = validateCategory(db, raw.category);
    const lineRanges = raw.lineRanges || [{ start: 0, end: allMessages.length }];

    // Extract plain text for this unit
    const filtered = filterMessages(allMessages);
    const merged = mergeConsecutive(filtered);
    const unitMessages: string[] = [];

    for (const range of lineRanges) {
      for (let i = range.start; i < Math.min(range.end, merged.length); i++) {
        unitMessages.push(merged[i].content);
      }
    }

    const plainText = unitMessages.join("\n\n");

    units.push({
      id: crypto.randomUUID(),
      topic: raw.topic,
      category,
      relevance: Math.max(0, Math.min(10, raw.relevance || 5)),
      entities: raw.entities || [],
      files: [], // Will be populated later if needed
      plainText,
      lineRanges,
    });
  }

  return units;
}

/**
 * Stage 1: Segment a session into knowledge units
 */
export async function segmentSession(
  db: Database,
  sessionId: string,
  messages: RawMessage[],
  options: SegmentationOptions = {}
): Promise<SegmentationResult> {
  const startTime = Date.now();

  // Extract metadata
  const metadata = extractSessionMetadata(db, sessionId, messages);

  // Format conversation
  const { text: conversation } = formatConversationForPrompt(messages);

  // Load prompt
  const template = await loadSegmentationPrompt();

  // Inject values
  let prompt = template;
  for (const [key, value] of Object.entries(metadata)) {
    prompt = prompt.replace(`{{${key}}}`, value);
  }
  prompt = prompt.replace("{{conversation}}", conversation);

  // Call LLM
  let units: KnowledgeUnit[] = [];

  try {
    const response = await callOllama(prompt, { model: options.model });
    const rawUnits = parseSegmentationResponse(response);
    units = normalizeUnits(rawUnits, db, messages);
  } catch (err) {
    console.warn("Segmentation failed, falling back to single unit:", err);
    // Fallback: treat entire session as single unit
    const filtered = filterMessages(messages);
    const merged = mergeConsecutive(filtered);
    const plainText = merged.map((m) => m.content).join("\n\n");

    units = [
      {
        id: crypto.randomUUID(),
        topic: `Session from ${new Date().toISOString().split("T")[0]}`,
        category: "uncategorized",
        relevance: 6, // Assume session-level share was intentional
        entities: [],
        files: [],
        plainText,
        lineRanges: [{ start: 0, end: merged.length }],
      },
    ];
  }

  return {
    sessionId,
    units,
    rawSessionText: conversation,
    totalMessages: messages.length,
    processingDurationMs: Date.now() - startTime,
  };
}

/**
 * Fallback: Create single unit from entire session
 */
export function fallbackToSingleUnit(
  sessionId: string,
  messages: RawMessage[]
): SegmentationResult {
  const filtered = filterMessages(messages);
  const merged = mergeConsecutive(filtered);
  const plainText = merged.map((m) => m.content).join("\n\n");

  return {
    sessionId,
    units: [
      {
        id: crypto.randomUUID(),
        topic: "Session notes",
        category: "uncategorized",
        relevance: 6,
        entities: [],
        files: [],
        plainText,
        lineRanges: [{ start: 0, end: merged.length }],
      },
    ],
    rawSessionText: plainText,
    totalMessages: messages.length,
    processingDurationMs: 0,
  };
}
