/**
 * Real implementation of `ask` on the new blueprint (see the `ask`
 * case in ../index.ts). Blueprint only - no real DB/Ollama is touched; the
 * recall and synthesis backends are injected, defaulting to safe simulations.
 *
 * The ask command performs RAG (retrieval-augmented generation) over work history:
 * it retrieves relevant passages via multi-angle recall (query expansion + reranking
 * are on by default), optionally synthesizes an answer via Ollama, and returns
 * sources with (if available) synthesized answer.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { recall } from "../search/recall";
import { ollamaAsk } from "../ollama";

export interface AskSource {
  n: number;
  session_id: string;
  session_title: string;
  score: number;
  content: string;
}

export interface AskRawResult {
  session_id: string;
  session_title: string;
  score: number;
  content: string;
  message_id: number;
  role: string;
}

export interface AskResult {
  question: string;
  sources: AskSource[];
  /** Raw recall results (with role/message_id) — needed by formatSearchResults for text-mode rendering. */
  results: AskRawResult[];
  answer?: string;
}

export interface RecallResult {
  results: AskRawResult[];
  synthesis?: string;
}

/** Injected backend seams - default simulations, no real DB/Ollama access. */
export interface AskBackend {
  /** Recalls relevant passages for a question (multi-angle: expandQuery + rerank on by default). */
  recall(question: string, opts: { limit?: number; project?: string; agent?: string }): Promise<RecallResult>;
  /** Synthesizes an answer from passages via Ollama; returns undefined if unavailable. */
  synthesizeAnswer(question: string, sourcesText: string, opts: { model?: string }): Promise<string | undefined>;
}

const simulateBackend: AskBackend = {
  async recall(question: string) {
    // Simulate finding one relevant passage
    return {
      results: [
        {
          session_id: "2024-01-15T10:30:00Z",
          session_title: "Architecture planning",
          score: 0.85,
          content: `We discussed using a multi-angle recall approach with query expansion and reranking to improve search relevance for open-ended questions.`,
          message_id: 1,
          role: "assistant",
        },
      ],
    };
  },
  async synthesizeAnswer() {
    // Simulate Ollama being unavailable
    return undefined;
  },
};

/**
 * Real backend for AskCommand, wired to the same `recall()` (multi-angle,
 * expandQuery + rerank on by default) and `ollamaAsk()` calls used by the
 * `case "ask":` block in ../index.ts. `db` is the shared Database handle
 * opened once in main() via initSmriti() and threaded through every command.
 *
 * Mirrors index.ts exactly: recall() is called with synthesize: false (the
 * ask command does its own synthesis pass below via ollamaAsk, separately
 * from recall's built-in synthesis path), and fast: false.
 */
export function createRealAskBackend(db: Database): AskBackend {
  return {
    async recall(question, opts) {
      return recall(db, question, {
        limit: opts.limit,
        synthesize: false,
        project: opts.project || undefined,
        agent: opts.agent || undefined,
        fast: false,
      });
    },
    async synthesizeAnswer(question, sourcesText, opts) {
      return ollamaAsk(question, sourcesText, { model: opts.model || undefined });
    },
  };
}

export class AskCommand extends BaseCommand<AskResult> {
  constructor(private readonly backend: AskBackend = simulateBackend) {
    super();
  }

  name = "ask";
  summary = "Answer a question from work history (RAG)";
  args: ArgSpec[] = [
    {
      name: "question",
      type: "string",
      required: true,
      description: "question to answer from work history",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--no-synthesize", type: "boolean", description: "skip LLM synthesis, return sources only" },
    { flag: "--limit", type: "number", default: "5", description: "max source passages to retrieve" },
    { flag: "--model", type: "string", description: "Ollama model for synthesis" },
    { flag: "--project", type: "string", description: "filter recall to a specific project" },
    { flag: "--agent", type: "string", description: "filter recall to a specific agent" },
  ];
  output = {
    description: "answers the question with optional synthesis + ranked source passages",
    jsonShape: "{ question: string, sources: [{ n, session_id, session_title, score, content }], answer?: string }",
  };
  examples: [Example, Example, Example] = [
    {
      command: 'smriti ask "how do we handle auth?"',
      description: "retrieve and synthesize answer with default 5 sources",
    },
    {
      command: 'smriti ask "explain the caching strategy" --no-synthesize',
      description: "retrieve sources only, skip LLM synthesis",
    },
    {
      command: 'smriti ask "what was the outage root cause?" --project myapp --limit 10',
      description: "retrieve from a specific project with custom limit",
    },
  ];
  detailedSummary =
    "Ask retrieves relevant passages from work history using multi-angle recall (query expansion + reranking on by default), " +
    "then optionally synthesizes an answer via Ollama. Returns sources ranked by relevance and (if synthesis succeeds) an answer. " +
    "Sources are shown regardless of synthesis outcome - if Ollama is unavailable, only sources are printed.";

  protected async execute(parsed: ParsedArgs, ctx: CommandContext): Promise<AskResult> {
    const question = parsed.positionals[0];
    const noSynthesize = parsed.flags["--no-synthesize"] === true;
    const limit = Number(parsed.flags["--limit"]) || 5;
    const model = parsed.flags["--model"] as string | undefined;
    const project = parsed.flags["--project"] as string | undefined;
    const agent = parsed.flags["--agent"] as string | undefined;

    // Multi-angle recall (expandQuery + rerank already default-on)
    const recallResult = await this.backend.recall(question, { limit, project, agent });

    // Format sources for output
    const sources = recallResult.results.map((r, i) => ({
      n: i + 1,
      session_id: r.session_id,
      session_title: r.session_title,
      score: r.score,
      content: r.content,
    }));

    let answer: string | undefined;

    // Synthesize if not --no-synthesize and we have sources
    if (!noSynthesize && sources.length > 0) {
      const sourcesText = sources
        .map((s) => `[${s.n}] ${s.session_title}\n${s.content}`)
        .join("\n\n---\n\n");

      try {
        answer = await this.backend.synthesizeAnswer(question, sourcesText, { model });
      } catch {
        // Ollama unavailable - answer stays undefined, sources still returned
      }
    }

    return { question, sources, results: recallResult.results, answer };
  }
}
