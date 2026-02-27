import type { Database } from "bun:sqlite";
import { basename } from "path";
import { deriveProjectId as deriveClaudeProjectId, deriveProjectPath as deriveClaudeProjectPath } from "./claude";
import { deriveProjectId as deriveClineProjectId, deriveProjectPath as deriveClineProjectPath } from "./cline";
import { deriveProjectId as deriveCopilotProjectId } from "./copilot";

export type ResolveSessionInput = {
  db: Database;
  sessionId: string;
  agentId: string;
  projectDir?: string;
  explicitProjectId?: string;
  explicitProjectPath?: string;
};

export type ResolvedSession = {
  sessionId: string;
  projectId: string | null;
  projectPath: string | null;
  isNew: boolean;
  existingMessageCount: number;
};

function deriveForAgent(agentId: string, projectDir?: string): { projectId: string | null; projectPath: string | null } {
  if (!projectDir) return { projectId: null, projectPath: null };

  switch (agentId) {
    case "claude":
    case "claude-code":
      return {
        projectId: deriveClaudeProjectId(projectDir),
        projectPath: deriveClaudeProjectPath(projectDir),
      };
    case "cline":
      return {
        projectId: deriveClineProjectId(projectDir),
        projectPath: deriveClineProjectPath(projectDir),
      };
    case "copilot":
      return {
        projectId: deriveCopilotProjectId(projectDir),
        projectPath: projectDir,
      };
    case "cursor":
      return {
        projectId: basename(projectDir) || "unknown",
        projectPath: projectDir,
      };
    case "codex":
      return { projectId: null, projectPath: null };
    case "file":
    case "generic":
      return {
        projectId: basename(projectDir) || "unknown",
        projectPath: projectDir,
      };
    default:
      return {
        projectId: basename(projectDir) || null,
        projectPath: projectDir,
      };
  }
}

export function resolveSession(input: ResolveSessionInput): ResolvedSession {
  const { db, sessionId, agentId, explicitProjectId, explicitProjectPath } = input;

  const derived = deriveForAgent(agentId, input.projectDir);
  const projectId = explicitProjectId || derived.projectId;
  const projectPath = explicitProjectPath || derived.projectPath;

  const existingMessageCount =
    (db
      .prepare(`SELECT COUNT(*) as count FROM memory_messages WHERE session_id = ?`)
      .get(sessionId) as { count: number } | null)?.count ?? 0;

  const existingSession = db
    .prepare(`SELECT 1 as yes FROM smriti_session_meta WHERE session_id = ?`)
    .get(sessionId) as { yes: number } | null;

  return {
    sessionId,
    projectId,
    projectPath,
    existingMessageCount,
    isNew: !existingSession,
  };
}
