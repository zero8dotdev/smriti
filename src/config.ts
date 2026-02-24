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

/** Cline CLI tasks directory */
export const CLINE_LOGS_DIR =
  Bun.env.CLINE_LOGS_DIR || join(HOME, ".cline", "tasks");

/** GitHub Copilot (VS Code) workspaceStorage root — auto-detected per OS if not set */
export const COPILOT_STORAGE_DIR = Bun.env.COPILOT_STORAGE_DIR || "";

/** Daemon PID file path */
export const DAEMON_PID_FILE = join(HOME, ".cache", "smriti", "daemon.pid");

/** Daemon log file path */
export const DAEMON_LOG_FILE = join(HOME, ".cache", "smriti", "daemon.log");

/** Daemon debounce interval in ms — wait this long after last file change before ingesting */
export const DAEMON_DEBOUNCE_MS = Number(Bun.env.SMRITI_DAEMON_DEBOUNCE_MS || "30000");

/** Default smriti team directory name within projects */
export const SMRITI_DIR = ".smriti";

/** smriti install directory (where this repo lives) */
export const SMRITI_HOME = join(HOME, ".smriti");

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
