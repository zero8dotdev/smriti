/**
 * daemon/handlers.ts - FS-event → agent routing helpers.
 *
 * Pure helpers that turn a file path into the agent name responsible for
 * that path, and produce the list of (agent, root) pairs the daemon
 * should watch.
 *
 * For v0.8.0 the routing is coarse: we map by agent, not by project.
 * The downside is that a change in one Claude project causes a scan
 * across all Claude projects; the upside is that ingest() is already
 * incremental, so unchanged sessions cost almost nothing. A per-project
 * resolution layer can replace this without changing the daemon shape.
 */

import { existsSync } from "node:fs";
import { sep } from "node:path";

import {
  CLAUDE_LOGS_DIR,
  CODEX_LOGS_DIR,
  CLINE_LOGS_DIR,
  COPILOT_STORAGE_DIR,
} from "../config";

export type AgentRoot = {
  /** Stable agent identifier matching the value passed to `ingest(db, agent)`. */
  agent: string;
  /** Absolute filesystem root the daemon will watch for this agent. */
  root: string;
};

/**
 * Return the default agent roots the daemon should watch.
 * Filters out roots that don't currently exist on disk so we don't
 * crash trying to watch a Codex install that isn't there.
 */
export function getDefaultAgentRoots(): AgentRoot[] {
  const candidates: AgentRoot[] = [
    { agent: "claude", root: CLAUDE_LOGS_DIR },
    { agent: "codex", root: CODEX_LOGS_DIR },
    { agent: "cline", root: CLINE_LOGS_DIR },
  ];
  if (COPILOT_STORAGE_DIR) {
    candidates.push({ agent: "copilot", root: COPILOT_STORAGE_DIR });
  }
  return candidates.filter((c) => c.root && existsSync(c.root));
}

/**
 * Given an absolute file path and a list of agent roots, return the agent
 * that owns the path, or null if no root contains it.
 *
 * Matching is done by string prefix with a trailing separator guard to
 * avoid false positives like `~/.claude/projects-archive/` matching
 * `~/.claude/projects/`.
 */
export function resolveAgentForPath(
  path: string,
  roots: AgentRoot[],
): string | null {
  for (const { agent, root } of roots) {
    if (!root) continue;
    if (path === root) return agent;
    if (path.startsWith(root + sep)) return agent;
  }
  return null;
}
