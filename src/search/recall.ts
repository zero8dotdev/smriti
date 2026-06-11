/**
 * search/recall.ts - Enhanced recall with category/project/agent filters
 *
 * Wraps QMD's recallMemories() and adds filtering before synthesis.
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_RECALL_LIMIT, OLLAMA_HOST, OLLAMA_MODEL } from "../config";
import { recallMemories, ollamaRecall } from "../qmd";
import { searchFiltered, type SearchFilters, type SearchResult } from "./index";
import { getQmdStore } from "../store";

// =============================================================================
// Types
// =============================================================================

export type RecallOptions = SearchFilters & {
  synthesize?: boolean;
  model?: string;
  maxTokens?: number;
  fast?: boolean;
  wide?: boolean;
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
  // --wide bypasses the project filter: search all projects, rerank with project as intent
  const effectiveProject = (options.wide && options.project) ? undefined : options.project;
  const rerankIntent = (options.wide && options.project)
    ? `relevant to ${options.project} project context`
    : undefined;

  const hasFilters = options.category || effectiveProject || options.agent
    || options.includeThinking || options.includeArtifacts === false
    || options.includeAttachments === false || options.includeVoiceNotes === false;

  if (!hasFilters) {
    // When smriti-sessions QMD collection has documents, use store.search() for full hybrid pipeline
    const storeResults = await tryQmdSessionSearch(query, options.limit || DEFAULT_RECALL_LIMIT, rerankIntent, options.fast);
    if (storeResults) {
      let synthesis: string | undefined;
      if (options.synthesize && storeResults.length > 0) {
        synthesis = await synthesizeResults(query, storeResults, options);
      }
      return { results: storeResults, synthesis };
    }

    // Fallback: QMD's memory recall (recallMemories)
    const qmdResult = await recallMemories(db, query, {
      limit: options.limit || DEFAULT_RECALL_LIMIT,
      synthesize: options.synthesize,
      model: options.model,
      maxTokens: options.maxTokens,
      fast: options.fast,
      intent: rerankIntent,
    });
    return {
      results: qmdResult.results,
      synthesis: qmdResult.synthesis,
    };
  }

  // Filtered recall
  const results = searchFiltered(db, query, {
    category: options.category,
    project: effectiveProject,
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
 * Try QMD store.search() on the smriti-sessions collection.
 * Returns null if the collection doesn't exist or has no documents.
 * Maps HybridQueryResult[] to SearchResult[] so callers are unchanged.
 */
async function tryQmdSessionSearch(
  query: string,
  limit: number,
  intent?: string,
  fast?: boolean
): Promise<SearchResult[] | null> {
  try {
    const store = getQmdStore();
    const collections = await store.listCollections();
    const sessionsCol = collections.find(c => c.name === "smriti-sessions");
    if (!sessionsCol || sessionsCol.doc_count === 0) return null;

    const results = await store.search({
      query,
      collections: ["smriti-sessions"],
      limit,
      intent,
      rerank: !fast,
    });

    return results.map(r => {
      // Extract session_id from the file path: smriti-sessions/<session_id>.md
      const filename = r.file.split("/").pop()?.replace(/\.md$/, "") ?? r.file;
      return {
        session_id: filename,
        session_title: r.title,
        message_id: 0,
        role: "session",
        content: r.bestChunk || r.body.slice(0, 500),
        score: r.score,
        source: "qmd",
      } as SearchResult;
    });
  } catch {
    return null;
  }
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
