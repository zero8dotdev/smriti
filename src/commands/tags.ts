/**
 * Real implementation of `tags` on the new blueprint (see the `tags`
 * case in ../index.ts). Blueprint only - no real DB is touched; the backend
 * is injected, defaulting to a safe simulation.
 *
 * The tags command has two modes:
 * - Default: Show tag usage statistics across sessions
 * - With --available: Show the full category tree instead (like the categories command)
 *
 * The --project flag can filter tag usage to a specific project (no effect with --available).
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import {
  getCategoryTree as dbGetCategoryTree,
  getCategories as dbGetCategories,
  getTagUsage as dbGetTagUsage,
} from "../db";
import {
  formatCategoryTree as dbFormatCategoryTree,
  formatTagUsage as dbFormatTagUsage,
} from "../format";

export interface TagUsageEntry {
  category_id: string;
  session_count: number;
  display_name?: string | null;
}

export interface CategoryTreeNode {
  id: string;
  name: string;
  description?: string;
  children?: CategoryTreeNode[];
}

export interface Category {
  id: string;
  name: string;
  description?: string;
}

export interface TagsResult {
  mode: "usage" | "available";
  data: TagUsageEntry[] | CategoryTreeNode[];
  projectFilter?: string;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface TagsBackend {
  /** Get tag usage statistics, optionally filtered by project. */
  getTagUsage(projectId?: string): TagUsageEntry[];
  /** Get the category tree structure. */
  getCategoryTree(): CategoryTreeNode[];
  /** Get all categories. */
  getCategories(): Category[];
  /** Format tag usage for display. */
  formatTagUsage(usage: TagUsageEntry[], projectFilter?: string): string;
  /** Format category tree for display. */
  formatCategoryTree(tree: CategoryTreeNode[], categories: Array<{ id: string; name: string; description?: string }>): string;
}

const simulateBackend: TagsBackend = {
  getTagUsage() {
    return [
      { category_id: "architecture", session_count: 42, display_name: "architecture" },
      { category_id: "performance", session_count: 28, display_name: "performance" },
      { category_id: "bug-fix", session_count: 15 },
    ];
  },
  getCategoryTree() {
    return [
      {
        id: "root",
        name: "root",
        children: [
          { id: "architecture", name: "architecture", description: "Design patterns and architecture" },
          { id: "performance", name: "performance", description: "Performance optimization" },
        ],
      },
    ];
  },
  getCategories() {
    return [
      { id: "architecture", name: "architecture", description: "Design patterns and architecture" },
      { id: "performance", name: "performance", description: "Performance optimization" },
      { id: "bug-fix", name: "bug-fix", description: "Bug fixes" },
    ];
  },
  formatTagUsage(usage, projectFilter) {
    if (usage.length === 0) {
      return "No tags in use.";
    }
    const scope = projectFilter ? `project: ${projectFilter}` : "global";
    const lines = [`Tags in use (${scope}):`, ""];
    for (const tag of usage) {
      const name = tag.display_name || tag.category_id;
      lines.push(`  ${name.padEnd(30)}  ${tag.session_count} session${tag.session_count === 1 ? "" : "s"}`);
    }
    return lines.join("\n");
  },
  formatCategoryTree(tree, categories) {
    const lines = ["Available categories:", ""];
    for (const cat of categories) {
      lines.push(`  ${cat.name}`);
      if (cat.description) {
        lines.push(`    ${cat.description}`);
      }
    }
    return lines.join("\n");
  },
};

/**
 * Real backend, backed by the shared sqlite Database handle.
 *
 * Mirrors ../index.ts case "tags": exactly:
 *   - getCategoryTree(db)   from ../db     (used for both --available and the
 *                                            top-level `tree` passed to formatCategoryTree)
 *   - getCategories(db)     from ../db     (used for both --available and the
 *                                            `allCats` passed to formatCategoryTree)
 *   - getTagUsage(db, projectId)  from ../db      (default/usage mode)
 *   - formatCategoryTree(tree, allCats)    from ../format
 *   - formatTagUsage(usage, projectFilter) from ../format
 *
 * IMPORTANT shape note: the real `getCategoryTree(db)` returns a
 * `Map<string, { id, name, description, children: string[] }>` (flat,
 * children referenced by id), NOT the nested `CategoryTreeNode[]` this
 * blueprint's TagsBackend interface declares. Likewise the real
 * `formatCategoryTree` takes that same Map shape, not `CategoryTreeNode[]`.
 * To honor the interface contract while keeping the real query/format
 * logic byte-for-byte identical to index.ts:
 *   - getCategoryTree() converts the real Map into nested CategoryTreeNode[]
 *     (one level deep, matching what the real Map ever actually encodes).
 *   - formatCategoryTree() reconstructs the original Map shape from the
 *     CategoryTreeNode[] it's handed (using each child's `id` for the
 *     `children: string[]` field) and then delegates to the real
 *     ../format formatCategoryTree, so the rendered output is identical to
 *     what index.ts produces from the same underlying db state.
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealTagsBackend(db).
 */
