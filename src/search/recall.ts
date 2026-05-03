/**
 * search/recall.ts - Enhanced recall with category/project/agent filters
 *
 * Wraps QMD's recallMemories() and adds filtering before synthesis.
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_RECALL_LIMIT, OLLAMA_HOST, OLLAMA_MODEL } from "../config";
import { recallMemories, ollamaRecall } from "../qmd";
import { searchFiltered, type SearchFilters, type SearchResult } from "./index";

// =============================================================================
// Types
// =============================================================================

export type RecallOptions = SearchFilters & {
  synthesize?: boolean;
  model?: string;
  maxTokens?: number;
  fast?: boolean;
};

export type RecallResult = {
  results: SearchResult[];
  synthesis?: string;
};

// =============================================================================
// Filtered Recall
// =============================================================================

/**
 * Recall relevant memories with filters.
 * If no filters are specified, falls through to QMD's native recallMemories.
 */
export async function recall(
  db: Database,
  query: string,
  options: RecallOptions = {}
): Promise<RecallResult> {
  const hasFilters = options.category || options.project || options.agent
    || options.includeThinking || options.includeArtifacts === false
    || options.includeAttachments === false || options.includeVoiceNotes === false;

  if (!hasFilters) {
    // Use QMD's native recall for unfiltered queries
    const qmdResult = await recallMemories(db, query, {
      limit: options.limit || DEFAULT_RECALL_LIMIT,
      synthesize: options.synthesize,
      model: options.model,
      maxTokens: options.maxTokens,
      fast: options.fast,
    });
    return {
      results: qmdResult.results,
      synthesis: qmdResult.synthesis,
    };
  }

  // Filtered recall
  const results = searchFiltered(db, query, {
    category: options.category,
    project: options.project,
    agent: options.agent,
    limit: options.limit || DEFAULT_RECALL_LIMIT,
    includeThinking: options.includeThinking,
    includeArtifacts: options.includeArtifacts,
    includeAttachments: options.includeAttachments,
    includeVoiceNotes: options.includeVoiceNotes,
  });

  // Deduplicate by session (keep best score per session)
  const sessionSeen = new Map<string, boolean>();
  const deduped = results.filter((r) => {
    if (sessionSeen.has(r.session_id)) return false;
    sessionSeen.set(r.session_id, true);
    return true;
  });

  // Optionally synthesize
  let synthesis: string | undefined;
  if (options.synthesize && deduped.length > 0) {
    synthesis = await synthesizeResults(query, deduped, options);
  }

  return { results: deduped, synthesis };
}

/**
 * Synthesize search results into a coherent summary using Ollama.
 */
async function synthesizeResults(
  query: string,
  results: SearchResult[],
  options: { model?: string; maxTokens?: number }
): Promise<string | undefined> {
  try {
    const memoriesText = results
      .map(
        (r) =>
          `[Session: ${r.session_title || r.session_id}]\n${r.role}: ${r.content}`
      )
      .join("\n\n---\n\n");

    return await ollamaRecall(query, memoriesText, {
      model: options.model,
      maxTokens: options.maxTokens,
    });
  } catch {
    return undefined;
  }
}
