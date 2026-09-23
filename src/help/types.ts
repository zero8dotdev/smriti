/**
 * help/types.ts - Structured, tiered help contract for Smriti commands
 *
 * Every command's help is one object. Nothing is rendered from a second,
 * hand-maintained prose source — text and --json output both come from the
 * same CommandHelp instance, so they can't drift apart.
 *
 * Tiers (cheapest to most expensive to retrieve):
 *   1. Identity   - name + summary only (what `smriti help` lists for every command)
 *   2. Signature  - args, flags, output contract (what `smriti <cmd> --help` shows)
 *   3. Example    - tier 2 + one worked example (1|2|3) + detailedSummary
 *                   (what `smriti <cmd> --help --with-example <n>` shows)
 *
 * Each command implements this by extending BaseCommandHelp and filling in
 * the abstract fields - the render/toJSON methods are shared, not
 * reimplemented per command. Genuinely unimplemented commands (init, rules)
 * extend BaseStubCommandHelp instead - see the bottom of this file - rather
 * than fabricate fake examples to satisfy the full contract.
 */

export type ValueType = "string" | "number" | "boolean";

/** A single positional argument a command accepts. */
export interface ArgSpec {
  name: string;
  type: ValueType;
  required: boolean;
  description: string;
  /** If set, the value must be one of these (still a "string"-typed arg underneath). */
  enum?: string[];
  /**
   * If set, `required` is bypassed when any of these flags is present -
   * e.g. `forget <session-id>` is required unless `--all` is given, same as
   * `compare <a> <b>` vs `compare --last`. Independent of `required` itself:
   * without this, `required: true` always applies.
   */
  requiredUnless?: string[];
}

/** A single flag (--foo) a command accepts. */
export interface FlagSpec {
  flag: string;
  type: ValueType;
  /** Omit for flags with no default (e.g. required flags, or boolean switches defaulting to false). */
  default?: string;
  /** Defaults to false (most flags are optional) - set true for a flag that must be present. */
  required?: boolean;
  description: string;
  /** If set, the value must be one of these. */
  enum?: string[];
}

/** What a command produces - both the human description and, if applicable, the --json shape. */
export interface OutputSpec {
  description: string;
  /** Shape of the output when --json is passed, if the command supports it. */
  jsonShape?: string;
}

/** One worked, runnable example. Commands must define exactly three (1, 2, 3). */
export interface Example {
  command: string;
  description: string;
}

export type ExampleNumber = 1 | 2 | 3;

/**
 * "If `flag` is present, at least one of `confirmFlag` must also be
 * present" - e.g. `forget --hard` requires `--yes`; `consolidate --prune`
 * requires `--yes` or `--apply`.
 */
export interface ConfirmationGate {
  flag: string;
  confirmFlag: string[];
}

/** Minimal shape every command satisfies, implemented or not - what a global `smriti help` listing loops over. */
export interface CommandIdentity {
  readonly name: string;
  readonly summary: string;
  renderTier1(): string;
}

/**
 * The full data contract for one command's help. This is the top-level
 * interface every implemented command's help class satisfies (via
 * BaseCommandHelp). Unimplemented commands use {@link StubCommandHelp} instead.
 */
export interface CommandHelp extends CommandIdentity {
  args: ArgSpec[];
  flags: FlagSpec[];
  output: OutputSpec;

  /** Exactly three - selectable via --with-example <1|2|3>. */
  examples: [Example, Example, Example];
  detailedSummary: string;

  /**
   * Groups of flag names where at least one member of each group must be
   * present (e.g. enrich needs one of --density/--queries/--clusters).
   * Independent of each flag's own `required` - that's "this exact flag is
   * mandatory," this is "pick at least one from this set."
   */
  requiredFlagGroups?: string[][];

  /** See {@link ConfirmationGate}. */
  confirmationGates?: ConfirmationGate[];
}

/**
 * Machine-readable shape returned by --json at any tier. Superset of
 * CommandHelp with an explicit `tier` marker so consumers know how much of
 * the object is populated (tier 1 responses omit args/flags/output/examples).
 */
export interface CommandHelpJSON extends Partial<CommandHelp> {
  name: string;
  summary: string;
  tier: 1 | 2 | 3;
}

