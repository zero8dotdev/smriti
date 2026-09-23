/**
 * Real implementation of `categories` on the new blueprint (see the
 * `categories` case in ../index.ts, ~line 727). Blueprint only - no real DB
 * is touched; the category store is injected via the constructor, defaulting
 * to a safe simulated implementation.
 *
 * Shape, from index.ts: `categories add <id> --name <name> [--parent <id>]
 * [--description <desc>]` is the one real subcommand (backed by
 * db.ts's addCategory). Anything else - bare `categories`, or any args[1]
 * that isn't the literal string "add" - falls through to printing the
 * category tree (db.ts's getCategoryTree + getCategories, rendered by
 * format.ts's formatCategoryTree). Modeled here as BaseSubcommandCommand
 * with one registered subcommand ("add") and a real bare-mode execute() for
 * the tree listing - the "distinct default mode" shape (like `daemon`'s
 * foreground mode), not `config`'s "bare aliases a named subcommand" shape,
 * because tree-listing has no subcommand name of its own to delegate to.
 *
 * Real CLI also has no `--json` branch for `categories` at all (unlike
 * `tags`/`context`/`compare` right below it in index.ts) - bare mode always
 * prints the same formatted tree text, `add` always prints the same one
 * line. So neither command here declares or branches on `--json`; both just
 * return their structured result and let a presentation layer decide how to
 * render it, same as every other command in this file.
 *
 * The real `categories` case treats ANY args[1] value other than the
 * literal string "add" as "show the tree" - e.g. `smriti categories bogus`
 * still prints the tree, it does not error. This is exactly what
 * `unmatchedSubcommandFallsThrough = true` (see subcommand.ts) models -
 * added there after this command (and `insights`, independently) both hit
 * the same real pattern - so this is now faithfully reproduced, not
 * approximated.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import { BaseSubcommandCommand } from "../subcommand";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { addCategory as dbAddCategory, getCategories as dbGetCategories } from "../db";

const NO_ARGS: ArgSpec[] = [];

// =============================================================================
// Shared types (mirror db.ts's getCategories/getCategoryTree row shapes)
// =============================================================================

/** Mirrors db.ts's getCategories(db) row shape exactly (including parent_id's snake_case). */
export interface CategoryRecord {
  id: string;
  name: string;
  parent_id: string | null;
  description: string;
}

/** Injected backend seam - default simulation, no real DB access. */
export interface CategoriesBackend {
  /** Mirrors db.ts's getCategories(db) with no parentId filter - the full flat list. */
  listCategories(): Promise<CategoryRecord[]>;
  /**
   * Mirrors db.ts's addCategory(db, id, name, parentId, description). `id`
   * is the table's PRIMARY KEY and the real insert is a plain INSERT (not
   * INSERT OR REPLACE) - a real backend rejects a duplicate id.
   */
  addCategory(
    id: string,
    name: string,
    parentId: string | undefined,
    description: string | undefined
  ): Promise<void>;
}

const simulateBackend: CategoriesBackend = {
  async listCategories() {
    return []; // simulate an empty category table by default - exercises the "no categories yet" path
  },
  async addCategory() {
    // simulated write always succeeds - no real DB, no duplicate-id table to violate
  },
};

/**
 * Real backend - wires the injected seam to the actual smriti_categories
 * table via db.ts. Mirrors the real `categories` case in index.ts (~line
 * 727) exactly: `listCategories()` is `getCategories(db)` called with no
 * parentId (the full flat list, id-ordered); `addCategory()` is
 * `addCategory(db, id, name, parentId, description)` (a plain INSERT -
 * duplicate ids throw, unresolved parent ids are not validated, matching
 * the real CLI). Not wired into any default - callers opt in explicitly
 * via createRealCategoriesBackend(db).
 */
export function createRealCategoriesBackend(db: Database): CategoriesBackend {
  return {
    async listCategories() {
      return dbGetCategories(db);
    },
    async addCategory(id, name, parentId, description) {
      dbAddCategory(db, id, name, parentId, description);
    },
  };
}

// =============================================================================
// add
// =============================================================================

export interface CategoriesAddResult {
  id: string;
  name: string;
  parentId?: string;
  description?: string;
}

export class CategoriesAddCommand extends BaseCommand<CategoriesAddResult> {
  constructor(private readonly backend: CategoriesBackend = simulateBackend) {
    super();
  }

