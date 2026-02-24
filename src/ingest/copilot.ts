/**
 * copilot.ts - GitHub Copilot chat conversation parser
 *
 * Reads conversation data from VS Code's workspaceStorage chatSessions
 * and normalizes to QMD's addMessage() format.
 *
 * Storage paths:
 *   macOS:   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/
 *   Linux:   ~/.config/Code/User/workspaceStorage/<hash>/chatSessions/
 *   Windows: %APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\
 *
 * VS Code Insiders uses "Code - Insiders" instead of "Code" — both are checked.
 */

import { existsSync } from "fs";
import { join, basename } from "path";
import { homedir, platform } from "os";
import { PROJECTS_ROOT } from "../config";
import { addMessage } from "../qmd";
import type { ParsedMessage, IngestResult, IngestOptions } from "./index";

// =============================================================================
// VS Code chatSessions JSON types
// =============================================================================

/** A single conversation turn (older VS Code: turns[] format) */
type CopilotTurn = {
  role?: string;
  content?: string;
  /** Some versions nest content here */
  message?: string | { value?: string };
  timestamp?: string | number;
};

/** VS Code chatSessions JSON file shape */
type CopilotSession = {
  sessionId?: string;
  title?: string;
  /** Older VS Code: flat array of turns */
  turns?: CopilotTurn[];
  /** VS Code 1.90+: request/response pairs */
  requests?: Array<{
    message?: CopilotTurn;
    response?: CopilotTurn | CopilotTurn[];
  }>;
};

// =============================================================================
// Path resolution
// =============================================================================

/**
 * Resolve VS Code's workspaceStorage root directories.
 * Returns all existing paths (both stable and Insiders editions).
 */
export function resolveVSCodeStorageRoots(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  switch (platform()) {
    case "darwin":
      candidates.push(
        join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"),
        join(home, "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage")
      );
      break;
    case "linux":
      candidates.push(
        join(home, ".config", "Code", "User", "workspaceStorage"),
        join(home, ".config", "Code - Insiders", "User", "workspaceStorage")
      );
      break;
    case "win32":
      candidates.push(
        join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User", "workspaceStorage"),
        join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code - Insiders", "User", "workspaceStorage")
      );
      break;
  }

  // Allow override via env var
  const envPath = Bun.env.COPILOT_STORAGE_DIR;
  if (envPath) candidates.unshift(envPath);

  return candidates.filter(existsSync);
}

/**
 * Extract the workspace folder path from a workspaceStorage hash directory.
 * workspace.json shape: { "folder": "file:///Users/..." } or { "workspace": "..." }
 */
