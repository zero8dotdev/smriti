/**
 * Real implementation of `config` on the new blueprint (see the `config`
 * case in ../index.ts). Blueprint only - no real .smriti/config.json is
 * read or written; backends are injected, defaulting to safe simulations.
 *
 * Interesting shape, different from `daemon`: bare `config` is NOT a
 * distinct "foreground"-style mode - the real CLI's `if (!sub || sub ===
 * "show")` makes bare mode a literal alias for the `show` subcommand.
 * Modeled here as delegation (execute() calls the `show` subcommand's own
 * run(), not a duplicated implementation) rather than the two facts
 * silently drifting apart.
 */

import type { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { BaseCommand, CommandError, type CommandContext, type ParsedArgs } from "../command";
import { BaseSubcommandCommand } from "../subcommand";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { readConfig as realReadConfig, writeConfig as realWriteConfig, exportCustomCategories as realExportCustomCategories } from "../team/config";
import { addCategory as realAddCategory } from "../db";

const NO_ARGS: ArgSpec[] = [];

/**
 * Mirrors the smritiDir resolution inline in ../index.ts case "config":
 *   - if --project <id> is given, look up its path in smriti_projects and
 *     use `<path>/.smriti`
 *   - otherwise `<cwd>/.smriti`
 *
 * The three Backend callback shapes below (`() => Promise<ShowResult>` etc.)
 * take no arguments, so - unlike a per-call `db` handle threaded through a
 * SearchBackend-style method - there is nowhere for a per-invocation
 * `--project` value to be threaded through at call time. Real wiring must
 * therefore resolve smritiDir once, at factory-construction time, from
 * whatever `--project` value the caller already parsed out of argv - exactly
 * mirroring what the index.ts case block computes before dispatching to
 * show/add-category/sync-categories.
 */
function resolveSmritiDir(db: Database, project?: string): string {
  if (project) {
    const p = db.prepare(`SELECT path FROM smriti_projects WHERE id = ?`).get(project) as { path: string } | null;
    if (p?.path) return join(p.path, ".smriti");
  }
  return join(process.cwd(), ".smriti");
}

// =============================================================================
// show
// =============================================================================

export interface CustomCategory {
  id: string;
  name: string;
  parent?: string;
  description?: string;
}

export interface ShowResult {
  configPath: string;
  version: number;
  categories: CustomCategory[];
}

async function simulateReadConfig(): Promise<ShowResult> {
  return { configPath: ".smriti/config.json", version: 1, categories: [] };
}

export class ConfigShowCommand extends BaseCommand<ShowResult> {
  constructor(private readonly readConfig: () => Promise<ShowResult> = simulateReadConfig) {
    super();
  }

  name = "show";
  summary = "Show the current .smriti/config.json";
  args = NO_ARGS;
  flags: FlagSpec[] = [{ flag: "--project", type: "string", description: "resolve config for this project instead of cwd" }];
  output = {
    description: "prints the config path, version, and custom categories",
    jsonShape: "{ configPath: string, version: number, categories: CustomCategory[] }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti config show", description: "config for the current directory" },
    { command: "smriti config show --project myapp", description: "config for a specific project" },
    { command: "smriti config", description: "bare mode - identical to `config show`" },
  ];
  detailedSummary = "Reads .smriti/config.json, creating no file if one doesn't exist yet - reports version 1 with no custom categories.";

  protected async execute(): Promise<ShowResult> {
    return this.readConfig();
  }
}

/**
 * Real backend for `config show` / bare `config`.
 *
 * Mirrors ../index.ts case "config" (`!sub || sub === "show"` branch):
 *   - config = readConfig(smritiDir)                    from ../team/config
 * `configPath` mirrors the `${smritiDir}/config.json` string index.ts prints
 * in its non-JSON output; `version`/`categories` come straight off the
 * SmritiConfig readConfig() returns (categories defaulting to [] exactly as
 * index.ts does with `config.categories ?? []`).
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealConfigShowBackend(db, project?).
 */
export function createRealConfigShowBackend(db: Database, project?: string): () => Promise<ShowResult> {
  const smritiDir = resolveSmritiDir(db, project);
  return async () => {
    const config = realReadConfig(smritiDir);
    return {
      configPath: `${smritiDir}/config.json`,
      version: config.version,
      categories: config.categories ?? [],
    };
  };
}

// =============================================================================
// add-category
// =============================================================================

export interface AddCategoryResult {
  category: CustomCategory;
  configPath: string;
}

async function simulateAddCategory(category: CustomCategory): Promise<AddCategoryResult> {
  return { category, configPath: ".smriti/config.json" };
}

export class ConfigAddCategoryCommand extends BaseCommand<AddCategoryResult> {
  constructor(private readonly addCategory: (c: CustomCategory) => Promise<AddCategoryResult> = simulateAddCategory) {
    super();
  }

  name = "add-category";
  summary = "Add a custom category to the DB and team config";
  args: ArgSpec[] = [{ name: "id", type: "string", required: true, description: "category id" }];
  flags: FlagSpec[] = [
    { flag: "--name", type: "string", required: true, description: "display name" },
    { flag: "--parent", type: "string", description: "parent category id" },
    { flag: "--description", type: "string", description: "longer description" },
    { flag: "--project", type: "string", description: "resolve config for this project instead of cwd" },
  ];
  output = {
    description: "prints the added category and where it was written",
    jsonShape: "{ category: CustomCategory, configPath: string }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti config add-category deploy --name Deployment", description: "top-level category" },
    { command: "smriti config add-category ci --name CI --parent deploy", description: "nested under an existing category" },
    { command: "smriti config add-category x --name X --description 'x things'", description: "with a description" },
  ];
  detailedSummary = "Writes to the local DB and to .smriti/config.json so the category is shared with the team.";

  protected async execute(parsed: ParsedArgs): Promise<AddCategoryResult> {
    const category: CustomCategory = {
      id: parsed.positionals[0],
      name: parsed.flags["--name"] as string,
      ...(parsed.flags["--parent"] ? { parent: parsed.flags["--parent"] as string } : {}),
      ...(parsed.flags["--description"] ? { description: parsed.flags["--description"] as string } : {}),
    };
    return this.addCategory(category);
  }
}

