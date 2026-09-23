/**
 * Tag command implementation - manually tag a session with a category.
 * Based on real behavior from ../index.ts case "tag":
 *   - Two required positionals: session-id, category
 *   - Validates category exists
 *   - Calls tagSession with 1.0 confidence and "manual" source
 *   - Returns success message
 *
 * Blueprint pattern: backend injection for category validation and tagging,
 * defaulting to safe simulations (no real DB access).
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, CommandError } from "../command";
import type { ParsedArgs, CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { tagSession } from "../db";
import { isValidCategory } from "../categorize/schema";

export interface TagResult {
  sessionId: string;
  categoryId: string;
}

export interface TagBackend {
  /** Validates that a category exists. Returns true if valid, false otherwise. */
  isValidCategory(categoryId: string): boolean;
  /** Tags a session with a category at confidence 1.0, source "manual". */
  tagSession(sessionId: string, categoryId: string): Promise<void>;
}

const simulateBackend: TagBackend = {
  isValidCategory(categoryId: string): boolean {
    // Simulate a few known categories for testing
    const knownCategories = ["decision", "bug", "feature", "architecture", "review"];
    return knownCategories.includes(categoryId);
  },
  async tagSession(): Promise<void> {
    // No-op simulation - doesn't touch any real DB
  },
};

/**
 * Real backend, backed by the shared sqlite Database handle.
 *
 * Mirrors ../index.ts case "tag": exactly:
 *   - isValidCategory(db, categoryId)      from ../categorize/schema
 *   - tagSession(db, sessionId, categoryId, 1.0, "manual")  from ../db
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealTagBackend(db).
 */
export function createRealTagBackend(db: Database): TagBackend {
  return {
    isValidCategory(categoryId: string): boolean {
      return isValidCategory(db, categoryId);
    },
    async tagSession(sessionId: string, categoryId: string): Promise<void> {
      tagSession(db, sessionId, categoryId, 1.0, "manual");
    },
  };
}

export class TagCommand extends BaseCommand<TagResult> {
  constructor(private readonly backend: TagBackend = simulateBackend) {
    super();
  }

  name = "tag";
  summary = "Manually tag a session with a category";
  args: ArgSpec[] = [
    {
      name: "session-id",
      type: "string",
      required: true,
      description: "session to tag",
    },
    {
      name: "category",
      type: "string",
      required: true,
      description: "category to apply (must be a valid category)",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--json", type: "boolean", description: "output result as JSON" },
  ];
  output = {
    description: "confirmation of the tag application",
    jsonShape: "{ sessionId: string, categoryId: string }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti tag sess1 decision",
      description: "tag a session with the 'decision' category",
    },
    {
      command: "smriti tag 2024-08-06-abc123 bug",
      description: "tag a session with the 'bug' category by full session id",
    },
    {
      command: "smriti tag sess2 feature --json",
      description: "tag a session and output the result as JSON",
    },
  ];
  detailedSummary =
    "Tags apply a category label to a session with manual source and 1.0 confidence, " +
    "marking it for knowledge organization and retrieval. The category must exist in the system " +
    "(run 'smriti categories' to see available options).";

  protected async execute(parsed: ParsedArgs): Promise<TagResult> {
    const sessionId = parsed.positionals[0];
    const categoryId = parsed.positionals[1];

    // Validate category exists
    if (!this.backend.isValidCategory(categoryId)) {
      throw new CommandError(
        `Invalid category: ${categoryId}\nRun 'smriti categories' to see available categories.`,
        "INVALID_ARG",
        { arg: "category", value: categoryId }
      );
    }

    // Tag the session
    await this.backend.tagSession(sessionId, categoryId);

    return {
      sessionId,
      categoryId,
    };
  }
}
