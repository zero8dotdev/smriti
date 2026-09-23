/**
 * subcommand.ts - Extends the flat CommandHelp/BaseCommand model to commands
 * that dispatch to named subcommands instead of running directly.
 *
 * The one real example in the CLI today is `daemon` (see
 * `runDaemonCommand` in index.ts): `install` (takes `--force`),
 * `uninstall`, `status`, `stop`, `logs` - and no subcommand at all, which
 * means "run in foreground" (a distinct mode, not an error).
 *
 * Design summary
 * --------------
 * A command with subcommands is NOT a flat `BaseCommand` with a
 * `subcommands` field bolted on. Each subcommand (`install`, `uninstall`,
 * ...) is itself a full, independent `BaseCommand` - same class, same
 * tiered help, same validate()/execute() split as every other command in
 * the CLI. `BaseSubcommandCommand` (below) is a thin dispatcher that:
 *
 *   1. Owns a `subcommands` map of name -> BaseCommand instance. That map
 *      IS the source of truth - a subcommand's args/flags/execute() are
 *      declared exactly once, on its own instance, and both its help
 *      (`renderTier2()`, `toJSON()`) and its validation come from that one
 *      declaration. `install`'s `--force` lives on `install`'s own `flags`
 *      array; it is never duplicated onto - or visible from - `daemon`'s.
 *
 *   2. Overrides `run()`, not `execute()`. `execute()` (from BaseCommand)
 *      can only return a bare `T`; it has no way to hand back a subcommand's
 *      *own* `CommandResult<T>` (which might be `ok:false`) without either
 *      re-wrapping it in a try/catch that mislabels validation failures as
 *      `EXECUTION_FAILED`, or unwrapping/rethrowing it. Overriding `run()`
 *      lets a matched subcommand's `run()` be returned verbatim - its own
 *      validate() + execute() + error handling, completely reused, not
 *      reimplemented.
 *
 *   3. Still declares its own `args`/`flags`/`output`/`examples` (the
 *      `BaseCommandHelp` contract). Those describe *only* the no-subcommand
 *      ("foreground") path. When no subcommand token is present, `run()`
 *      falls through to `super.run()` - the exact same validate()+execute()
 *      flow every flat command already uses. Foreground mode is therefore
 *      not a special case wedged into the dispatch branch; it's the
 *      ordinary flat-command path, just reached conditionally.
 *
 * Why not add `subcommands` directly onto `BaseCommand`?
 *   - It would force every flat command (~30 of the 31) to carry a field
 *     they never use, and it would make `BaseCommand.run()` branch between
 *     two unrelated execution models (flat vs. dispatch) instead of doing
 *     one thing.
 *   - `command.ts` has argv-parsing/required-flag-validation changes in
 *     flight elsewhere right now. Adding the capability via subclassing in
 *     a new file means zero edits to `command.ts` - no merge collision, and
 *     the flat model it defines is provably untouched (this file only
 *     imports from it).
 *   - Composition over a shared field also makes the invariant checkable by
 *     the type system: a flat command's type has no `subcommands` property
 *     at all, rather than an optional field that's `undefined` by
 *     convention on 30 of 31 commands.
 *
 * Help routing (not built here - see the note on `renderSubcommandList`)
 * ------------------------------------------------------------------
 * Neither this file nor command.ts implements `--help` interception for
 * flat commands either - `BaseCommand.run()` has no knowledge of `--help`
 * at all. That's a CLI-dispatch concern, layered on top, exactly like
 * index.ts's existing top-level convention: `smriti help` / `smriti --help`
 * are intercepted *before* any command's `run()` is ever called (index.ts,
 * `if (!command || command === "help" || command === "--help")`, checked
 * ahead of the command switch). This file follows that same convention one
 * level down: `smriti daemon help` / `smriti daemon --help` are meant to be
 * intercepted by that same (future) help-routing layer, which calls
 * `renderSubcommandList()` directly - `run()` is never invoked for a "help"
 * token, so it doesn't need to know the word "help" exists. Likewise
 * `smriti daemon install --help` resolves via `getSubcommand("install")!.
 * renderTier2()` - the subcommand's *own* tiered help, unmodified.
 */

