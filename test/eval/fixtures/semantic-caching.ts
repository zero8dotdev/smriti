import type { RecallScenario } from "./types";

/**
 * Tier 2 only: the probe shares almost no lexical overlap with the source
 * session (no "Redis", "cache", or "TTL" in the query) — only a real
 * embedding model can bridge "in-memory data store to speed up repeated
 * lookups" to "Redis... avoid repeated database round trips".
 */
export const SEMANTIC_CACHING: RecallScenario = {
  name: "semantic-only match: caching decision, paraphrased query",
  project: "api-service",
  requiresEmbeddings: true,
  sessions: [
    {
      id: "semantic-s1",
      messages: [
        { role: "user", content: "The product listing endpoint is slow under load." },
        { role: "assistant", content: "We store frequently accessed data in Redis to avoid repeated database round trips — added a 5-minute TTL for the product listing query." },
      ],
    },
    {
      id: "semantic-s2-distractor",
      messages: [
        { role: "user", content: "Let's add rate limiting to the public API." },
        { role: "assistant", content: "Token bucket, 100 requests per minute per API key." },
      ],
    },
  ],
  probes: [
    {
      query: "why do we use an in-memory data store to speed up repeated lookups",
      description: "paraphrased, near-zero lexical overlap with the source session — needs semantic (vector) matching",
      expectHitSessionIds: ["semantic-s1"],
      expectMissSessionIds: ["semantic-s2-distractor"],
      // The project-filtered path never touches vectors — route through
      // recallMemories's hybrid pipeline, the only path embeddings affect.
      useRecallMemories: true,
    },
  ],
};
