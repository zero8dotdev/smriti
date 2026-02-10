/**
 * team/reflect.ts - LLM-powered session reflection for knowledge export
 *
 * Sends filtered conversation to Ollama with a reflective prompt template,
 * extracts structured insights (learnings, takeaways, team context, changes,
 * discoveries) and returns them for embedding in the documentation.
 *
 * Prompt template is loaded from:
 *   1. .smriti/prompts/share-reflect.md (project override)
 *   2. src/team/prompts/share-reflect.md (built-in default)
 */

import { OLLAMA_HOST, OLLAMA_MODEL } from "../config";
import { join, dirname } from "path";
import type { RawMessage } from "./formatter";
import { filterMessages, mergeConsecutive } from "./formatter";

// =============================================================================
// Types
// =============================================================================

export type Reflection = {
  learnings: string;
  keyTakeaway: string;
  teamContext: string;
  changesMade: string;
  discovery: string;
};

// =============================================================================
// Prompt loading
// =============================================================================

const DEFAULT_PROMPT_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "prompts",
  "share-reflect.md"
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

/** Format raw messages into a readable conversation string for the LLM */
function formatConversationForPrompt(rawMessages: RawMessage[]): string {
  const filtered = filterMessages(rawMessages);
  const merged = mergeConsecutive(filtered);

  return merged
    .map((m) => `**${m.role}**: ${m.content}`)
    .join("\n\n");
}

// =============================================================================
// Response parsing
// =============================================================================

const SECTION_KEYS: Array<{ header: string; field: keyof Reflection }> = [
  { header: "### Learnings", field: "learnings" },
  { header: "### Key Takeaway", field: "keyTakeaway" },
  { header: "### Team Context", field: "teamContext" },
  { header: "### Changes Made", field: "changesMade" },
  { header: "### Discovery", field: "discovery" },
];

/** Parse structured reflection from LLM response text */
export function parseReflection(response: string): Reflection {
  const reflection: Reflection = {
    learnings: "",
    keyTakeaway: "",
    teamContext: "",
    changesMade: "",
    discovery: "",
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

    reflection[field] = value;
  }

  return reflection;
}

// =============================================================================
// Main reflection
// =============================================================================

export type ReflectOptions = {
  model?: string;
  projectSmritiDir?: string;
  timeout?: number;
};

/**
 * Reflect on a session by calling Ollama with the prompt template.
 * Returns null if Ollama is unavailable or the session is too short.
 */
export async function reflectOnSession(
  rawMessages: RawMessage[],
  options: ReflectOptions = {}
): Promise<Reflection | null> {
  const conversation = formatConversationForPrompt(rawMessages);

  // Skip reflection for very short conversations
  if (conversation.length < 100) return null;

  try {
    const template = await loadPromptTemplate(options.projectSmritiDir);
    const prompt = template.replace("{{conversation}}", conversation);

    const model = options.model || OLLAMA_MODEL;
    const timeout = options.timeout || 30_000;

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
          num_predict: 500,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as { response?: string };
    if (!data.response) return null;

    return parseReflection(data.response);
  } catch {
    // Ollama unavailable or timeout — graceful degradation
    return null;
  }
}

/** Check if a reflection has any substantive content */
export function hasSubstantiveReflection(reflection: Reflection): boolean {
  return Object.values(reflection).some((v) => v.length > 0);
}
