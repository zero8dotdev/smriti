import type { RecallScenario } from "./types";

/**
 * Two sessions with identical content (so their BM25/RRF scores tie exactly)
 * but very different density_score — recallMemories blends density into the
 * final score 80/20, so at topK=1 only the denser session should survive.
 * Requires useRecallMemories: true, since the project-filtered searchFiltered
 * path never touches density scoring.
 */
export const DENSITY_BLENDING: RecallScenario = {
  name: "density blending breaks a BM25 tie",
  project: "backend",
  sessions: [
    {
      id: "density-high",
      densityScore: 0.9,
      messages: [
        { role: "user", content: "We should switch to using a message queue for background job processing." },
        { role: "assistant", content: "Agreed — moving long-running work off the request path avoids timeouts." },
      ],
    },
    {
      id: "density-low",
      densityScore: 0.05,
      messages: [
        { role: "user", content: "We should switch to using a message queue for background job processing." },
        { role: "assistant", content: "Agreed — moving long-running work off the request path avoids timeouts." },
      ],
    },
  ],
  probes: [
    {
      query: "message queue background job processing",
      description: "BM25-tied content, density_score must break the tie toward the denser session",
      expectHitSessionIds: ["density-high"],
      expectMissSessionIds: ["density-low"],
      topK: 1,
      useRecallMemories: true,
    },
  ],
};