  name = "add";
  summary = "Add a new category";
  args: ArgSpec[] = [{ name: "id", type: "string", required: true, description: "category id (must be unique)" }];
  flags: FlagSpec[] = [
    { flag: "--name", type: "string", required: true, description: "display name" },
    { flag: "--parent", type: "string", description: "parent category id" },
    { flag: "--description", type: "string", description: "longer description" },
  ];
  output = {
    description: "prints the added category id and name",
    jsonShape: "{ id: string, name: string, parentId?: string, description?: string }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti categories add deploy --name Deployment", description: "add a top-level category" },
    {
      command: "smriti categories add ci --name CI --parent deploy",
      description: "add a category nested under an existing one",
    },
    {
      command: "smriti categories add bugs --name Bugs --description 'defect reports'",
      description: "add a category with a description",
    },
  ];
  detailedSummary =
    "id must be unique - the underlying table's id is a primary key, so adding an id that already " +
    "exists fails. --parent references another category's id but is not validated to exist first " +
    "(matches the real CLI: addCategory() does not check the parent exists before inserting).";

  protected async execute(parsed: ParsedArgs): Promise<CategoriesAddResult> {
    const id = parsed.positionals[0];
    const name = parsed.flags["--name"] as string;
    const parentId = parsed.flags["--parent"] as string | undefined;
    const description = parsed.flags["--description"] as string | undefined;

    await this.backend.addCategory(id, name, parentId, description);

    return {
      id,
      name,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  }
}

// =============================================================================
// categories (parent) - bare mode prints the category tree
// =============================================================================

/** One direct child in the rendered tree - same fields as a root node, minus its own children (real getCategoryTree/formatCategoryTree only ever render one level of nesting). */
export interface CategoryTreeChild {
  id: string;
  name: string;
  description: string;
}

export interface CategoryTreeNode {
  id: string;
  name: string;
  description: string;
  children: CategoryTreeChild[];
}

export interface ListCategoriesResult {
  tree: CategoryTreeNode[];
}

/**
 * Rebuilds db.ts's getCategoryTree(db) shape (then flattened the way
 * format.ts's formatCategoryTree walks it) from a flat list: root nodes are
 * categories with no parent_id; each root's children are looked up by
 * parent_id from the full flat list.
 *
 * Faithfully reproduces the real function's one real quirk: a category
 * whose parent_id points at something that is NOT itself a root category
 * (i.e. a grandchild, or an orphan pointing at a nonexistent id) has
 * nowhere to attach and is silently dropped from the tree - not a bug
 * introduced here, db.ts's getCategoryTree does exactly the same (its
 * `tree` Map is only ever seeded from root categories, so a second-level
 * parent_id lookup that misses is just discarded, never recursed into).
 */
function buildTree(all: CategoryRecord[]): CategoryTreeNode[] {
  const nodes = new Map<string, CategoryTreeNode>();

  for (const cat of all.filter((c) => !c.parent_id)) {
    nodes.set(cat.id, { id: cat.id, name: cat.name, description: cat.description, children: [] });
  }

  for (const cat of all.filter((c) => c.parent_id)) {
    const parent = nodes.get(cat.parent_id!);
    if (parent) parent.children.push({ id: cat.id, name: cat.name, description: cat.description });
  }

  return Array.from(nodes.values());
}

/**
 * `smriti categories` - real, non-throwaway implementation on the new
 * blueprint. Bare mode (tree listing) is this class's own execute(); `add`
 * is a fully independent BaseCommand below, sharing the same injected
 * backend so a test (or a future caller) only ever configures one seam.
 */
export class CategoriesCommand extends BaseSubcommandCommand<ListCategoriesResult> {
  readonly subcommands: Readonly<Record<string, BaseCommand<unknown>>>;
  /** Real CLI: any args[1] other than "add" shows the tree, not an error. See file header. */
  protected readonly unmatchedSubcommandFallsThrough = true;

  constructor(private readonly backend: CategoriesBackend = simulateBackend) {
    super();
    this.subcommands = { add: new CategoriesAddCommand(backend) };
  }

  name = "categories";
  summary = "List all categories as a tree, or add a new one";
  args = NO_ARGS;
  flags: FlagSpec[] = [];
  output = {
    description: "prints the category tree: each root category, followed by its direct children indented",
    jsonShape:
      "{ tree: Array<{ id: string, name: string, description: string, children: Array<{ id: string, name: string, description: string }> }> }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti categories", description: "list all categories as a tree" },
    { command: "smriti categories add deploy --name Deployment", description: "add a new root category" },
    {
      command: "smriti categories add ci --name CI --parent deploy",
      description: "add a category nested under deploy",
    },
  ];
  detailedSummary =
    "Bare mode lists every category as a two-level tree (root categories with their direct children); " +
    "`add` is the only real subcommand. Matching the real CLI, any other leading token (typos included) " +
    "also falls through to the tree listing rather than erroring.";

  protected async execute(): Promise<ListCategoriesResult> {
    const all = await this.backend.listCategories();
    return { tree: buildTree(all) };
  }
}
