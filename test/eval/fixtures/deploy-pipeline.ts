import type { RecallScenario } from "./types";

/**
 * Single-session recall, scoped by project. A second session shares almost
 * identical vocabulary ("deploys are flaky", "CI pipeline") but lives under
 * a different project — the probe (scoped to "api-service") must not pull
 * it in, proving project filtering isolates results rather than just
 * favoring topical relevance.
 */
export const DEPLOY_PIPELINE: RecallScenario = {
  name: "deploy: CI pipeline decision, isolated by project",
  project: "api-service",
  sessions: [
    {
      id: "deploy-s1",
      messages: [
        { role: "user", content: "Our deploys are flaky. What's causing the intermittent CI pipeline failures?" },
        { role: "assistant", content: "Flaky tests were racing against a shared test database. Switched the pipeline to spin up an isolated Postgres container per CI job." },
        { role: "user", content: "Good, let's also cache node_modules between runs to speed things up." },
        { role: "assistant", content: "Added actions/cache keyed on the lockfile hash — pipeline runtime dropped from 8 minutes to 3." },
      ],
    },
    {
      id: "deploy-s2-other-project",
      project: "frontend-app",
      messages: [
        { role: "user", content: "Our deploys are flaky too — the CI pipeline times out on the frontend build." },
        { role: "assistant", content: "The frontend bundle got too large for the default Vercel build timeout; raised it and split the vendor chunk." },
      ],
    },
  ],
  probes: [
    {
      // FTS5 MATCH is an AND of all terms within one message — literal terms only.
      query: "CI pipeline flaky",
      description: "single-session recall scoped to api-service — must not pull in the same-vocabulary frontend-app session",
      expectHitSessionIds: ["deploy-s1"],
      expectHitSubstrings: ["isolated Postgres container", "shared test database"],
      expectMissSessionIds: ["deploy-s2-other-project"],
    },
  ],
};
