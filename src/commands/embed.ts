/**
 * Real implementation of `embed` on the new blueprint (see the `embed`
 * case in ../index.ts). Blueprint only - no real DB is touched; the embedding
 * backend is injected, defaulting to a safe simulation.
 *
 * The embed command takes no positional arguments or flags (beyond --json).
 * It processes all unembed messages and returns the count of successfully
 * embedded messages.
 */

import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import type { Database } from "bun:sqlite";
import { embedMemoryMessages } from "../qmd";

export interface EmbedResult {
  count: number;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface EmbedBackend {
  /** Embeds new messages without embeddings, returns count embedded. */
  embedNewMessages(onProgress?: (done: number, total: number) => void): Promise<number>;
}

const simulateBackend: EmbedBackend = {
  async embedNewMessages() {
    return 5; // simulate embedding 5 new messages
  },
};

/**
 * Real backend for EmbedCommand, wired to the actual DB-backed embedding
 * pipeline (mirrors the `case "embed":` block in ../index.ts).
 *
 * - embedNewMessages -> embedMemoryMessages(db, { onProgress }) from ../qmd
 *   (re-exported from ../memory). The real function's signature is
 *   `embedMemoryMessages(db: Database, options: { onProgress?: (done: number,
 *   total: number) => void }): Promise<number>`, which matches EmbedBackend's
 *   onProgress shape exactly (done/total counts), so it is passed straight
 *   through with no conversion.
 *
 * Note: the index.ts case block passes its own onProgress callback typed as
 * `(msg: string) => void` (it logs `  ${msg}`), which does not structurally
 * match the real function's `(done: number, total: number) => void` signature
 * - a pre-existing mismatch in index.ts itself, not introduced here. This
 * factory wires straight to the real, correctly-typed signature; callers of
 * EmbedCommand supply their own onProgress consistent with that signature.
 */
export function createRealEmbedBackend(db: Database): EmbedBackend {
  return {
    async embedNewMessages(onProgress) {
      return embedMemoryMessages(db, { onProgress });
    },
  };
}

export class EmbedCommand extends BaseCommand<EmbedResult> {
  constructor(private readonly backend: EmbedBackend = simulateBackend) {
    super();
  }

  name = "embed";
  summary = "Embed new messages for vector search";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [];
  output = {
    description: "prints how many new messages were embedded",
    jsonShape: "{ count: number }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti embed", description: "embed all unembed messages" },
    { command: "smriti embed --json", description: "embed and return JSON result" },
    { command: "smriti embed 2>/dev/null", description: "embed silently, with no progress output" },
  ];
  detailedSummary =
    "Scans for all unembed messages and generates vector embeddings for them. " +
    "This enables semantic search and recall features. Embeddings use the configured " +
    "LLM and are stored in the content_vectors table.";

  protected async execute(_parsed: ParsedArgs): Promise<EmbedResult> {
    // The original index.ts case passes a (msg: string) => void callback to a
    // function expecting (done: number, total: number) => void - a
    // pre-existing signature mismatch that makes it print the raw `done`
    // count each step (e.g. "  1", "  2", ...). Preserved here byte-for-byte.
    const count = await this.backend.embedNewMessages((done) => console.log(`  ${done}`));
    return { count };
  }
}
