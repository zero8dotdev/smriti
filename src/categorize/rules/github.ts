/**
 * categorize/rules/github.ts - Fetch rules from GitHub repository
 *
 * Manages caching and fetching of rule files from the
 * zero8dotdev/smriti-rules GitHub repository.
 */

import { Database } from "bun:sqlite";
import { getDb } from "../../db";

const RULES_REPO_URL =
  "https://raw.githubusercontent.com/zero8dotdev/smriti-rules/main";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// =============================================================================
// Cache Table Initialization
// =============================================================================

export function initializeRuleCache(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS smriti_rule_cache (
      language TEXT NOT NULL,
      version TEXT NOT NULL,
      framework TEXT,
      fetched_at TEXT NOT NULL,
      rules_yaml TEXT NOT NULL,
      PRIMARY KEY (language, version, framework)
    );

    CREATE INDEX IF NOT EXISTS idx_smriti_rule_cache_language
      ON smriti_rule_cache(language);
  `);
}

// =============================================================================
// Fetching
// =============================================================================

/**
 * Fetch rules from GitHub with caching
 */
export async function fetchRulesFromGithub(path: string): Promise<string> {
  // Extract language/framework from path
  // Path format: "https://raw.githubusercontent.com/.../general.yml"
  // or "frameworks/nextjs.yml"
  const filename = path.split("/").pop() || "general.yml";
  const language = filename.replace(".yml", "");
  const framework = path.includes("frameworks") ? language : undefined;

  // Check cache first
  const cached = getCachedRules("latest", language, framework);
  if (cached) {
    return cached;
  }

  // Fetch from GitHub
  const url = path.startsWith("http") ? path : `${RULES_REPO_URL}/${path}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();

    // Cache the result
    cacheRules("latest", language, framework, content);

    return content;
  } catch (err) {
    console.error(`Failed to fetch rules from ${url}: ${err}`);

    // Fall back to any cached version (even if expired)
    const fallback = getCachedRules(undefined, language, framework, true);
    if (fallback) {
      console.warn(`Using stale cached rules for ${language}`);
      return fallback;
    }

    throw err;
  }
}

/**
 * Get cached rules if not expired
 */
function getCachedRules(
  version: string | undefined,
  language: string,
  framework?: string,
  allowStale = false
): string | null {
  try {
    const db = getDb();
    const query = `
      SELECT rules_yaml, fetched_at
      FROM smriti_rule_cache
      WHERE language = ? ${version ? "AND version = ?" : ""} ${framework ? "AND framework = ?" : ""}
      LIMIT 1
    `;

    const params = [language];
    if (version) params.push(version);
    if (framework) params.push(framework);

    const row = db.prepare(query).get(...params) as {
      rules_yaml: string;
      fetched_at: string;
    } | null;

    if (!row) return null;

    // Check if cache is expired
    const fetchedTime = new Date(row.fetched_at).getTime();
    const now = Date.now();
    const isExpired = now - fetchedTime > CACHE_TTL_MS;

    if (isExpired && !allowStale) {
      return null;
    }

    return row.rules_yaml;
  } catch {
    return null;
  }
}

/**
 * Cache rules in database
 */
function cacheRules(
  version: string,
  language: string,
  framework: string | undefined,
  content: string
): void {
  try {
    const db = getDb();
    db.prepare(
      `
      INSERT OR REPLACE INTO smriti_rule_cache
      (language, version, framework, fetched_at, rules_yaml)
      VALUES (?, ?, ?, ?, ?)
    `
    ).run(language, version, framework || null, new Date().toISOString(), content);
  } catch (err) {
    console.warn(`Failed to cache rules: ${err}`);
  }
}

// =============================================================================
// Versioning
// =============================================================================

/**
 * Get the latest version of rules from GitHub
 * Checks the git tag to determine version
 */
export async function getLatestRuleVersion(): Promise<string | null> {
  try {
    // Fetch the latest tag from GitHub API
    const response = await fetch(
      "https://api.github.com/repos/zero8dotdev/smriti-rules/tags?per_page=1"
    );

    if (!response.ok) return null;

    const tags = (await response.json()) as Array<{ name: string }>;
    if (tags.length === 0) return null;

    // Assume tags are in format v1.0.0
    return tags[0].name.replace(/^v/, "");
  } catch {
    return null;
  }
}

/**
 * Check if a new version of rules is available
 */
export async function hasRuleUpdate(
  currentVersion: string
): Promise<{ hasUpdate: boolean; newVersion: string | null }> {
  const latest = await getLatestRuleVersion();
  if (!latest) {
    return { hasUpdate: false, newVersion: null };
  }

  // Simple semver comparison (assumes x.y.z format)
  const [curMajor, curMinor, curPatch] = currentVersion.split(".").map(Number);
  const [newMajor, newMinor, newPatch] = latest.split(".").map(Number);

  const hasUpdate =
    newMajor > curMajor ||
    (newMajor === curMajor && newMinor > curMinor) ||
    (newMajor === curMajor && newMinor === curMinor && newPatch > curPatch);

  return { hasUpdate, newVersion: latest };
}