/**
 * Real backend for `config add-category`.
 *
 * Mirrors ../index.ts case "config" (`sub === "add-category"` branch):
 *   1. addCategory(db, id, name, parent, description)   from ../db
 *   2. mkdirSync(smritiDir, { recursive: true })
 *   3. config = readConfig(smritiDir)                   from ../team/config
 *   4. push { id, name, ...parent, ...description } into config.categories
 *      only if not already present (dedupe by id, same as index.ts)
 *   5. writeConfig(smritiDir, { ...config, version: 2, categories })
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealConfigAddCategoryBackend(db, project?).
 */
export function createRealConfigAddCategoryBackend(
  db: Database,
  project?: string
): (c: CustomCategory) => Promise<AddCategoryResult> {
  const smritiDir = resolveSmritiDir(db, project);
  return async (category: CustomCategory) => {
    // Add to local DB
    realAddCategory(db, category.id, category.name, category.parent, category.description);

    // Write to config.json
    mkdirSync(smritiDir, { recursive: true });
    const config = realReadConfig(smritiDir);
    const categories = config.categories ?? [];
    if (!categories.find((c) => c.id === category.id)) {
      categories.push({
        id: category.id,
        name: category.name,
        ...(category.parent ? { parent: category.parent } : {}),
        ...(category.description ? { description: category.description } : {}),
      });
    }
    await realWriteConfig(smritiDir, { ...config, version: 2, categories });

    return { category, configPath: `${smritiDir}/config.json` };
  };
}

// =============================================================================
// sync-categories
// =============================================================================

export interface SyncResult {
  synced: number;
  configPath: string;
}

async function simulateSync(): Promise<SyncResult> {
  return { synced: 0, configPath: ".smriti/config.json" };
}

export class ConfigSyncCategoriesCommand extends BaseCommand<SyncResult> {
  constructor(private readonly syncCategories: () => Promise<SyncResult> = simulateSync) {
    super();
  }

  name = "sync-categories";
  summary = "Export DB custom categories into .smriti/config.json";
  args = NO_ARGS;
  flags: FlagSpec[] = [{ flag: "--project", type: "string", description: "resolve config for this project instead of cwd" }];
  output = { description: "prints how many categories were synced", jsonShape: "{ synced: number, configPath: string }" };
  examples: [Example, Example, Example] = [
    { command: "smriti config sync-categories", description: "sync for the current directory" },
    { command: "smriti config sync-categories --project myapp", description: "sync a specific project" },
    { command: "smriti config sync-categories", description: "safe to re-run, synced count is 0 if nothing new" },
  ];
  detailedSummary = "One-way: DB -> config.json. Does not read categories back out of config.json.";

  protected async execute(): Promise<SyncResult> {
    return this.syncCategories();
  }
}

/**
 * Real backend for `config sync-categories`.
 *
 * Mirrors ../index.ts case "config" (`sub === "sync-categories"` branch):
 *   1. mkdirSync(smritiDir, { recursive: true })
 *   2. config = readConfig(smritiDir)                       from ../team/config
 *   3. categories = exportCustomCategories(db)               from ../team/config
 *   4. writeConfig(smritiDir, { ...config, version: categories.length > 0 ? 2 : config.version, categories })
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealConfigSyncCategoriesBackend(db, project?).
 */
export function createRealConfigSyncCategoriesBackend(db: Database, project?: string): () => Promise<SyncResult> {
  const smritiDir = resolveSmritiDir(db, project);
  return async () => {
    mkdirSync(smritiDir, { recursive: true });
    const config = realReadConfig(smritiDir);
    const categories = realExportCustomCategories(db);
    await realWriteConfig(smritiDir, {
      ...config,
      version: categories.length > 0 ? 2 : config.version,
      categories,
    });

    return { synced: categories.length, configPath: `${smritiDir}/config.json` };
  };
}

// =============================================================================
// config (parent) - bare mode delegates to `show`, not a distinct behavior
// =============================================================================

export class ConfigCommand extends BaseSubcommandCommand<ShowResult> {
  readonly subcommands = {
    show: new ConfigShowCommand(),
    "add-category": new ConfigAddCategoryCommand(),
    "sync-categories": new ConfigSyncCategoriesCommand(),
  };

  name = "config";
  summary = "Show or modify .smriti/config.json";
  args = NO_ARGS;
  flags: FlagSpec[] = [];
  output = { description: "bare mode is identical to `config show`; see subcommands for the rest" };
  examples: [Example, Example, Example] = [
    { command: "smriti config", description: "same as `smriti config show`" },
    { command: "smriti config add-category deploy --name Deployment", description: "add a category" },
    { command: "smriti config sync-categories", description: "sync DB categories to config.json" },
  ];
  detailedSummary =
    "Bare mode is a real alias for `show`, not a separate implementation - " +
    "delegates to the `show` subcommand's own run() so the two can never drift apart.";

  protected async execute(_parsed: ParsedArgs, ctx: CommandContext): Promise<ShowResult> {
    const result = await this.subcommands.show.run({ argv: [], json: ctx.json });
    if (!result.ok) {
      throw new CommandError(result.error.message, result.error.code, result.error.detail);
    }
    return result.data as ShowResult;
  }
}