import { BaseCommand, CommandError, type CommandContext, type CommandResult, type ParsedArgs, fail } from "./command";
import type { CommandHelpJSON } from "./help/types";

/** One subcommand's identity line, as surfaced in the parent's subcommand listing. */
export interface SubcommandListEntry {
  name: string;
  summary: string;
}

/** {@link CommandHelpJSON}, widened with the subcommand listing for tier 1. */
export interface SubcommandHelpJSON extends CommandHelpJSON {
  subcommands: SubcommandListEntry[];
}

/**
 * Base class for a command that dispatches to named subcommands, with a
 * distinct no-subcommand ("foreground") mode.
 *
 * @typeParam T - Result type of the *no-subcommand* path only (what
 * `execute()` returns). A matched subcommand's result type is opaque to the
 * parent by design (`unknown`) - each subcommand is a `BaseCommand<Sub>`
 * with its own precise type, in code that references that subcommand
 * directly (e.g. a `--help` router keyed by name, or a test). Modeling the
 * parent's result as a union/mapped type over every subcommand's `T` would
 * require the caller to already know which branch ran just to read the
 * type back, which is no safer in practice than reading `ok`/`error` off
 * the `CommandResult` at the call site, so it isn't attempted here.
 *
 * @remarks Extends {@link BaseCommand} so instances still satisfy every
 * existing `BaseCommand`/`BaseCommandHelp` consumer unmodified - e.g. a loop
 * over all top-level commands calling `renderTier1()` for `smriti help`
 * sees `daemon` exactly like any flat command: one identity line, no
 * special-casing required by the caller.
 */
export abstract class BaseSubcommandCommand<T = void> extends BaseCommand<T> {
  /**
   * Name -> subcommand instance. Each entry is a complete, independent
   * `BaseCommand` - this map is the one source of truth for which
   * subcommands exist, what each one's args/flags/help are, and how each
   * one validates and executes.
   */
  abstract readonly subcommands: Readonly<Record<string, BaseCommand<unknown>>>;

  /**
   * Default `false`: an unrecognized non-flag token (e.g. `daemon bogus`)
   * fails with `NOT_FOUND`, matching `daemon`'s real CLI behavior (a hard
   * `console.error` + exit). Two independent real commands - `categories`
   * and `insights` - turned out to need the opposite: their real dispatch
   * is a plain if/else-if chain whose final `else` is reached by ANY
   * unmatched token, typos included, and silently runs the default mode
   * (e.g. `insights bogus-typo` shows the dashboard, it does not error).
   * Set `true` on a subclass to opt into that lenient behavior instead of
   * diverging from real behavior or hand-rolling dispatch per-command.
   */
  protected readonly unmatchedSubcommandFallsThrough: boolean = false;

  /**
   * Default no-subcommand behavior: fail, listing the valid subcommands.
   * Not every subcommand-bearing command has a real default mode - `daemon`
   * does (foreground), `config` doesn't (bare `config` should tell the user
   * to pick `show`/`add-category`/etc, not silently do something). A
   * subclass with a real default overrides this concrete method with its
   * own logic (see DaemonCommand.execute()); a subclass without one simply
   * doesn't override it and gets correct behavior for free - no fake
   * "foreground mode" body forced on it just to satisfy the type system.
   */
  protected async execute(_parsed: ParsedArgs, _ctx: CommandContext): Promise<T> {
    throw new CommandError(`${this.name} requires a subcommand: ${this.subcommandNames().join(", ")}`, "MISSING_ARG", {
      requiredOneOf: this.subcommandNames(),
    });
  }

