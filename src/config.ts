/**
 * config.ts - Configuration management for Smriti
 *
 * Centralizes paths, env vars, and defaults.
 * Bun auto-loads .env so no dotenv needed.
 */

import { homedir } from "os";
import { join } from "path";

// =============================================================================
// Paths
// =============================================================================

const HOME = homedir();

/** QMD shared database path */
export const QMD_DB_PATH =
  Bun.env.QMD_DB_PATH || join(HOME, ".cache", "qmd", "index.sqlite");

/** Claude Code project logs directory */
export const CLAUDE_LOGS_DIR =
  Bun.env.CLAUDE_LOGS_DIR || join(HOME, ".claude", "projects");

/** Codex CLI logs directory */
export const CODEX_LOGS_DIR =
  Bun.env.CODEX_LOGS_DIR || join(HOME, ".codex");

/** Default smriti team directory name within projects */
export const SMRITI_DIR = ".smriti";

/** Projects root directory for smart project ID derivation */
export const PROJECTS_ROOT =
  Bun.env.SMRITI_PROJECTS_ROOT || join(HOME, "zero8.dev");

// =============================================================================
// Ollama / LLM
// =============================================================================

export const OLLAMA_HOST = Bun.env.OLLAMA_HOST || "http://127.0.0.1:11434";
export const OLLAMA_MODEL = Bun.env.QMD_MEMORY_MODEL || "qwen3:8b-tuned";

/** Confidence threshold below which rule-based classification triggers LLM */
export const CLASSIFY_LLM_THRESHOLD = Number(
  Bun.env.SMRITI_CLASSIFY_THRESHOLD || "0.5"
);

// =============================================================================
// Defaults
// =============================================================================

export const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_RECALL_LIMIT = 10;
export const DEFAULT_CONTEXT_DAYS = 7;

/** Git author name for team sharing */
export const AUTHOR = Bun.env.SMRITI_AUTHOR || Bun.env.USER || "unknown";
