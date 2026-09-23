/**
 * Real implementation of `categorize` on the new blueprint (see the `categorize`
 * case in ../index.ts). Blueprint only - no real DB is touched; the categorization
 * backend is injected, defaulting to a safe simulation.
 *
 * Both `--session` and `--llm` are optional flags. If no --session is given,
 * all uncategorized messages are processed. The --llm flag enables LLM
 * classification for ambiguous cases (default is rule-based only).
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { categorizeUncategorized } from "../categorize/classifier";

export interface CategorizeResult {
  categorized: number;
  skipped: number;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface CategorizeBackend {
  /** Categorizes uncategorized messages/sessions. */
  categorizeUncategorized(options: {
    sessionId?: string;
    useLLM?: boolean;
    onProgress?: (msg: string) => void;
  }): Promise<{ categorized: number; skipped: number }>;
}

const simulateBackend: CategorizeBackend = {
  async categorizeUncategorized() {
    return { categorized: 5, skipped: 2 };
  },
};

/**
 * Real backend, wired to the actual categorization pipeline.
 *
 * Mirrors ../index.ts case "categorize": exactly:
 *   - categorizeUncategorized(db, { sessionId, useLLM, onProgress })
 *     from ../categorize/classifier
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealCategorizeBackend(db).
 */
export function createRealCategorizeBackend(db: Database): CategorizeBackend {
  return {
    async categorizeUncategorized(options: {
      sessionId?: string;
      useLLM?: boolean;
      onProgress?: (msg: string) => void;
    }): Promise<{ categorized: number; skipped: number }> {
      return categorizeUncategorized(db, {
        sessionId: options.sessionId,
        useLLM: options.useLLM,
        onProgress: options.onProgress,
      });
    },
  };
}

export class CategorizeCommand extends BaseCommand<CategorizeResult> {
  constructor(private readonly backend: CategorizeBackend = simulateBackend) {
    super();
  }

  name = "categorize";
  summary = "Auto-categorize uncategorized sessions (rule-based or with LLM)";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    {
      flag: "--session",
      type: "string",
      description: "categorize only this session (optional; default is all uncategorized)",
    },
    {
      flag: "--llm",
      type: "boolean",
      description: "enable LLM classification for ambiguous cases (default: rule-based only)",
    },
  ];
  output = {
    description: "prints how many sessions were categorized and how many were skipped",
    jsonShape: "{ categorized: number, skipped: number }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti categorize",
      description: "auto-categorize all uncategorized messages using rules",
    },
    {
      command: "smriti categorize --llm",
      description: "use LLM to help classify ambiguous messages",
    },
    {
      command: "smriti categorize --session sess1 --llm",
      description: "categorize one specific session with LLM",
    },
  ];
  detailedSummary =
    "Processes uncategorized messages and assigns them to categories. " +
    "By default, uses rule-based classification only. Pass --llm to enable " +
    "LLM-based classification for cases the rules can't confidently match. " +
    "Filter to a single session with --session <id>; omit to process all.";

  protected async execute(parsed: ParsedArgs): Promise<CategorizeResult> {
    const sessionId = parsed.flags["--session"] as string | undefined;
    const useLLM = parsed.flags["--llm"] === true;

    const result = await this.backend.categorizeUncategorized({
      sessionId,
      useLLM,
      onProgress: (msg) => console.log(`  ${msg}`),
    });

    return result;
  }
}