export function createRealTagsBackend(db: Database): TagsBackend {
  return {
    getTagUsage(projectId?: string): TagUsageEntry[] {
      // Mirrors: const usage = getTagUsage(db, projectFilter);
      return dbGetTagUsage(db, projectId);
    },
    getCategoryTree(): CategoryTreeNode[] {
      // Mirrors: const tree = getCategoryTree(db); const allCats = getCategories(db);
      const tree = dbGetCategoryTree(db);
      const allCats = dbGetCategories(db);
      const catById = new Map(allCats.map((c) => [c.id, c]));

      const nodes: CategoryTreeNode[] = [];
      for (const [, node] of tree) {
        const children: CategoryTreeNode[] = [];
        for (const childId of node.children) {
          const child = catById.get(childId);
          if (child) {
            children.push({
              id: child.id,
              name: child.name,
              description: child.description || undefined,
            });
          }
        }
        nodes.push({
          id: node.id,
          name: node.name,
          description: node.description || undefined,
          children,
        });
      }
      return nodes;
    },
    getCategories(): Category[] {
      // Mirrors: const allCats = getCategories(db);
      return dbGetCategories(db).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description || undefined,
      }));
    },
    formatTagUsage(usage: TagUsageEntry[], projectFilter?: string): string {
      // Mirrors: formatTagUsage(usage, projectFilter)
      return dbFormatTagUsage(usage, projectFilter);
    },
    formatCategoryTree(
      tree: CategoryTreeNode[],
      categories: Array<{ id: string; name: string; description?: string }>
    ): string {
      // Reconstruct the real Map<string, {id,name,description,children:string[]}>
      // shape so the actual ../format formatCategoryTree is called with
      // equivalent input to what index.ts's case "tags": passes it.
      const map = new Map<
        string,
        { id: string; name: string; description: string; children: string[] }
      >();
      for (const node of tree) {
        map.set(node.id, {
          id: node.id,
          name: node.name,
          description: node.description || "",
          children: (node.children || []).map((c) => c.id),
        });
      }
      return dbFormatCategoryTree(
        map,
        categories.map((c) => ({ id: c.id, name: c.name, description: c.description || "" }))
      );
    },
  };
}

export class TagsCommand extends BaseCommand<TagsResult> {
  constructor(private readonly backend: TagsBackend = simulateBackend) {
    super();
  }

  name = "tags";
  summary = "Show tag usage statistics or available categories";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    {
      flag: "--available",
      type: "boolean",
      description: "show all available categories instead of usage statistics",
    },
    {
      flag: "--project",
      type: "string",
      description: "filter tag usage to a specific project (ignored with --available)",
    },
    {
      flag: "--json",
      type: "boolean",
      description: "output as JSON instead of formatted text",
    },
  ];
  output = {
    description:
      "by default shows tag usage statistics; with --available shows the category tree; " +
      "with --json outputs raw data structure",
    jsonShape:
      "{ mode: 'usage'|'available', data: TagUsageEntry[]|CategoryTreeNode[], projectFilter?: string }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti tags",
      description: "show tag usage statistics across all sessions",
    },
    {
      command: "smriti tags --project myapp",
      description: "show tag usage statistics filtered to a specific project",
    },
    {
      command: "smriti tags --available",
      description: "show all available categories and their descriptions",
    },
  ];
  detailedSummary =
    "The tags command displays tag usage statistics (session count per tag) by default. " +
    "Pass --available to show the full category tree instead (same as the categories command). " +
    "Use --project to filter usage statistics to a specific project. " +
    "Pass --json to get the raw data structure for scripting.";

  protected async execute(parsed: ParsedArgs, ctx: CommandContext): Promise<TagsResult> {
    const showAvailable = parsed.flags["--available"] === true;
    const projectFilter = parsed.flags["--project"] as string | undefined;

    if (showAvailable) {
      const tree = this.backend.getCategoryTree();
      const allCats = this.backend.getCategories();
      const formatted = this.backend.formatCategoryTree(tree, allCats);
      console.log(formatted);
      return {
        mode: "available",
        data: tree,
      };
    }

    // Show tag usage (default mode)
    const usage = this.backend.getTagUsage(projectFilter);

    if (ctx.json) {
      // Matches the original CLI exactly: prints the bare usage array, not
      // a {mode, data, projectFilter} wrapper - the richer TagsResult is
      // still returned below for programmatic callers.
      console.log(JSON.stringify(usage, null, 2));
    } else {
      const formatted = this.backend.formatTagUsage(usage, projectFilter);
      console.log(formatted);
      if (usage.length > 0) {
        console.log("");
        console.log("Run 'smriti tags --available' to see all available categories.");
      }
    }

    return {
      mode: "usage",
      data: usage,
      ...(projectFilter ? { projectFilter } : {}),
    };
  }
}
