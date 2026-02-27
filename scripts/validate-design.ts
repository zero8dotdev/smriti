#!/usr/bin/env bun
/**
 * validate-design.ts
 *
 * Static-analysis validator for smriti's three design contracts:
 *   1. Dry-run coverage  — mutating commands must handle --dry-run
 *   2. Observability     — no user content in logs; telemetry default off
 *   3. JSON stability    — structural checks on the output envelope
 *
 * Exit 0 → all contracts satisfied.
 * Exit 1 → one or more violations (details printed to stderr).
 *
 * Run: bun run scripts/validate-design.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const INDEX_SRC = join(ROOT, "src", "index.ts");
const CONFIG_SRC = join(ROOT, "src", "config.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let failures = 0;

function fail(rule: string, detail: string) {
  failures++;
  console.error(`\n❌  [${rule}]`);
  console.error(`   ${detail}`);
}

function pass(rule: string) {
  console.log(`✅  [${rule}]`);
}

/**
 * Extract the source text for a top-level case block from a switch statement.
 * Returns everything from `case "name":` up to (but not including) the next
 * top-level `case` or `default:`.
 */
function extractCase(src: string, name: string): string | null {
  const pattern = new RegExp(`case "${name}":\\s*\\{`, "g");
  const m = pattern.exec(src);
  if (!m) return null;

  let depth = 0;
  let i = m.index;
  const start = i;

  while (i < src.length) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  return src.slice(start);
}

// ─────────────────────────────────────────────────────────────────────────────
// Load source files
// ─────────────────────────────────────────────────────────────────────────────

