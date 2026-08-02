/**
 * team/ollama.ts - Shared Ollama HTTP client for team pipeline
 *
 * Centralized LLM call with timeout and retry support.
 * Used by segment.ts (Stage 1) and document.ts (Stage 2).
 */

import { OLLAMA_HOST, requireOllamaModel } from "../config";

export type OllamaOptions = {
  model?: string;
  temperature?: number;
  timeout?: number;
  maxRetries?: number;
};

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;

/**
 * Call Ollama generate API with timeout and retry.
 *
 * Retries on 5xx errors and network failures with exponential backoff.
 * Does NOT retry on 4xx (bad request, model not found, etc).
 */
export async function callOllama(
  prompt: string,
  options: OllamaOptions = {}
): Promise<string> {
  const model = requireOllamaModel(options.model);
  const temperature = options.temperature ?? 0.7;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const msg = `Ollama API error: ${response.status} ${response.statusText}`;
        // Don't retry client errors
        if (response.status >= 400 && response.status < 500) {
          throw new Error(msg);
        }
        lastError = new Error(msg);
        continue;
      }

      const data = (await response.json()) as { response: string };
      return data.response || "";
    } catch (err: any) {
      clearTimeout(timer);
      // Don't retry aborts (timeout) or client errors
      if (err.name === "AbortError") {
        throw new Error(`Ollama request timed out after ${timeout}ms`);
      }
      if (err.message?.includes("4")) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError || new Error("Ollama request failed after retries");
}
