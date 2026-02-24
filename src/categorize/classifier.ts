/**
 * categorize/classifier.ts - Rule-based + optional LLM classification
 *
 * Classifies messages and sessions into the Smriti category taxonomy.
 * Rule-based matching runs first; LLM is invoked only for ambiguous cases.
 */

import type { Database } from "bun:sqlite";
import { tagMessage, tagSession } from "../db";
import { CLASSIFY_LLM_THRESHOLD, OLLAMA_HOST, OLLAMA_MODEL } from "../config";
import { ALL_CATEGORY_IDS } from "./schema";
import { getRuleManager, type Rule } from "./rules/loader";

// =============================================================================
// Types
// =============================================================================

export type ClassifyResult = {
  categoryId: string;
  confidence: number;
  source: "rule" | "llm";
};

// =============================================================================
// Rule-Based Classification
// =============================================================================

/**
 * Classify text using loaded YAML rules.
 * Returns all matches sorted by confidence (weight * match density).
 */
export function classifyByRules(text: string, rules: Rule[]): ClassifyResult[] {
  const results: ClassifyResult[] = [];
  const textLower = text.toLowerCase();
  const wordCount = textLower.split(/\s+/).length;
  const ruleManager = getRuleManager();

  for (const rule of rules) {
    const pattern = ruleManager.compilePattern(rule);
    const matches = textLower.match(pattern);
    if (matches) {
      // Density: how many keyword matches relative to text length
      const density = Math.min(matches.length / Math.max(wordCount / 10, 1), 1);
      const confidence = rule.weight * (0.5 + 0.5 * density);
      results.push({
        categoryId: rule.category,
        confidence,
        source: "rule",
      });
    }
  }

  // Deduplicate: keep highest confidence per category
  const best = new Map<string, ClassifyResult>();
  for (const r of results) {
    const existing = best.get(r.categoryId);
    if (!existing || r.confidence > existing.confidence) {
      best.set(r.categoryId, r);
    }
  }

  return Array.from(best.values()).sort((a, b) => b.confidence - a.confidence);
}

// =============================================================================
// LLM Classification (Optional)
// =============================================================================

/**
 * Classify text using Ollama for ambiguous cases.
 * Only called when rule-based confidence is below threshold.
 */
export async function classifyByLLM(
  text: string
): Promise<ClassifyResult | null> {
  try {
    const categoryList = ALL_CATEGORY_IDS.join(", ");
    const prompt = `Classify the following conversation snippet into exactly ONE of these categories: ${categoryList}

Return ONLY the category ID, nothing else.

Text:
${text.slice(0, 2000)}`;

    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 50 },
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { response?: string };
    const categoryId = data.response?.trim().toLowerCase();

    if (categoryId && ALL_CATEGORY_IDS.includes(categoryId as any)) {
      return {
        categoryId,
        confidence: 0.7,
        source: "llm",
      };
    }
  } catch {
    // LLM not available, fall through
  }

  return null;
}

// =============================================================================
// Classification Pipeline
// =============================================================================

/**
 * Classify a single message. Returns the best classification.
 */
export async function classifyMessage(
  text: string,
  options: {
    useLLM?: boolean;
    rules?: Rule[];
  } = {}
): Promise<ClassifyResult | null> {
  // Load rules if not provided
  let rules = options.rules;
  if (!rules) {
    const ruleManager = getRuleManager();
    rules = await ruleManager.loadRules({ language: "general" });
  }

  const ruleResults = classifyByRules(text, rules);

  if (ruleResults.length > 0 && ruleResults[0].confidence >= CLASSIFY_LLM_THRESHOLD) {
    return ruleResults[0];
  }

  // If rule-based is weak and LLM is enabled, try LLM
  if (options.useLLM) {
    const llmResult = await classifyByLLM(text);
    if (llmResult) return llmResult;
  }

  // Return best rule-based even if weak
  return ruleResults[0] || null;
}

/**
 * Auto-categorize all uncategorized sessions in the database.
 */
export async function categorizeUncategorized(
  db: Database,
  options: {
    useLLM?: boolean;
    onProgress?: (msg: string) => void;
    sessionId?: string;
    language?: string;
    framework?: string;
  } = {}
): Promise<{ categorized: number; skipped: number }> {
  let query: string;
  let params: any[];

  if (options.sessionId) {
    query = `
      SELECT ms.id, ms.session_id, ms.role, ms.content
      FROM memory_messages ms
      WHERE ms.session_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM smriti_message_tags mt WHERE mt.message_id = ms.id
        )
      ORDER BY ms.id
    `;
    params = [options.sessionId];
  } else {
    query = `
      SELECT ms.id, ms.session_id, ms.role, ms.content
      FROM memory_messages ms
      WHERE NOT EXISTS (
        SELECT 1 FROM smriti_message_tags mt WHERE mt.message_id = ms.id
      )
      ORDER BY ms.id
    `;
    params = [];
  }

  const messages = db.prepare(query).all(...params) as Array<{
    id: number;
    session_id: string;
    role: string;
    content: string;
  }>;

  // Load rules once for all messages
  const ruleManager = getRuleManager();
  const rules = await ruleManager.loadRules({
    language: options.language || "general",
    framework: options.framework,
  });

  let categorized = 0;
  let skipped = 0;

  // Also track session-level categories
  const sessionCategories = new Map<string, Map<string, number>>();

  for (const msg of messages) {
    const result = await classifyMessage(msg.content, { useLLM: options.useLLM, rules });
    if (result) {
      tagMessage(db, msg.id, result.categoryId, result.confidence, result.source);
      categorized++;

      // Track category frequency per session
      if (!sessionCategories.has(msg.session_id)) {
        sessionCategories.set(msg.session_id, new Map());
      }
      const counts = sessionCategories.get(msg.session_id)!;
      counts.set(result.categoryId, (counts.get(result.categoryId) || 0) + 1);

      if (options.onProgress && categorized % 50 === 0) {
        options.onProgress(`Categorized ${categorized} messages...`);
      }
    } else {
      skipped++;
    }
  }

  // Apply session-level tags based on most frequent categories
  for (const [sessionId, counts] of sessionCategories) {
    // Get top category for the session
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      const [topCategory] = sorted[0];
      // Use parent category for session-level tag
      const parentCategory = topCategory.includes("/")
        ? topCategory.split("/")[0]
        : topCategory;
      tagSession(db, sessionId, parentCategory, 0.8, "auto");

      // Also tag with the specific subcategory if it's dominant
      if (sorted[0][1] >= 2) {
        tagSession(db, sessionId, topCategory, 0.7, "auto");
      }
    }
  }

  return { categorized, skipped };
}