const indexSrc = readFileSync(INDEX_SRC, "utf8");
const configSrc = readFileSync(CONFIG_SRC, "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// Contract 1a: Mutating commands must support --dry-run
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n── Contract 1: Dry-run coverage ──");

const MUTATING = ["ingest", "embed", "categorize", "tag", "share", "sync"] as const;
// `context` already has dry-run — included in validation
const MUTATING_ALL = [...MUTATING, "context"] as const;

for (const cmd of MUTATING_ALL) {
  const block = extractCase(indexSrc, cmd);
  if (!block) {
    fail(`dry-run/${cmd}`, `Case block for "${cmd}" not found in src/index.ts`);
    continue;
  }

  const hasDryRunFlag = block.includes('"--dry-run"');
  const hasDryRunVar = /dry.?[Rr]un/i.test(block);

  if (!hasDryRunFlag && !hasDryRunVar) {
    fail(
      `dry-run/${cmd}`,
      `Mutating command "${cmd}" does not reference "--dry-run". ` +
      `Add: const dryRun = hasFlag(args, "--dry-run");`
    );
  } else {
    pass(`dry-run/${cmd}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract 1b: Read-only commands must NOT support --dry-run
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY = [
  "search", "recall", "list", "status", "show",
  "compare", "projects", "team", "categories",
] as const;

for (const cmd of READ_ONLY) {
  const block = extractCase(indexSrc, cmd);
  if (!block) {
    // Not all read-only commands may be present yet — skip silently
    continue;
  }

  const hasDryRun = block.includes('"--dry-run"') || /dry.?[Rr]un/i.test(block);

  if (hasDryRun) {
    fail(
      `dry-run-reject/${cmd}`,
      `Read-only command "${cmd}" references "--dry-run". ` +
      `Read-only commands must reject this flag with a usage error.`
    );
  } else {
    pass(`dry-run-reject/${cmd}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract 2a: No user content in console calls
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n── Contract 2: Observability ──");

// Patterns that indicate user content leaking into logs.
// Usage/help strings (lines containing `<...>` angle-bracket placeholders) are
// excluded — those are hardcoded template text, not runtime user data.
const PII_PATTERNS: Array<{ re: RegExp; description: string }> = [
  {
    // Logging a runtime .content property — but not a hardcoded "<content>" usage string
    re: /console\.(log|error)\([^)]*\.content\b/,
    description: "`.content` field logged — may expose message text",
  },
  {
    re: /console\.(log|error)\([^)]*\.text\b/,
    description: "`.text` field logged — may expose user text",
  },
  {
    // Variable named `query` interpolated at runtime — not a hardcoded placeholder like <query>
    re: /console\.(log|error)\(.*\$\{query\}/,
    description: "`query` variable interpolated into log — may expose user search string",
  },
];

let piiViolations = 0;
const lines = indexSrc.split("\n");
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Skip usage/help strings — these are static developer-written text, not runtime user data.
  // Heuristic: lines whose console call contains a "<...>" placeholder are usage messages.
  if (/console\.(log|error)\([^)]*<[a-z-]+>/i.test(line)) continue;

  for (const { re, description } of PII_PATTERNS) {
    if (re.test(line)) {
      piiViolations++;
      fail(
        "observability/no-user-content",
        `src/index.ts:${i + 1} — ${description}\n   Line: ${line.trim()}`
      );
    }
  }
}
if (piiViolations === 0) {
  pass("observability/no-user-content");
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract 2b: Telemetry must default to OFF
// ─────────────────────────────────────────────────────────────────────────────

// Check that SMRITI_TELEMETRY is not defaulted to a truthy value in config.ts
// Pattern: `SMRITI_TELEMETRY` env var with a default that is "1", "true", or "on"
const telemetryAlwaysOn = /SMRITI_TELEMETRY\s*\|\|\s*["'`](1|true|on)["'`]/i.test(configSrc);
const telemetryHardcoded = /SMRITI_TELEMETRY\s*=\s*["'`]?(1|true|on)["'`]?[^=]/i.test(configSrc);

if (telemetryAlwaysOn || telemetryHardcoded) {
  fail(
    "observability/telemetry-default",
    "SMRITI_TELEMETRY appears to default to a truthy value in src/config.ts. " +
    "Telemetry must be opt-in (default OFF)."
  );
} else {
  pass("observability/telemetry-default");
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract 3: JSON output envelope shape
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n── Contract 3: JSON output envelope ──");

// The json() helper in format.ts is a thin JSON.stringify wrapper.
// The envelope contract (ok/data/meta) applies to the return values of command
// functions, not to format.ts itself. We check that:
//   (a) the `context` command (which has the most complete JSON support) returns
//       a shape with `dry_run` in meta — a forward-looking proxy for the pattern.
//   (b) no command pipes raw arrays directly to `json()` without wrapping — i.e.,
//       every `json(...)` call wraps an object, not a bare array.

// Check (a): context.ts produces a result shape with meta.dry_run — confirms envelope awareness
const contextSrc = readFileSync(join(ROOT, "src", "context.ts"), "utf8");
const contextHasDryRunMeta = /dry_?run/i.test(contextSrc);
if (!contextHasDryRunMeta) {
  fail(
    "json-envelope/meta-dry-run",
    "src/context.ts does not appear to include dry_run in its return shape. " +
    "JSON output in dry-run mode must include meta.dry_run=true."
  );
} else {
  pass("json-envelope/meta-dry-run");
}

// Check (b): Look for json() calls in index.ts to ensure they wrap structured objects,
// not raw user-content arrays passed through without a wrapper.
// Any `json(result)` or `json(sessions)` is fine — we flag only `json(query)` type leaks.
const jsonCallsWithQuery = /\bjson\s*\(\s*query\s*\)/g;
if (jsonCallsWithQuery.test(indexSrc)) {
  fail(
    "json-envelope/raw-query",
    "A json(query) call was found in src/index.ts — query strings must never be JSON-serialised to output."
  );
} else {
  pass("json-envelope/no-raw-query");
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n─────────────────────────────────────────");
if (failures === 0) {
  console.log(`✅  All design contracts satisfied.`);
  process.exit(0);
} else {
  console.error(`\n❌  ${failures} design contract violation(s) found.`);
  console.error(
    "    See docs/DESIGN.md for the full contract specification.\n"
  );
  process.exit(1);
}
