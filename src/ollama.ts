/**
 * ollama.ts - Ollama API client for Smriti memory summarization and synthesis
 *
 * Uses Bun's fetch() to call Ollama's HTTP API. Separate from QMD's llm.ts
 * which uses node-llama-cpp for embeddings/reranking.
 *
 * Config via env:
 *   OLLAMA_HOST      - Ollama server URL (default: http://127.0.0.1:11434)
 *   QMD_MEMORY_MODEL - Model for summarization/synthesis (default: qwen3:8b-tuned)
 */

// =============================================================================
// Configuration
// =============================================================================

const OLLAMA_HOST = Bun.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const DEFAULT_MEMORY_MODEL = Bun.env.QMD_MEMORY_MODEL || "qwen3:8b-tuned";

// =============================================================================
// Types
// =============================================================================

export type OllamaChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OllamaChatOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export type OllamaChatResponse = {
  model: string;
  message: OllamaChatMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
};

// =============================================================================
// Core API
// =============================================================================

/**
 * Send a chat completion request to Ollama.
 * Uses stream: false for simple request/response.
 */
export async function ollamaChat(
  messages: OllamaChatMessage[],
  options: OllamaChatOptions = {}
): Promise<OllamaChatResponse> {
  const model = options.model || DEFAULT_MEMORY_MODEL;
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.maxTokens !== undefined && { num_predict: options.maxTokens }),
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama chat failed (${resp.status}): ${body}`);
  }

  return resp.json() as Promise<OllamaChatResponse>;
}

/**
 * Summarize a conversation transcript via Ollama.
 * Returns a concise summary of the conversation.
 */
export async function ollamaSummarize(
  transcript: string,
  options: OllamaChatOptions = {}
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    {
      role: "system",
      content:
        "You are a conversation summarizer. Produce a concise summary of the following conversation. " +
        "Focus on key topics discussed, decisions made, questions asked, and solutions provided. " +
        "Keep it under 200 words. Output only the summary, no preamble.",
    },
    {
      role: "user",
      content: transcript,
    },
  ];

  const resp = await ollamaChat(messages, {
    ...options,
    temperature: options.temperature ?? 0.3,
    maxTokens: options.maxTokens ?? 512,
  });

  return resp.message.content.trim();
}

/**
 * Synthesize recalled memories into coherent context via Ollama.
 * Takes a query and memory fragments, returns a synthesized response.
 */
export async function ollamaRecall(
  query: string,
  memories: string,
  options: OllamaChatOptions = {}
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    {
      role: "system",
      content:
        "You are a memory recall assistant. Given a query and relevant past conversation memories, " +
        "synthesize the memories into useful context for answering the query. " +
        "Be concise and focus on information directly relevant to the query. " +
        "If memories contain contradictory information, note the most recent. " +
        "Output only the synthesized context, no preamble.",
    },
    {
      role: "user",
      content: `Query: ${query}\n\nRelevant memories:\n${memories}`,
    },
  ];

  const resp = await ollamaChat(messages, {
    ...options,
    temperature: options.temperature ?? 0.3,
    maxTokens: options.maxTokens ?? 1024,
  });

  return resp.message.content.trim();
}

/**
 * Answer a natural language question grounded in retrieved session memories.
 * Returns the answer only — caller appends citations.
 */
export async function ollamaAsk(
  question: string,
  sources: string,
  options: OllamaChatOptions = {}
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    {
      role: "system",
      content:
        "You are an expert assistant with access to an engineer's work history. " +
        "Answer the question directly and precisely using only the provided sources. " +
        "If sources are insufficient, say so explicitly. " +
        "Cite sources by [N] where N is the source number. " +
        "Be concise — answer in 2-4 sentences unless depth is needed. " +
        "Output only the answer, no preamble.",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nSources:\n${sources}`,
    },
  ];

  const resp = await ollamaChat(messages, {
    ...options,
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 512,
  });

  return resp.message.content.trim();
}

/**
 * Check if Ollama is running and accessible.
 * Pings the /api/tags endpoint.
 */
export async function ollamaHealthCheck(): Promise<{
  ok: boolean;
  models?: string[];
  error?: string;
}> {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as { models?: { name: string }[] };
    const models = data.models?.map((m) => m.name) || [];
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export { DEFAULT_MEMORY_MODEL, OLLAMA_HOST };
