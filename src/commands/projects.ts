/**
 * Real implementation of `projects` on the new blueprint (see the `projects`
 * case in ../index.ts). Blueprint only - no real DB is touched; the backend
 * is injected, defaulting to a safe simulation.
 *
 * Modes:
 *   `smriti projects`           List all projects
 *   `smriti projects <id>`      Inspect a single project
 *
 * The projectId positional is optional when listing. When a projectId is
 * provided (and doesn't start with --), it switches to inspect mode.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, CommandError, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import {
  listProjects as dbListProjects,
  getProjectReport as dbGetProjectReport,
  type ProjectInspectReport,
} from "../db";

export interface ProjectInfo {
  id: string;
  path: string | null;
  description: string | null;
  created_at: string;
}

// Re-exported so callers of this file don't need to import from ../db directly.
export type { ProjectInspectReport };

export interface ProjectsListResult {
  projects: ProjectInfo[];
}

export interface ProjectsInspectResult {
  report: ProjectInspectReport;
  format: "full" | "tags" | "decisions";
}

export type ProjectsResult = ProjectsListResult | ProjectsInspectResult;

/** Injected backend seams - default simulations, no real DB access. */
export interface ProjectsBackend {
  /** List all projects. */
  listProjects(): Promise<ProjectInfo[]>;
  /** Get detailed report for one project, or null if not found. */
  getProjectReport(id: string): Promise<ProjectInspectReport | null>;
}

const simulateBackend: ProjectsBackend = {
  async listProjects() {
    return [
      { id: "myapp", path: "/Users/ashutosh/projects/myapp", description: "Main application", created_at: "2026-01-01T00:00:00Z" },
      { id: "utils", path: "/Users/ashutosh/projects/utils", description: null, created_at: "2026-01-02T00:00:00Z" },
      { id: "archived", path: null, description: "Old project (no path)", created_at: "2026-01-03T00:00:00Z" },
    ];
  },
  async getProjectReport(id: string) {
    if (id === "myapp") {
      return {
        project: { id: "myapp", path: "/Users/ashutosh/projects/myapp", description: "Main application", language: null, framework: null },
        sessionCount: 42,
        messageCount: 1024,
        byAgent: [{ agent_id: "claude", session_count: 25 }, { agent_id: "copilot", session_count: 17 }],
        tags: [{ category_id: "architecture", session_count: 10 }, { category_id: "bugfix", session_count: 8 }],
        decisionCount: 5,
        recentSessions: [
          { id: "2024-01-15T10:30:00Z", title: "API auth implementation", updated_at: "2024-01-15T10:30:00Z", agent_id: "claude", categories: "architecture" },
          { id: "2024-01-14T14:20:00Z", title: "Database schema review", updated_at: "2024-01-14T14:20:00Z", agent_id: "claude", categories: "" },
        ],
      };
    }
    return null;
  },
};

/**
 * Real backend - a pure pass-through to db.ts's listProjects/getProjectReport.
 * Mirrors the real `projects` case in index.ts exactly: `listProjects()` is
 * `listProjects(db)` with no arguments; `getProjectReport(id)` is
 * `getProjectReport(db, id)`, returning `null` when the project id isn't
 * found, same as the real case's `if (!report) { ...; process.exit(1); }`
 * guard. Not wired into any default - callers opt in explicitly via
 * createRealProjectsBackend(db).
 *
 * This used to convert db.ts's real shapes into invented ones
 * (agentBreakdown/categoryBreakdown/taggedCount/untaggedCount) that
 * `formatProjectReport` (../format.ts) does not actually accept, and that
 * required a new, live-unverified SQL query to compute. Reverted to a plain
 * pass-through of db.ts's real ProjectInspectReport/listProjects shapes -
 * no invented fields, no unverified queries, and the real `formatProjectReport`
 * can now be called directly with this command's output.
 */
export function createRealProjectsBackend(db: Database): ProjectsBackend {
  return {
    async listProjects() {
      return dbListProjects(db);
    },
    async getProjectReport(id) {
      return dbGetProjectReport(db, id);
    },
  };
}

export class ProjectsCommand extends BaseCommand<ProjectsResult> {
  constructor(private readonly backend: ProjectsBackend = simulateBackend) {
    super();
  }

  name = "projects";
  summary = "List projects or inspect a project";
  args: ArgSpec[] = [
    {
      name: "id",
      type: "string",
      required: false,
      description: "project id to inspect (optional; omit to list all)",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--json", type: "boolean", description: "output as JSON" },
    { flag: "--tags", type: "boolean", description: "with project id, show tags breakdown" },
    { flag: "--decisions", type: "boolean", description: "with project id, show decisions only" },
  ];
  output = {
    description: "list of projects (with id, path, description) or a single project report",
    jsonShape: "list mode: { projects: ProjectInfo[] } | inspect mode: { report: ProjectInspectReport, format: 'full'|'tags'|'decisions' }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti projects", description: "list all projects" },
    { command: "smriti projects myapp", description: "inspect a single project" },
    { command: "smriti projects myapp --tags", description: "inspect with tags breakdown" },
  ];
  detailedSummary =
    "Without an id, lists all registered projects (id, path, description). " +
    "With an id, shows a detailed report including session counts, agent breakdown, " +
    "category distribution, and recent sessions. Use --tags to focus on tag breakdown " +
    "or --decisions to show decisions only.";

  protected async execute(parsed: ParsedArgs): Promise<ProjectsResult> {
    const projectId = parsed.positionals[0];
    const tagsOnly = parsed.flags["--tags"] === true;
    const decisionsOnly = parsed.flags["--decisions"] === true;

    // Inspect mode: single project
    if (projectId) {
      const report = await this.backend.getProjectReport(projectId);
      if (!report) {
        throw new CommandError(`Project not found: ${projectId}`, "NOT_FOUND", { projectId });
      }

      let format: "full" | "tags" | "decisions" = "full";
      if (tagsOnly) format = "tags";
      if (decisionsOnly) format = "decisions";

      return { report, format };
    }

    // List mode: all projects
    const projects = await this.backend.listProjects();
    return { projects };
  }
}
