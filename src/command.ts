/**
 * Blueprint for a runnable command, correlated to its own help.
 *
 * Not wired into `index.ts` — shape only, no dispatch refactor.
 */

import { BaseCommandHelp, BaseStubCommandHelp, type FlagSpec } from "./help/types";

/** Input to a command's {@link BaseCommand.run}. */
export interface CommandContext {
  /** Raw positional args + flags, with the command name itself already stripped off. */
  argv: string[];
  /** Whether `--json` was passed. */
  json: boolean;
}

/**
 * `argv` split into positionals and flags, per the command's declared
 * `flags` ({@link FlagSpec}). Boolean flags need no following value; any
 * other declared type consumes the next token. Unrecognized `--foo` tokens
 * are still captured here (so {@link BaseCommand.run} can reject them) but
 * are never mistaken for positionals.
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** @returns `argv` split into positionals and flags using `flagSpecs` to know which flags take a value. */
export function parseArgv(argv: string[], flagSpecs: FlagSpec[]): ParsedArgs {
  const specsByFlag = new Map(flagSpecs.map((f) => [f.flag, f]));
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const spec = specsByFlag.get(token);
    const takesValue = spec ? spec.type !== "boolean" : false;
    if (takesValue) {
      flags[token] = argv[++i];
    } else {
      flags[token] = true;
    }
  }

  return { positionals, flags };
}

export type CommandErrorCode =
  | "MISSING_ARG"
  | "INVALID_ARG"
  | "NOT_FOUND"
  | "EXECUTION_FAILED"
  | "UNIMPLEMENTED"
  | "CONFIRMATION_REQUIRED";

/**
 * Structured command failure, returned — never thrown — from {@link BaseCommand.run}.
 * `message` is kept short and human-scannable; `detail` carries the same
 * failure as plain data (which arg/flag, etc.) so a machine consumer never
 * has to string-parse `message` to act on it. Rendered usage text
 * (`renderTier2()`) is NOT embedded here — presentation is a caller
 * concern, not part of the error's own data.
 */
export class CommandError extends Error {
  constructor(
    message: string,
    public readonly code: CommandErrorCode,
    public readonly detail?: Record<string, unknown>,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "CommandError";
  }

  /**
   * @remarks `Error.prototype.message` is non-enumerable, so a plain
   * `JSON.stringify(error)` drops it. Overridden to keep structured output complete.
   */
  toJSON(): { name: string; code: CommandErrorCode; message: string; detail?: Record<string, unknown> } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

/** Discriminated result every {@link BaseCommand.run} call resolves to. */
export type CommandResult<T = void> = { ok: true; data: T } | { ok: false; error: CommandError };

/** @returns A successful {@link CommandResult}. */
export function ok<T>(data: T): CommandResult<T> {
  return { ok: true, data };
}

/** @returns A failed {@link CommandResult}. */
export function fail(
  message: string,
  code: CommandErrorCode,
  detail?: Record<string, unknown>,
  cause?: unknown
): CommandResult<never> {
  return { ok: false, error: new CommandError(message, code, detail, cause) };
}

/**
 * Base class for a runnable command.
 *
 * @remarks Extends {@link BaseCommandHelp} so a command's `args`/`flags`
 * declaration both renders its `--help` output and drives {@link run}'s
 * validation — one source, not one copy per command.
 */
export abstract class BaseCommand<T = void> extends BaseCommandHelp {
  /**
   * Parses `ctx.argv` against `this.flags`, validates the result against
   * `this.args`/`this.flags`/`this.requiredFlagGroups`/`this.confirmationGates`,
   * then calls {@link execute}.
   * @returns Always a {@link CommandResult} — never throws.
   */
  async run(ctx: CommandContext): Promise<CommandResult<T>> {
    // --json is a cross-cutting presentation flag - ctx.json is the
    // authoritative source for it (set by the caller), not a per-command
    // FlagSpec. Stripped here so individual commands never need to redeclare
    // it just to avoid an "unknown flag" rejection; read ctx.json in
    // execute(), not parsed.flags["--json"].
    const argv = ctx.argv.filter((token) => token !== "--json");
    const parsed = parseArgv(argv, this.flags);

    const validation = this.validate(parsed);
    if (!validation.ok) return validation;

    try {
      return ok(await this.execute(parsed, ctx));
    } catch (cause) {
      // A subclass can throw a CommandError directly from execute() to signal
      // a specific business-level failure (e.g. NOT_FOUND for "no log file
      // yet") - preserved as-is. Anything else (an unexpected exception) is
      // the generic case.
      if (cause instanceof CommandError) {
        return fail(cause.message, cause.code, cause.detail, cause.cause);
      }
      return fail(cause instanceof Error ? cause.message : String(cause), "EXECUTION_FAILED", undefined, cause);
    }
  }