/**
 * Abstract base every implemented command's help class extends. Concrete
 * subclasses only need to fill in the CommandHelp data fields - rendering
 * logic is shared here so tiers stay consistent across all commands.
 */
export abstract class BaseCommandHelp implements CommandHelp {
  abstract name: string;
  abstract summary: string;
  abstract args: ArgSpec[];
  abstract flags: FlagSpec[];
  abstract output: OutputSpec;
  abstract examples: [Example, Example, Example];
  abstract detailedSummary: string;
  /** Most commands don't need this - only override when at-least-one-of a flag group is required. */
  requiredFlagGroups: string[][] = [];
  /** Most commands don't need this - only override when a flag needs a confirmation flag alongside it. */
  confirmationGates: ConfirmationGate[] = [];

  /** Tier 1: name + summary only, as printed in the `smriti help` listing. */
  renderTier1(): string {
    return `${this.name} - ${this.summary}`;
  }

  /** Tier 2: full signature - args, flags, output contract. No examples or prose. */
  renderTier2(): string {
    const lines: string[] = [`${this.name} - ${this.summary}`, ""];

    if (this.args.length > 0) {
      lines.push("Arguments:");
      for (const a of this.args) {
        const req = a.required ? "" : " (optional)";
        const type = a.enum ? a.enum.join("|") : a.type;
        lines.push(`  ${a.name} <${type}>${req} - ${a.description}`);
      }
      lines.push("");
    }

    if (this.flags.length > 0) {
      lines.push("Flags:");
      for (const f of this.flags) {
        const def = f.default !== undefined ? ` [default: ${f.default}]` : "";
        const req = f.required ? " (required)" : "";
        const type = f.enum ? f.enum.join("|") : f.type;
        lines.push(`  ${f.flag} <${type}>${def}${req} - ${f.description}`);
      }
      lines.push("");
    }

    lines.push("Output:");
    lines.push(`  ${this.output.description}`);
    if (this.output.jsonShape) {
      lines.push(`  --json shape: ${this.output.jsonShape}`);
    }

    return lines.join("\n");
  }

  /** Tier 3: tier 2 + one selected example + the fuller prose summary. */
  renderTier3(exampleNumber: ExampleNumber): string {
    const example = this.examples[exampleNumber - 1];
    return [
      this.renderTier2(),
      "",
      `Example ${exampleNumber}:`,
      `  $ ${example.command}`,
      `  ${example.description}`,
      "",
      this.detailedSummary,
    ].join("\n");
  }

  /** Machine-readable form of whichever tier was requested. */
  toJSON(tier: 1 | 2 | 3 = 3): CommandHelpJSON {
    if (tier === 1) {
      return { name: this.name, summary: this.summary, tier: 1 };
    }
    if (tier === 2) {
      return {
        name: this.name,
        summary: this.summary,
        args: this.args,
        flags: this.flags,
        output: this.output,
        tier: 2,
      };
    }
    return {
      name: this.name,
      summary: this.summary,
      args: this.args,
      flags: this.flags,
      output: this.output,
      examples: this.examples,
      detailedSummary: this.detailedSummary,
      tier: 3,
    };
  }
}

/**
 * Data contract for a genuinely unimplemented command (e.g. init, rules
 * today). Deliberately NOT a subset of CommandHelp with optional fields -
 * a stub has no args/flags/examples to fabricate, so it isn't asked to.
 */
export interface StubCommandHelp extends CommandIdentity {
  readonly status: "stub";
  /** What's missing / when it's expected, shown in place of tier 2+. */
  detailedSummary: string;
}

/** Abstract base for a stub command's help. See {@link StubCommandHelp}. */
export abstract class BaseStubCommandHelp implements StubCommandHelp {
  abstract name: string;
  abstract summary: string;
  abstract detailedSummary: string;
  readonly status = "stub" as const;

  renderTier1(): string {
    return `${this.name} - ${this.summary} [not implemented]`;
  }

  toJSON(): { name: string; summary: string; status: "stub"; detailedSummary: string } {
    return { name: this.name, summary: this.summary, status: "stub", detailedSummary: this.detailedSummary };
  }
}