function readWorkspacePath(hashDir: string): string | null {
  const wsJsonPath = join(hashDir, "workspace.json");
  try {
    const parsed = JSON.parse(Bun.file(wsJsonPath).toString()) as {
      folder?: string;
      workspace?: string;
    };
    const raw = parsed.folder || parsed.workspace || null;
    if (!raw) return null;
    return decodeURIComponent(raw.replace(/^file:\/\//, ""));
  } catch {
    return null;
  }
}

/**
 * Derive a clean project ID from a workspace path.
 * Mirrors the logic used by claude.ts and cline.ts.
 */
export function deriveProjectId(workspacePath: string): string {
  const root = PROJECTS_ROOT.replace(/\/+$/, "");
  if (workspacePath === root) return basename(root);
  if (workspacePath.startsWith(root + "/")) return workspacePath.slice(root.length + 1);
  return basename(workspacePath) || "unknown";
}

// =============================================================================
// Parsing
// =============================================================================

/** Extract text from a turn regardless of which VS Code version wrote it */
function extractTurnText(turn: CopilotTurn): string {
  if (typeof turn.content === "string") return turn.content;
  if (typeof turn.message === "string") return turn.message;
  if (typeof turn.message === "object" && turn.message?.value) return turn.message.value;
  return "";
}

/** Normalise a timestamp value to ISO string or undefined */
function toIso(ts?: string | number): string | undefined {
  if (!ts) return undefined;
  return typeof ts === "number" ? new Date(ts).toISOString() : ts;
}

/**
 * Parse a chatSessions JSON file into normalised ParsedMessage[].
 * Handles both the turns[] (older) and requests[] (VS Code 1.90+) formats.
 */
export function parseCopilotJson(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  let session: CopilotSession;
  try {
    session = JSON.parse(content);
  } catch {
    return messages;
  }

  // --- Format 1: session.turns[] (older VS Code)
  if (Array.isArray(session.turns)) {
    for (const turn of session.turns) {
      if (!turn.role || (turn.role !== "user" && turn.role !== "assistant")) continue;
      const text = extractTurnText(turn);
      if (!text.trim()) continue;
      messages.push({ role: turn.role, content: text, timestamp: toIso(turn.timestamp) });
    }
    return messages;
  }

  // --- Format 2: session.requests[] (VS Code 1.90+)
  if (Array.isArray(session.requests)) {
    for (const req of session.requests) {
      if (req.message) {
        const text = extractTurnText(req.message);
        if (text.trim()) {
          messages.push({ role: "user", content: text, timestamp: toIso(req.message.timestamp) });
        }
      }
      const responses = Array.isArray(req.response)
        ? req.response
        : req.response ? [req.response] : [];
      const responseText = responses.map(extractTurnText).filter(Boolean).join("\n\n");
      if (responseText.trim()) {
        messages.push({
          role: "assistant",
          content: responseText,
          timestamp: toIso(responses[0]?.timestamp),
        });
      }
    }
    return messages;
  }

  return messages;
}

// =============================================================================
// Discovery
// =============================================================================

export type CopilotSessionMeta = {
  sessionId: string;
  filePath: string;
  workspacePath: string | null;
};

/**
 * Discover all Copilot chatSession files across VS Code workspaceStorage roots.
 */
export async function discoverCopilotSessions(options: {
  storageRoots?: string[];
  projectPath?: string;
} = {}): Promise<CopilotSessionMeta[]> {
  const roots = options.storageRoots ?? resolveVSCodeStorageRoots();
  const sessions: CopilotSessionMeta[] = [];

  for (const root of roots) {
    const glob = new Bun.Glob("*/chatSessions/*.json");
    try {
      for await (const match of glob.scan({ cwd: root, absolute: false })) {
        const filePath = join(root, match);
        const hashDir = join(root, match.split("/")[0]);
        const workspacePath = readWorkspacePath(hashDir);

        if (options.projectPath && workspacePath !== options.projectPath) continue;

        const sessionId = `copilot-${basename(match, ".json")}`;
        sessions.push({ sessionId, filePath, workspacePath });
      }
    } catch {
      // No chatSessions in this root yet — skip
    }
  }

  return sessions;
}

// =============================================================================
// Ingestion
// =============================================================================

/**
 * Ingest GitHub Copilot (VS Code) chat sessions.
 */
export async function ingestCopilot(
  options: IngestOptions & { projectPath?: string; storageRoots?: string[] } = {}
): Promise<IngestResult> {
  const { db, existingSessionIds, onProgress } = options;
  if (!db) throw new Error("Database required for ingestion");

  const { upsertProject, upsertSessionMeta } = await import("../db");

  const sessions = await discoverCopilotSessions({
    storageRoots: options.storageRoots,
    projectPath: options.projectPath,
  });

  const result: IngestResult = {
    agent: "copilot",
    sessionsFound: sessions.length,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  if (sessions.length === 0) {
    const roots = options.storageRoots ?? resolveVSCodeStorageRoots();
    if (roots.length === 0) {
      result.errors.push(
        "VS Code workspaceStorage not found. Is VS Code installed? " +
        "Set COPILOT_STORAGE_DIR to override the path."
      );
    }
    return result;
  }

  for (const session of sessions) {
    if (existingSessionIds?.has(session.sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      const content = await Bun.file(session.filePath).text();
      const messages = parseCopilotJson(content);

      if (messages.length === 0) {
        result.skipped++;
        continue;
      }

      const workspacePath = session.workspacePath || PROJECTS_ROOT;
      const projectId = deriveProjectId(workspacePath);
      upsertProject(db, projectId, workspacePath);

      const firstUser = messages.find((m) => m.role === "user");
      const title = firstUser
        ? firstUser.content.slice(0, 100).replace(/\n/g, " ")
        : "Copilot Chat";

      for (const msg of messages) {
        await addMessage(db, session.sessionId, msg.role, msg.content, { title });
      }

      upsertSessionMeta(db, session.sessionId, "copilot", projectId);
      result.sessionsIngested++;
      result.messagesIngested += messages.length;

      if (onProgress) {
        onProgress(`Ingested ${session.sessionId} (${messages.length} messages) — project: ${projectId}`);
      }
    } catch (err: any) {
      result.errors.push(`${session.sessionId}: ${err.message}`);
    }
  }

  return result;
}