  /** Command-specific logic, invoked only after validation passes, on already-parsed args. */
  protected abstract execute(parsed: ParsedArgs, ctx: CommandContext): Promise<T>;

  /**
   * @returns Failure on the first violation found (unknown flag, missing
   * required positional/flag, bad enum/type value, unsatisfied
   * {@link BaseCommandHelp.requiredFlagGroups} group, or unsatisfied
   * {@link BaseCommandHelp.confirmationGates} gate) - else success.
   */
  private validate(parsed: ParsedArgs): CommandResult<void> {
    const knownFlags = new Set(this.flags.map((f) => f.flag));
    for (const flag of Object.keys(parsed.flags)) {
      if (!knownFlags.has(flag)) {
        return fail(`Unknown flag: ${flag}`, "INVALID_ARG", { unknownFlag: flag });
      }
    }

    const requiredArgs = this.args.filter(
      (a) => a.required && !(a.requiredUnless && a.requiredUnless.some((f) => f in parsed.flags))
    );
    if (parsed.positionals.length < requiredArgs.length) {
      const missing = requiredArgs[parsed.positionals.length];
      return fail(`Missing required argument: ${missing.name}`, "MISSING_ARG", { missingArg: missing.name });
    }

    for (let i = 0; i < this.args.length && i < parsed.positionals.length; i++) {
      const spec = this.args[i];
      const value = parsed.positionals[i];
      const badType = typeCheckFailure(value, spec.type, spec.enum);
      if (badType) {
        return fail(`Invalid value for ${spec.name}: ${badType}`, "INVALID_ARG", {
          arg: spec.name,
          value,
          expected: spec.enum ?? spec.type,
        });
      }
    }

    for (const f of this.flags.filter((f) => f.required)) {
      if (!(f.flag in parsed.flags)) {
        return fail(`Missing required flag: ${f.flag}`, "MISSING_ARG", { missingFlag: f.flag });
      }
    }

    for (const f of this.flags) {
      if (!(f.flag in parsed.flags) || f.type === "boolean") continue;
      const value = parsed.flags[f.flag];
      const badType = typeCheckFailure(String(value), f.type, f.enum);
      if (badType) {
        return fail(`Invalid value for ${f.flag}: ${badType}`, "INVALID_ARG", {
          flag: f.flag,
          value,
          expected: f.enum ?? f.type,
        });
      }
    }

    for (const group of this.requiredFlagGroups) {
      if (!group.some((flag) => flag in parsed.flags)) {
        return fail(`At least one of [${group.join(", ")}] is required`, "MISSING_ARG", {
          requiredFlagGroup: group,
        });
      }
    }

    for (const gate of this.confirmationGates) {
      if (gate.flag in parsed.flags && !gate.confirmFlag.some((f) => f in parsed.flags)) {
        return fail(
          `${gate.flag} requires ${gate.confirmFlag.join(" or ")} to confirm`,
          "CONFIRMATION_REQUIRED",
          { flag: gate.flag, confirmFlag: gate.confirmFlag }
        );
      }
    }

    return ok(undefined);
  }
}

/**
 * @returns A short reason string if `value` fails `type`/`enum`, else `undefined`.
 * Validates only - never converts. `ParsedArgs` values stay strings/booleans;
 * a "number"-typed value that passes this check is still the raw string.
 */
function typeCheckFailure(value: string, type: "string" | "number" | "boolean", enumValues?: string[]): string | undefined {
  if (enumValues && !enumValues.includes(value)) {
    return `must be one of ${enumValues.join("|")}, got "${value}"`;
  }
  if (type === "number" && (value.trim() === "" || Number.isNaN(Number(value)))) {
    return `must be a number, got "${value}"`;
  }
  return undefined;
}

/**
 * Base class for a genuinely unimplemented command (e.g. init, rules today).
 * No `execute()` to fill in - `run()` always resolves to an `UNIMPLEMENTED`
 * failure. Subclasses only declare `name`/`summary`/`detailedSummary`.
 */
export abstract class BaseStubCommand extends BaseStubCommandHelp {
  async run(_ctx: CommandContext): Promise<CommandResult<never>> {
    return fail(`${this.name} is not yet implemented — ${this.detailedSummary}`, "UNIMPLEMENTED", {
      command: this.name,
    });
  }
}
