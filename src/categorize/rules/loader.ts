/**
 * categorize/rules/loader.ts - YAML rule loading and 3-tier merge logic
 *
 * Implements the 3-tier rule system:
 * Tier 1 (Base): Downloaded from GitHub
 * Tier 2 (Project): Local .smriti/rules/custom.yml
 * Tier 3 (Runtime): CLI flags and programmatic overrides
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { fetchRulesFromGithub } from "./github";

// =============================================================================
// Types
// =============================================================================

export interface Rule {
  id: string;
  pattern: string; // RegEx as string
  category: string;
  weight: number;
  frameworks?: string[]; // Optional framework filter
  description?: string;
}

export interface RulesDocument {
  version: string;
  language: string;
  framework?: string;
  extends?: string[];
  rules: Rule[];
}

export interface RuleLoadOptions {
  projectPath?: string;
  language?: string;
  framework?: string;
  noUpdate?: boolean;
  overrideRules?: Rule[];
}

// =============================================================================
// Rule Manager
// =============================================================================

export class RuleManager {
  private cache: Map<string, Rule[]> = new Map();
  private compiled: Map<string, RegExp> = new Map();

  /**
   * Load all applicable rules for a project
   */
  async loadRules(options: RuleLoadOptions): Promise<Rule[]> {
    const cacheKey = this.getCacheKey(options);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Load base rules (Tier 1)
    const baseRules = await this.loadBaseRules(options.language || "general", options.framework);

    // Load project rules (Tier 2)
    let projectRules: Rule[] = [];
    if (options.projectPath) {
      projectRules = await this.loadProjectRules(options.projectPath);
    }

    // Merge tiers
    let merged = this.mergeRules(baseRules, projectRules, options.overrideRules || []);

    // Cache result
    this.cache.set(cacheKey, merged);
    return merged;
  }

  /**
   * Load base rules from local YAML files or GitHub
   */
  async loadBaseRules(language: string, framework?: string): Promise<Rule[]> {
    const rules: Rule[] = [];

    // Load language-specific rules + inheritance chain
    const chain = await this.resolveInheritanceChain(language, framework);

    for (const file of chain) {
      const doc = await this.loadRuleFile(file);
      if (doc && doc.rules) {
        rules.push(...doc.rules);
      }
    }

    return rules;
  }

  /**
   * Load project-specific rules from .smriti/rules/custom.yml
   */
  async loadProjectRules(projectPath: string): Promise<Rule[]> {
    const customPath = join(projectPath, ".smriti", "rules", "custom.yml");
    if (!existsSync(customPath)) {
      return [];
    }

    const doc = await this.loadRuleFile(customPath);
    return doc?.rules || [];
  }

  /**
   * Load a single YAML rule file
   */
  private async loadRuleFile(path: string): Promise<RulesDocument | null> {
    try {
      if (path.startsWith("http")) {
        // Fetch from GitHub
        const content = await fetchRulesFromGithub(path);
        return parseYaml(content) as RulesDocument;
      } else {
        // Load from filesystem
        const content = await Bun.file(path).text();
        return parseYaml(content) as RulesDocument;
      }
    } catch (err) {
      console.warn(`Failed to load rules from ${path}: ${err}`);
      return null;
    }
  }

  /**
   * Resolve the inheritance chain for a language/framework
   * E.g., TypeScript + Next.js → ["general.yml", "javascript.yml", "typescript.yml", "nextjs.yml"]
   */
  private async resolveInheritanceChain(language: string, framework?: string): Promise<string[]> {
    const chain: string[] = [];

    // Start with 'general' if not already specified
    if (language !== "general") {
      chain.push(this.getRuleFilePath("general"));
    }

    // Add language
    chain.push(this.getRuleFilePath(language));

    // Add framework if present
    if (framework) {
      chain.push(this.getRuleFilePath(`frameworks/${framework}`));
    }

    return chain;
  }

  /**
   * Get the filesystem or GitHub path for a rule file
   */
  private getRuleFilePath(name: string): string {
    // Try local path first (for built-in rules) using URL for robust path resolution
    const localPath = fileURLToPath(new URL(`./${name}.yml`, import.meta.url));

    if (existsSync(localPath)) {
      return localPath;
    }

    // Fall back to GitHub raw URL if not found locally
    const RULES_REPO = "https://raw.githubusercontent.com/zero8dotdev/smriti-rules/main";
    return `${RULES_REPO}/${name}.yml`;
  }

  /**
   * Merge rules from three tiers (base → project → runtime)
   * Later tiers override earlier ones by rule ID
   */
  mergeRules(base: Rule[], project: Rule[], runtime: Rule[]): Rule[] {
    const merged = new Map<string, Rule>();

    // Add base rules
    for (const rule of base) {
      merged.set(rule.id, { ...rule });
    }

    // Override with project rules (keep base properties if not specified)
    for (const rule of project) {
      const existing = merged.get(rule.id);
      if (existing) {
        merged.set(rule.id, { ...existing, ...rule, id: rule.id });
      } else {
        merged.set(rule.id, { ...rule });
      }
    }

    // Override with runtime rules
    for (const rule of runtime) {
      const existing = merged.get(rule.id);
      if (existing) {
        merged.set(rule.id, { ...existing, ...rule, id: rule.id });
      } else {
        merged.set(rule.id, { ...rule });
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Get or compile a RegExp for a rule pattern
   * Caches compiled patterns for performance
   */
  compilePattern(rule: Rule): RegExp {
    if (this.compiled.has(rule.id)) {
      return this.compiled.get(rule.id)!;
    }

    try {
      const regex = new RegExp(rule.pattern, "i");
      this.compiled.set(rule.id, regex);
      return regex;
    } catch (err) {
      console.warn(`Invalid pattern for rule ${rule.id}: ${err}`);
      return /(?!)/; // Never matches
    }
  }

  /**
   * Filter rules by framework
   * Global rules (no frameworks specified) always apply
   */
  filterByFramework(rules: Rule[], projectFramework: string | null): Rule[] {
    return rules.filter((rule) => {
      if (!rule.frameworks) return true; // Global rule
      if (!projectFramework) return false; // Framework-specific but project has none
      return rule.frameworks.includes(projectFramework);
    });
  }

  /**
   * Clear cache and compiled patterns
   */
  clear(): void {
    this.cache.clear();
    this.compiled.clear();
  }

  private getCacheKey(options: RuleLoadOptions): string {
    return `${options.language || "general"}:${options.framework || "none"}:${options.projectPath || ""}`;
  }
}

/**
 * Singleton instance for application-wide rule management
 */
let _ruleManager: RuleManager | null = null;

export function getRuleManager(): RuleManager {
  if (!_ruleManager) {
    _ruleManager = new RuleManager();
  }
  return _ruleManager;
}

export function resetRuleManager(): void {
  _ruleManager = null;
}
