/**
 * team/document.ts - Stage 2: Generate documentation for knowledge units
 *
 * Transforms each knowledge unit into a polished markdown document
 * using category-specific templates and LLM synthesis.
 */

import { OLLAMA_HOST, OLLAMA_MODEL, SMRITI_DIR } from "../config";
import { join, dirname, basename } from "path";
import type { KnowledgeUnit, DocumentationOptions, DocumentGenerationResult } from "./types";
import { existsSync } from "fs";

// =============================================================================
// Template Loading
// =============================================================================

const BUILT_IN_TEMPLATES_DIR = join(
  dirname(new URL(import.meta.url).pathname),
  "prompts"
);

/**
 * Get the Stage 2 prompt template for a category
 * First checks project-level override, then built-in templates
 */
async function loadTemplateForCategory(
  category: string,
  projectSmritiDir?: string
): Promise<string> {
  // Map category to template file
  const templates: Array<{ pattern: RegExp; file: string }> = [
    { pattern: /^bug\//, file: "stage2-bug.md" },
    { pattern: /^architecture\/|^decision\//, file: "stage2-architecture.md" },
    { pattern: /^code\//, file: "stage2-code.md" },
    { pattern: /^feature\//, file: "stage2-feature.md" },
    { pattern: /^topic\//, file: "stage2-topic.md" },
    { pattern: /^project\//, file: "stage2-project.md" },
  ];

  let templateFile = "stage2-base.md";
  for (const { pattern, file } of templates) {
    if (pattern.test(category)) {
      templateFile = file;
      break;
    }
  }

  // Try project override first
  if (projectSmritiDir) {
    const overridePath = join(projectSmritiDir, "prompts", templateFile);
    const overrideFile = Bun.file(overridePath);
    if (await overrideFile.exists()) {
      return overrideFile.text();
    }
  }

  // Fall back to built-in
  const builtInPath = join(BUILT_IN_TEMPLATES_DIR, templateFile);
  const builtInFile = Bun.file(builtInPath);
  if (await builtInFile.exists()) {
    return builtInFile.text();
  }

  // Ultimate fallback
  return Bun.file(join(BUILT_IN_TEMPLATES_DIR, "stage2-base.md")).text();
}

// =============================================================================
// Prompt Injection
// =============================================================================

/**
 * Inject unit metadata into template
 */
function injectUnitIntoTemplate(
  template: string,
  unit: KnowledgeUnit,
  unitTitle: string
): string {
  let result = template;

  result = result.replace("{{topic}}", unit.topic);
  result = result.replace("{{category}}", unit.category);
  result = result.replace("{{entities}}", unit.entities.join(", ") || "None");
  result = result.replace("{{files}}", unit.files.join(", ") || "None");
  result = result.replace("{{content}}", unit.plainText);
  result = result.replace("{{title}}", unitTitle);

  return result;
}

// =============================================================================
// Document Generation
// =============================================================================

/**
 * Generate a markdown document for a single knowledge unit
 */
export async function generateDocument(
  unit: KnowledgeUnit,
  suggestedTitle: string,
  options: DocumentationOptions = {}
): Promise<DocumentGenerationResult> {
  // Load appropriate template
  const template = await loadTemplateForCategory(
    unit.category,
    options.projectSmritiDir
  );

  // Inject unit into template
  const prompt = injectUnitIntoTemplate(template, unit, suggestedTitle);

  // Call LLM to synthesize
  let synthesis = "";
  try {
    synthesis = await callOllama(prompt, options.model);
  } catch (err) {
    console.warn(`Failed to synthesize unit ${unit.id}:`, err);
    // Fallback: return unit content as-is
    synthesis = unit.plainText;
  }

  // Generate filename
  const date = new Date().toISOString().split("T")[0];
  const slug = slugify(suggestedTitle || unit.topic);
  const filename = `${date}_${slug}.md`;

  // Estimate tokens
  const tokenEstimate = Math.ceil((prompt.length + synthesis.length) / 4);

  return {
    unitId: unit.id,
    category: unit.category,
    title: suggestedTitle || unit.topic,
    markdown: synthesis,
    frontmatter: {
      id: unit.id,
      category: unit.category,
      entities: unit.entities,
      files: unit.files,
      relevance_score: String(unit.relevance),
    },
    filename,
    tokenEstimate,
  };
}

/**
 * Generate all documents for a batch of units
 * Processes sequentially by default (as per plan)
 */
export async function generateDocumentsSequential(
  units: KnowledgeUnit[],
  options: DocumentationOptions = {}
): Promise<DocumentGenerationResult[]> {
  const results: DocumentGenerationResult[] = [];

  for (const unit of units) {
    // Generate suggested title from topic
    const suggestedTitle = unit.suggestedTitle || unit.topic;

    const doc = await generateDocument(unit, suggestedTitle, options);
    results.push(doc);
  }

  return results;
}

// =============================================================================
// Filename Generation
// =============================================================================

/**
 * Generate a URL-friendly slug from text
 */
function slugify(text: string, maxLen: number = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

// =============================================================================
// Ollama Integration
// =============================================================================

/**
 * Call Ollama generate API
 */
async function callOllama(prompt: string, model?: string): Promise<string> {
  const ollamaModel = model || OLLAMA_MODEL;

  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama API error: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { response: string };
  return data.response || "";
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Generate YAML frontmatter from metadata
 */
export function generateFrontmatter(
  sessionId: string,
  unitId: string,
  meta: Record<string, string | string[]>,
  author: string,
  projectId?: string
): string {
  const meta2: Record<string, string | string[]> = {
    ...meta,
    id: unitId,
    session_id: sessionId,
    project: projectId || "",
    author,
    shared_at: new Date().toISOString(),
  };

  const lines = ["---"];
  for (const [key, value] of Object.entries(meta2)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}
