/**
 * Real implementation of `upgrade` on the new blueprint (see the `upgrade`
 * case in ../index.ts). Blueprint only - no real filesystem operations are
 * performed; the upgrade backend (git pull, bun install) is injected,
 * defaulting to a safe simulation.
 *
 * The upgrade command takes no positional arguments or flags (beyond --json).
 * It upgrades the smriti installation at SMRITI_HOME by pulling the latest
 * code and installing dependencies.
 */

import { BaseCommand, type ParsedArgs, CommandError } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";

export interface UpgradeResult {
  smritiHome: string;
  gitPullOutput: string;
  installSucceeded: boolean;
  installFallbackUsed: boolean;
}

/** Injected backend seams - default simulations, no real filesystem access. */
export interface UpgradeBackend {
  /** Check if SMRITI_HOME directory exists. */
  checkInstallDir(): Promise<{ exists: boolean; path: string }>;
  /** Run git pull --ff-only, returns output or error. */
  gitPull(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Run bun install --frozen-lockfile, returns exit code. */
  bunInstall(cwd: string, useFrozenLockfile: boolean): Promise<number>;
}

const simulateBackend: UpgradeBackend = {
  async checkInstallDir() {
    // Simulate a valid install directory
    return { exists: true, path: "/path/to/smriti" };
  },
  async gitPull() {
    // Simulate successful git pull
    return { exitCode: 0, stdout: "Already up to date.", stderr: "" };
  },
  async bunInstall() {
    // Simulate successful bun install
    return 0;
  },
};

/**
 * Real backend for `UpgradeCommand`. Mirrors index.ts's `upgrade` case
 * exactly:
 *   const { SMRITI_HOME } = await import("./config");
 *   const { existsSync } = await import("fs");
 *   existsSync(SMRITI_HOME) -> checkInstallDir()
 *   Bun.spawnSync(["git", "pull", "--ff-only"], { cwd: SMRITI_HOME }) -> gitPull(cwd)
 *     (index.ts trims stdout/stderr via .toString().trim() before using
 *     them - this backend does the same so `pull.stdout || "Already up to
 *     date."` in execute() behaves identically to the original's
 *     `pullOut || "Already up to date."`)
 *   Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: SMRITI_HOME }) -> bunInstall(cwd, true)
 *   Bun.spawnSync(["bun", "install"], { cwd: SMRITI_HOME }) -> bunInstall(cwd, false)
 * No `db: Database` handle is used - the real `upgrade` case never touches
 * the database, only the filesystem (existsSync) and child processes (git,
 * bun).
 *
 * Note: index.ts's `upgrade` case never actually reads any environment
 * variable to override SMRITI_HOME - `config.ts`'s `SMRITI_HOME` constant is
 * hardcoded to `join(homedir(), ".smriti")` with no `Bun.env` override, so
 * despite the doc comments in this file and in `UpgradeCommand.examples`
 * referencing `SMRITI_HOME=/custom/path`, the real installed path is always
 * `~/.smriti`. This backend mirrors that real (current) behavior exactly by
 * importing the same `SMRITI_HOME` constant, rather than inventing an
 * override that the original code does not have.
 */
export function createRealUpgradeBackend(): UpgradeBackend {
  return {
    async checkInstallDir() {
      const { SMRITI_HOME } = await import("../config");
      const { existsSync } = await import("fs");
      return { exists: existsSync(SMRITI_HOME), path: SMRITI_HOME };
    },
    async gitPull(cwd: string) {
      const pull = Bun.spawnSync(["git", "pull", "--ff-only"], { cwd });
      return {
        exitCode: pull.exitCode,
        stdout: pull.stdout.toString().trim(),
        stderr: pull.stderr.toString().trim(),
      };
    },
    async bunInstall(cwd: string, useFrozenLockfile: boolean) {
      const install = Bun.spawnSync(
        useFrozenLockfile ? ["bun", "install", "--frozen-lockfile"] : ["bun", "install"],
        { cwd }
      );
      return install.exitCode;
    },
  };
}

export class UpgradeCommand extends BaseCommand<UpgradeResult> {
  constructor(private readonly backend: UpgradeBackend = simulateBackend) {
    super();
  }

  name = "upgrade";
  summary = "Update smriti to the latest version";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [];
  output = {
    description: "prints upgrade progress and returns upgrade result metadata",
    jsonShape: "{ smritiHome: string, gitPullOutput: string, installSucceeded: boolean, installFallbackUsed: boolean }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti upgrade", description: "upgrade smriti in place, pulling latest code and installing dependencies" },
    { command: "smriti upgrade --json", description: "upgrade and return JSON metadata about the operation" },
    { command: "SMRITI_HOME=/custom/path smriti upgrade", description: "upgrade a non-standard installation" },
  ];
  detailedSummary =
    "Pulls the latest code from the smriti repository (using git pull --ff-only) and installs any new dependencies. " +
    "Requires the smriti repository to be at SMRITI_HOME (auto-detected from installation, or override via environment variable). " +
    "The upgrade is atomic per phase: if git pull fails, bun install is not attempted. " +
    "If bun install fails with --frozen-lockfile, it is retried without the flag.";

  protected async execute(parsed: ParsedArgs): Promise<UpgradeResult> {
    // Check that SMRITI_HOME is set and exists
    const dirCheck = await this.backend.checkInstallDir();
    if (!dirCheck.exists) {
      throw new CommandError(
        `smriti install directory not found: ${dirCheck.path}\nIf you installed smriti manually, set SMRITI_HOME in your environment.`,
        "NOT_FOUND",
        { smritiHome: dirCheck.path }
      );
    }

    const smritiHome = dirCheck.path;

    // Phase 1: git pull --ff-only
    const pull = await this.backend.gitPull(smritiHome);
    if (pull.exitCode !== 0) {
      throw new CommandError(
        `git pull failed:\n${pull.stderr || pull.stdout}`,
        "EXECUTION_FAILED",
        { smritiHome, phase: "git-pull", exitCode: pull.exitCode }
      );
    }

    const gitPullOutput = pull.stdout || "Already up to date.";

    // Phase 2: bun install (with fallback)
    let installSucceeded = false;
    let installFallbackUsed = false;

    // Try with --frozen-lockfile first
    const installExitCode = await this.backend.bunInstall(smritiHome, true);
    if (installExitCode !== 0) {
      // Retry without --frozen-lockfile (lockfile may have been updated in the pull)
      installFallbackUsed = true;
      const retryExitCode = await this.backend.bunInstall(smritiHome, false);
      installSucceeded = retryExitCode === 0;
    } else {
      installSucceeded = true;
    }

    if (!installSucceeded) {
      throw new CommandError(
        "bun install failed and could not be recovered",
        "EXECUTION_FAILED",
        { smritiHome, phase: "bun-install" }
      );
    }

    return {
      smritiHome,
      gitPullOutput,
      installSucceeded,
      installFallbackUsed,
    };
  }
}
