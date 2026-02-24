/**
 * team/reflect.ts - LLM-powered session synthesis for knowledge export
 *
 * Sends filtered conversation to Ollama with a synthesis prompt template.
 * Returns a structured knowledge article (summary, changes, decisions,
 * insights, context) that replaces the conversation trail in the output.
 *
 * Prompt template is loaded from:
 *   1. .smriti/prompts/share-reflect.md (project override)
 *   2. src/team/prompts/share-reflect.md (built-in default)
 */

import { OLLAMA_HOST, OLLAMA_MODEL } from "../config";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { RawMessage } from "./formatter";
import { filterMessages, mergeConsecutive, sanitizeContent } from "./formatter";

// =============================================================================
// Types
// =============================================================================

export type Synthesis = {
  summary: string;
  changes: string;
  decisions: string;
  insights: string;
  context: string;
};

// =============================================================================
// Prompt loading
// =============================================================================

const DEFAULT_PROMPT_PATH = fileURLToPath(
  new URL("./prompts/share-reflect.md", import.meta.url)
);

/** Load the prompt template, preferring project override */
export async function loadPromptTemplate(
  projectSmritiDir?: string
): Promise<string> {
  // Try project-level override first
  if (projectSmritiDir) {
    const overridePath = join(
      projectSmritiDir,
      "prompts",
      "share-reflect.md"
    );
    const overrideFile = Bun.file(overridePath);
    if (await overrideFile.exists()) {
      return overrideFile.text();
    }
  }

  // Fall back to built-in default
  const defaultFile = Bun.file(DEFAULT_PROMPT_PATH);
  return defaultFile.text();
}

// =============================================================================
// Conversation formatting (for prompt injection)
// =============================================================================

/** Max chars to send to the LLM — keeps prompt within model context window */
const MAX_CONVERSATION_CHARS = 8000;

/** Format raw messages into a readable conversation string for the LLM */
function formatConversationForPrompt(rawMessages: RawMessage[]): string {
  const filtered = filterMessages(rawMessages);
  const merged = mergeConsecutive(filtered);

  let text = merged
    .map((m) => `**${m.role}**: ${m.content}`)
    .join("\n\n");

  // Truncate to fit model context, keeping the end (most recent/relevant)
  if (text.length > MAX_CONVERSATION_CHARS) {
    text = "...\n\n" + text.slice(-MAX_CONVERSATION_CHARS);
  }

  return text;
}

// =============================================================================
// Response parsing
// =============================================================================

const SECTION_KEYS: Array<{ header: string; field: keyof Synthesis }> = [
  { header: "### Summary", field: "summary" },
  { header: "### Changes", field: "changes" },
  { header: "### Decisions", field: "decisions" },
  { header: "### Insights", field: "insights" },
  { header: "### Context", field: "context" },
];

/** Parse structured synthesis from LLM response text */
export function parseSynthesis(response: string): Synthesis {
  const synthesis: Synthesis = {
    summary: "",
    changes: "",
    decisions: "",
    insights: "",
    context: "",
  };

  for (let i = 0; i < SECTION_KEYS.length; i++) {
    const { header, field } = SECTION_KEYS[i];
    const headerIdx = response.indexOf(header);
    if (headerIdx === -1) continue;

    const contentStart = headerIdx + header.length;

    // Find the next section header or end of string
    let contentEnd = response.length;
    for (let j = i + 1; j < SECTION_KEYS.length; j++) {
      const nextIdx = response.indexOf(SECTION_KEYS[j].header, contentStart);
      if (nextIdx !== -1) {
        contentEnd = nextIdx;
        break;
      }
    }

    let value = response.slice(contentStart, contentEnd).trim();

    // Strip "N/A" responses
    if (/^n\/?a\.?$/i.test(value)) {
      value = "";
    }

    synthesis[field] = value;
  }

  return synthesis;
}

/** Derive a title from the synthesis summary */
export function deriveTitleFromSynthesis(synthesis: Synthesis): string | null {
  if (!synthesis.summary) return null;
  // Use first sentence of summary, capped at 80 chars
  const firstSentence = synthesis.summary.split(/\.\s/)[0];
  if (firstSentence.length > 80) {
    return firstSentence.slice(0, 77) + "...";
  }
  return firstSentence.replace(/\.$/, "");
}

// =============================================================================
// Document formatting
// =============================================================================

/** Format a synthesis into a complete markdown document body */
export function formatSynthesisAsDocument(
  title: string,
  synthesis: Synthesis
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push("");

  if (synthesis.summary) {
    lines.push(`> ${synthesis.summary}`);
    lines.push("");
  }

  if (synthesis.changes) {
    lines.push("## Changes");
    lines.push("");
    lines.push(synthesis.changes);
    lines.push("");
  }

  if (synthesis.decisions) {
    lines.push("## Decisions");
    lines.push("");
    lines.push(synthesis.decisions);
    lines.push("");
  }

  if (synthesis.insights) {
    lines.push("## Insights");
    lines.push("");
    lines.push(synthesis.insights);
    lines.push("");
  }

  if (synthesis.context) {
    lines.push("## Context");
    lines.push("");
    lines.push(synthesis.context);
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// =============================================================================
// Main synthesis
// =============================================================================

export type SynthesizeOptions = {
  model?: string;
  projectSmritiDir?: string;
  timeout?: number;
};

/**
 * Synthesize a session into a knowledge article via Ollama.
 * Returns null if Ollama is unavailable or the session is too short.
 */
export async function synthesizeSession(
  rawMessages: RawMessage[],
  options: SynthesizeOptions = {}
): Promise<Synthesis | null> {
  const conversation = formatConversationForPrompt(rawMessages);

  // Skip synthesis for very short conversations
  if (conversation.length < 100) return null;

  try {
    const template = await loadPromptTemplate(options.projectSmritiDir);
    const prompt = template.replace("{{conversation}}", conversation);

    const model = options.model || OLLAMA_MODEL;
    const timeout = options.timeout || 120_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 1000,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as { response?: string };
    if (!data.response) return null;

    return parseSynthesis(data.response);
  } catch {
    // Ollama unavailable or timeout — graceful degradation
    return null;
  }
}

/** Check if a synthesis has enough content to use */
export function hasSubstantiveSynthesis(synthesis: Synthesis): boolean {
  // Need at least summary + one other section
  if (!synthesis.summary) return false;
  const otherSections = [synthesis.changes, synthesis.decisions, synthesis.insights, synthesis.context];
  return otherSections.some((s) => s.length > 0);
}
