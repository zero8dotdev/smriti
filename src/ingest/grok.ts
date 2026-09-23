/**
 * grok.ts - Grok Build session discovery.
 *
 * Sessions live at `$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/`.
 * `updates.jsonl` is the conversation log. Parsing lives in parsers/grok.ts.
 */

import { existsSync } from "fs";
import { basename, join } from "path";
import { GROK_SESSIONS_DIR, PROJECTS_ROOT } from "../config";

export type DiscoveredGrokSession = {
  sessionId: string;
  projectDir: string;
  filePath: string;
};

const SUBAGENT_KINDS = new Set(["subagent", "subagent_resume", "subagent_fork"]);

/**
 * Project id from a real working directory. Strips SMRITI_PROJECTS_ROOT
 * when the session lives under it, otherwise uses the directory name.
 */
export function deriveProjectId(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "");
  const root = PROJECTS_ROOT.replace(/\/+$/, "");
  if (normalized === root) return basename(root);
  if (normalized.startsWith(root + "/")) return normalized.slice(root.length + 1);
  return basename(normalized) || "unknown";
}

function decodeGroupName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export async function discoverGrokSessions(
  logsDir?: string
): Promise<DiscoveredGrokSession[]> {
  const dir = logsDir || GROK_SESSIONS_DIR;
  if (!existsSync(dir)) return [];

  const sessions: DiscoveredGrokSession[] = [];
  const glob = new Bun.Glob("*/*/summary.json");

  for await (const match of glob.scan({ cwd: dir, absolute: false })) {
    const normalized = match.replaceAll("\\", "/");
    const [groupName, sessionDir] = normalized.split("/");
    if (!groupName || !sessionDir) continue;

    const summaryPath = join(dir, normalized);
    const sessionPath = join(dir, groupName, sessionDir);
    const updatesPath = join(sessionPath, "updates.jsonl");
    if (!existsSync(updatesPath)) continue;

    let summary: {
      info?: { id?: string; cwd?: string };
      session_kind?: string;
    };
    try {
      summary = JSON.parse(await Bun.file(summaryPath).text());
    } catch {
      continue;
    }
    if (summary.session_kind && SUBAGENT_KINDS.has(summary.session_kind)) continue;

    const cwdFile = join(dir, groupName, ".cwd");
    let groupCwd = decodeGroupName(groupName);
    if (existsSync(cwdFile)) {
      const recorded = (await Bun.file(cwdFile).text()).trim();
      if (recorded) groupCwd = recorded;
    }

    sessions.push({
      sessionId: summary.info?.id || sessionDir,
      projectDir: summary.info?.cwd || groupCwd,
      filePath: updatesPath,
    });
  }

  return sessions;
}
