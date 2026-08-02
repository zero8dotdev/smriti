import type { RecallScenario } from "./types";

/** Cross-session recall over time, plus precision against a same-project, same-vocabulary distractor. */
export const AUTH_MIGRATION: RecallScenario = {
  name: "auth: JWT -> session cookie migration, recalled later",
  project: "webapp",
  sessions: [
    {
      id: "auth-s1",
      daysAgo: 14,
      messages: [
        { role: "user", content: "We're getting complaints that JWTs can't be revoked on logout. Should we move to session cookies?" },
        { role: "assistant", content: "Session cookies with server-side storage let you revoke instantly. JWTs need a blocklist, which defeats the point of being stateless." },
        { role: "user", content: "Let's switch. Use server-side session cookies, drop JWT for auth entirely." },
        { role: "assistant", content: "Decision: replaced JWT-based session tokens with server-side session cookies stored in Redis, keyed by session id, TTL 24h." },
      ],
    },
    {
      id: "auth-s2",
      daysAgo: 10,
      messages: [
        { role: "user", content: "Session cookie migration is live. Any edge cases with mobile clients that can't set cookies?" },
        { role: "assistant", content: "Mobile WebViews sometimes block third-party cookies; we added a fallback bearer-token header for the mobile app only." },
      ],
    },
    {
      id: "auth-s3-distractor",
      daysAgo: 30,
      messages: [
        { role: "user", content: "What's our password hashing algorithm for the auth system?" },
        { role: "assistant", content: "We use bcrypt with cost factor 12 for password hashing, unrelated to session management." },
      ],
    },
  ],
  probes: [
    {
      // FTS5 MATCH is an AND of all terms within one message — terms must
      // be literally present, not natural-language phrasing (see msg2:
      // "Use server-side session cookies, drop JWT for auth entirely.").
      query: "JWT session cookies auth",
      description: "core decision recall — must surface the migration session",
      expectHitSessionIds: ["auth-s1"],
      expectHitSubstrings: ["server-side session cookies"],
      expectMissSessionIds: ["auth-s3-distractor"],
    },
    {
      query: "mobile cookie migration",
      description: "follow-up detail in a later session — recall must surface s2, not just s1",
      expectHitSessionIds: ["auth-s2"],
    },
    {
      query: "password hashing algorithm",
      description: "distractor probe — different topic sharing the 'auth' vocabulary; must not pull in s1/s2",
      expectHitSessionIds: ["auth-s3-distractor"],
      expectMissSessionIds: ["auth-s1", "auth-s2"],
    },
  ],
};