  /**
   * Dispatches to a subcommand, or falls through to the inherited
   * flat-command flow (this command's own `args`/`flags`/`execute()`) when
   * no subcommand token is present.
   *
   * A token is treated as "no subcommand chosen" if it's absent or looks
   * like a flag (starts with `--`) rather than a subcommand name - so
   * `smriti daemon` and a hypothetical `smriti daemon --verbose` both reach
   * the foreground path, while `smriti daemon install` dispatches. This
   * matches the real `daemon` command today (bare `daemon` -> foreground)
   * and generalizes correctly for any future subcommand-bearing command
   * that also accepts its own top-level flags.
   *
   * @returns Always a {@link CommandResult} - never throws, same contract
   * as {@link BaseCommand.run}.
   */
  override async run(ctx: CommandContext): Promise<CommandResult<T>> {
    const first = ctx.argv[0];
    const looksLikeSubcommand = first !== undefined && !first.startsWith("--");

    if (looksLikeSubcommand) {
      const sub = this.subcommands[first];
      if (sub) {
        const rest = ctx.argv.slice(1);
        // Cast is safe in practice (subName resolves to `sub`'s own genuine
        // CommandResult) but not expressible to the type system without a
        // mapped type keyed by subcommand name - see the class-level
        // @typeParam note on why that tradeoff is accepted.
        return sub.run({ argv: rest, json: ctx.json }) as Promise<CommandResult<T>>;
      }
      if (!this.unmatchedSubcommandFallsThrough) {
        return fail(
          `Unknown ${this.name} subcommand: '${first}'\n\n${this.renderSubcommandList()}`,
          "NOT_FOUND"
        );
      }
      // unmatchedSubcommandFallsThrough is true: fall through to the
      // no-subcommand path below, matching real commands (categories,
      // insights) whose dispatch treats any unmatched token as default mode.
    }

    // No subcommand chosen (absent, flag-like, or an unmatched token on a
    // lenient command). Not an error, not a special case: the ordinary
    // BaseCommand flow (validate() against *this* command's own
    // args/flags, then execute()) applies, same as any flat command.
    return super.run(ctx);
  }

  /**
   * Looks up a subcommand by name - e.g. for a future `--help` router to
   * call `getSubcommand("install")!.renderTier2()` for
   * `smriti daemon install --help`.
   */
  getSubcommand(name: string): BaseCommand<unknown> | undefined {
    return this.subcommands[name];
  }

  /** All registered subcommand names, in declaration order. */
  subcommandNames(): string[] {
    return Object.keys(this.subcommands);
  }

  /**
   * Tier-1-equivalent for a subcommand family: this command's own identity
   * line, one identity line per subcommand (each subcommand's own
   * `renderTier1()` - reused, not reformatted by hand), and the
   * no-subcommand mode. What `smriti daemon help` (or `smriti daemon
   * --help` with no further subcommand named) is meant to print.
   *
   * @remarks Deliberately NOT an override of `renderTier1()`. The global
   * `smriti help` listing loops over every top-level command calling
   * `renderTier1()` uniformly and must keep seeing exactly one line per
   * command there, `daemon` included - overriding `renderTier1()` here
   * would silently multiply that listing's line count for one command only,
   * a divergence the loop's author would have no reason to expect. This is
   * a second, explicit view for when the caller already knows it's scoped
   * inside a subcommand-bearing command.
   */
  renderSubcommandList(): string {
    const lines = [this.renderTier1(), "", "Subcommands:"];
    for (const sub of Object.values(this.subcommands)) {
      lines.push(`  ${sub.renderTier1()}`);
    }
    lines.push("");
    lines.push(`  (no subcommand) - ${this.summary}`);
    return lines.join("\n");
  }

  /** Machine-readable form of {@link renderSubcommandList} - symmetric with the text output. */
  toSubcommandListJSON(): SubcommandHelpJSON {
    return {
      ...this.toJSON(1),
      subcommands: Object.entries(this.subcommands).map(([name, sub]) => ({
        name,
        summary: sub.summary,
      })),
    };
  }
}
