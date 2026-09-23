/**
 * Real implementation of `daemon` on the new blueprint - the one command in
 * the actual CLI with subcommands (see `runDaemonCommand` in ../index.ts,
 * which this mirrors field-for-field). Blueprint only: nothing here is
 * wired into index.ts, and no subcommand touches the real daemon process,
 * filesystem, or LaunchAgents/systemd registration. Each backend call is
 * injected via the constructor (defaulting to a safe simulated
 * implementation) so every real/error state - including ones that would
 * require an actual running daemon to reach - can be exercised in tests.
 */

import { BaseCommand, CommandError, type ParsedArgs } from "../command";
import { BaseSubcommandCommand } from "../subcommand";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import { DAEMON_LOG_FILE } from "../config";

// No `db: Database` handle is threaded into any factory below - the real
// `daemon` dispatch in index.ts (`runDaemonCommand`) is handled *before*
// `initSmriti()` runs and never receives/opens a DB handle itself (only the
// daemon's own per-flush `ingest()` call opens one internally, deep inside
// `runDaemon()`/`defaultFlushAgent`). None of these subcommands need it.

const NO_ARGS: ArgSpec[] = [];
const NO_FLAGS: FlagSpec[] = [];
const STUB_EXAMPLES: [Example, Example, Example] = [
  { command: "smriti daemon", description: "see subclass" },
  { command: "smriti daemon", description: "see subclass" },
  { command: "smriti daemon", description: "see subclass" },
];

// =============================================================================
// install
// =============================================================================

export interface InstallResult {
  servicePath: string;
  wrote: boolean;
  alreadyRegistered: boolean;
}

/** Default backend - simulates a fresh install, no real service file touched. */
async function simulateInstall(force: boolean): Promise<InstallResult> {
  return { servicePath: "~/Library/LaunchAgents/dev.zero8.smriti.plist", wrote: true, alreadyRegistered: force };
}

export class DaemonInstallCommand extends BaseCommand<InstallResult> {
  constructor(private readonly installDaemon: (force: boolean) => Promise<InstallResult> = simulateInstall) {
    super();
  }

  name = "install";
  summary = "Register the daemon as a background service";
  args = NO_ARGS;
  flags: FlagSpec[] = [
    { flag: "--force", type: "boolean", description: "overwrite an existing service registration" },
  ];
  output: { description: string; jsonShape?: string } = {
    description: "prints the service file path and whether it was (re)written",
    jsonShape: "{ servicePath: string, wrote: boolean, alreadyRegistered: boolean }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti daemon install", description: "register the daemon, skip if already registered" },
    { command: "smriti daemon install --force", description: "overwrite an existing registration" },
    { command: "smriti daemon install --json", description: "machine-readable result" },
  ];
  detailedSummary = "Writes the platform service file (LaunchAgent on macOS) and loads it.";

  protected async execute(parsed: ParsedArgs): Promise<InstallResult> {
    return this.installDaemon(parsed.flags["--force"] === true);
  }
}

/**
 * Real backend for `DaemonInstallCommand`. Mirrors index.ts's `daemon
 * install` case exactly:
 *   const { installDaemon } = await import("./daemon/install");
 *   const result = await installDaemon({ force: hasFlag(args, "--force") });
 * `installDaemon`'s `InstallOptions.force?: boolean` is the same field this
 * wires `force` into, and `daemon/install.ts`'s own `InstallResult` type
 * (`{ servicePath, wrote, alreadyRegistered }`) is structurally identical
 * to this file's `InstallResult`.
 */
export function createRealInstallDaemonBackend(): (force: boolean) => Promise<InstallResult> {
  return async (force: boolean) => {
    const { installDaemon } = await import("../daemon/install");
    return installDaemon({ force });
  };
}

// =============================================================================
// uninstall
// =============================================================================

export interface UninstallResult {
  servicePath: string;
  removedFile: boolean;
  unregistered: boolean;
}

async function simulateUninstall(): Promise<UninstallResult> {
  return { servicePath: "~/Library/LaunchAgents/dev.zero8.smriti.plist", removedFile: true, unregistered: true };
}

export class DaemonUninstallCommand extends BaseCommand<UninstallResult> {
  constructor(private readonly uninstallDaemon: () => Promise<UninstallResult> = simulateUninstall) {
    super();
  }

  name = "uninstall";
  summary = "Remove the daemon's background-service registration";
  args = NO_ARGS;
  flags = NO_FLAGS;
  output = {
    description: "prints the service file path and whether it was removed",
    jsonShape: "{ servicePath: string, removedFile: boolean, unregistered: boolean }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti daemon uninstall", description: "deregister and remove the service file" },
    { command: "smriti daemon uninstall --json", description: "machine-readable result" },
    { command: "smriti daemon uninstall", description: "safe to re-run if already uninstalled" },
  ];
  detailedSummary = "Unloads and deletes the platform service file. Safe to call if never installed.";

  protected async execute(): Promise<UninstallResult> {
    return this.uninstallDaemon();
  }
}

/**
 * Real backend for `DaemonUninstallCommand`. Mirrors index.ts's `daemon
 * uninstall` case exactly:
 *   const { uninstallDaemon } = await import("./daemon/install");
 *   const result = await uninstallDaemon();
 * Takes no arguments (its `UninstallOptions` are all optional and index.ts
 * passes none), and `daemon/install.ts`'s `UninstallResult`
 * (`{ servicePath, removedFile, unregistered }`) is structurally identical
 * to this file's `UninstallResult`.
 */
export function createRealUninstallDaemonBackend(): () => Promise<UninstallResult> {
  return async () => {
    const { uninstallDaemon } = await import("../daemon/install");
    return uninstallDaemon();
  };
}

// =============================================================================
// status
// =============================================================================

export type StatusResult =
  | { running: false; pidFile: string }
  | { running: true; pidFile: string; pid: number; startedAt?: Date };

async function simulateStatus(): Promise<StatusResult> {
  return { running: false, pidFile: "~/.cache/smriti/daemon.pid" };
}

export class DaemonStatusCommand extends BaseCommand<StatusResult> {
  constructor(private readonly getStatus: () => Promise<StatusResult> = simulateStatus) {
    super();
  }

  name = "status";
  summary = "Show whether the daemon is running";
  args = NO_ARGS;
  flags = NO_FLAGS;
  output = {
    description: "prints running/not-running, PID, and uptime if running",
    jsonShape: "{ running: boolean, pidFile: string, pid?: number, startedAt?: string }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti daemon status", description: "human-readable status" },
    { command: "smriti daemon status --json", description: "machine-readable status" },
    { command: "smriti daemon status", description: "checks the PID file, does not require the daemon to answer" },
  ];
  detailedSummary = "Reads the PID file and probes the process - never fails, always reports a state.";

  protected async execute(): Promise<StatusResult> {
    return this.getStatus();
  }
}

/**
 * Real backend for `DaemonStatusCommand`. Mirrors index.ts's `daemon
 * status` case:
 *   const { getDaemonStatus } = await import("./daemon/client");
 *   const s = getDaemonStatus();
 *   if (!s.running) { ...uses s.pidFile... }
 *   else { ...uses s.pid, s.startedAt... }
 *
 * `daemon/client.ts`'s `getDaemonStatus()` returns a flat
 * `DaemonStatus = { running: boolean; pid: number | null; startedAt: Date |
 * null; pidFile: string }`, not this file's discriminated-union
 * `StatusResult`. The mapping below reproduces exactly the branch index.ts
 * takes on `s.running`: false -> only `{ running: false, pidFile }`; true ->
 * `{ running: true, pidFile, pid, startedAt }`, dropping `startedAt` to
 * `undefined` when null (index.ts's `if (s.startedAt)` guard has the same
 * effect - it only prints uptime when startedAt is present). `s.pid` is
 * non-null whenever `s.running` is true per `getDaemonStatus`'s own
 * implementation (it returns early with `pid: null` only on the
 * not-running paths), so the cast on that branch is safe.
 */
export function createRealDaemonStatusBackend(): () => Promise<StatusResult> {
  return async () => {
    const { getDaemonStatus } = await import("../daemon/client");
    const s = getDaemonStatus();
    if (!s.running) {
      return { running: false, pidFile: s.pidFile };
    }
    return {
      running: true,
      pidFile: s.pidFile,
      pid: s.pid as number,
      startedAt: s.startedAt ?? undefined,
    };
  };
}

// =============================================================================
// stop
// =============================================================================

export type StopOutcome =
  | { state: "not-running" }
  | { state: "stopped"; pid: number }
  | { state: "timeout"; pid: number };

async function simulateStop(): Promise<StopOutcome> {
  return { state: "not-running" };
}

export class DaemonStopCommand extends BaseCommand<{ state: "not-running" } | { state: "stopped"; pid: number }> {
  constructor(private readonly stopDaemon: () => Promise<StopOutcome> = simulateStop) {
    super();
  }

  name = "stop";
  summary = "Stop the running daemon";
  args = NO_ARGS;
  flags = NO_FLAGS;
  output = {
    description: "stops the daemon; fails if it does not exit in time",
    jsonShape: "{ state: 'not-running' | 'stopped', pid?: number }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti daemon stop", description: "graceful stop" },
    { command: "smriti daemon stop --json", description: "machine-readable result" },
    { command: "smriti daemon stop", description: "no-op, reports not-running, if nothing is running" },
  ];
  detailedSummary =
    "Sends SIGTERM and waits. If the process does not exit in time, this is a real failure " +
    "(EXECUTION_FAILED) - matches the real CLI's `process.exit(1)` on timeout - not a silent success.";

  protected async execute(): Promise<{ state: "not-running" } | { state: "stopped"; pid: number }> {
    const r = await this.stopDaemon();
    if (r.state === "timeout") {
      // A genuine runtime failure, not a validation problem - the generic
      // EXECUTION_FAILED path (BaseCommand.run()'s catch) is exactly right here.
      throw new Error(`daemon did not exit in time (PID ${r.pid}) - send SIGKILL manually or retry`);
    }
    return r;
  }
}

/**
 * Real backend for `DaemonStopCommand`. Mirrors index.ts's `daemon stop`
 * case:
 *   const { stopDaemon } = await import("./daemon/client");
 *   const r = await stopDaemon();
 * (index.ts calls it with no arguments, so `daemon/client.ts`'s optional
 * `{ timeoutMs?, pollMs? }` both fall back to their defaults, 5000ms /
 * 100ms). `daemon/client.ts`'s `StopResult` union
 * (`{ state: "stopped"; pid } | { state: "not-running" } | { state:
 * "timeout"; pid }`) is structurally identical to this file's
 * `StopOutcome`, so it is returned as-is - the timeout-to-thrown-Error
 * translation stays in `DaemonStopCommand.execute()`, unchanged, exactly as
 * in the blueprint.
 */
export function createRealDaemonStopBackend(): () => Promise<StopOutcome> {
  return async () => {
    const { stopDaemon } = await import("../daemon/client");
    return stopDaemon();
  };
}

// =============================================================================
// logs
// =============================================================================

export interface LogsResult {
  logFile: string;
  started: true;
}

async function simulateLogFileExists(): Promise<boolean> {
  return true;
}

/** Real backend would Bun.spawn(["tail", "-F", ...]) and block - fire-and-forget stub here so tests don't hang. */
function simulateStartTail(_logFile: string): void {}

export class DaemonLogsCommand extends BaseCommand<LogsResult> {
  constructor(
    private readonly logFileExists: () => Promise<boolean> = simulateLogFileExists,
    private readonly startTail: (logFile: string) => void = simulateStartTail,
    private readonly logFile = "~/.cache/smriti/daemon.log"
  ) {
    super();
  }

  name = "logs";
  summary = "Tail the daemon's log file";
  args = NO_ARGS;
  flags = NO_FLAGS;
  output = {
    description: "streams the log file (tail -F); fails if the daemon has never run",
    jsonShape: "{ logFile: string, started: true }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti daemon logs", description: "follow the log file" },
    { command: "smriti daemon logs", description: "fails with NOT_FOUND if the daemon has never run" },
    { command: "smriti daemon logs", description: "Ctrl-C to stop following" },
  ];
  detailedSummary = "Requires the daemon to have run at least once (the log file must exist).";

  protected async execute(): Promise<LogsResult> {
    if (!(await this.logFileExists())) {
      // A specific, business-level failure - thrown as a CommandError
      // directly so BaseCommand.run()'s catch preserves NOT_FOUND instead of
      // flattening it to EXECUTION_FAILED.
      throw new CommandError(`No log file at ${this.logFile}. Has the daemon ever run?`, "NOT_FOUND", {
        logFile: this.logFile,
      });
    }
    this.startTail(this.logFile);
    return { logFile: this.logFile, started: true };
  }
}

/**
 * Real backend for `DaemonLogsCommand`. Mirrors index.ts's `daemon logs`
 * case:
 *   const { DAEMON_LOG_FILE } = await import("./config");
 *   const file = Bun.file(DAEMON_LOG_FILE);
 *   if (!(await file.exists())) { ...NOT_FOUND... }
 *   const proc = Bun.spawn(["tail", "-F", DAEMON_LOG_FILE], { stdout: "inherit", stderr: "inherit" });
 *   await proc.exited;
 *
 * `DaemonLogsCommand`'s constructor takes three independent params
 * (`logFileExists`, `startTail`, `logFile`) rather than one function, so
 * this factory returns all three - pass them all in, e.g.:
 *   const real = createRealDaemonLogsBackend();
 *   new DaemonLogsCommand(real.logFileExists, real.startTail, real.logFile);
 * `logFile` is `DAEMON_LOG_FILE` from ../config (the real
 * `~/.cache/smriti/daemon.log` path with `~` actually expanded via
 * `homedir()`), not the blueprint's literal `"~/.cache/smriti/daemon.log"`
 * default - `logFileExists` checks existence of that same real path so the
 * two stay consistent with each other, matching index.ts checking and
 * tailing the same `DAEMON_LOG_FILE` constant throughout.
 *
 * CONCERN (see report): `startTail`'s interface is synchronous
 * (`(logFile: string) => void`), but the real index.ts path does
 * `await proc.exited` after spawning, blocking the CLI process until the
 * user Ctrl-Cs the tail. That await cannot be reproduced through this
 * void-returning signature - this implementation spawns the exact same
 * `tail -F` process with the exact same stdio wiring, but does not (cannot)
 * block on it the way index.ts does.
 */
export function createRealDaemonLogsBackend(): {
  logFileExists: () => Promise<boolean>;
  startTail: (logFile: string) => void;
  logFile: string;
} {
  return {
    logFileExists: async () => {
      return Bun.file(DAEMON_LOG_FILE).exists();
    },
    startTail: (logFile: string) => {
      Bun.spawn(["tail", "-F", logFile], { stdout: "inherit", stderr: "inherit" });
    },
    logFile: DAEMON_LOG_FILE,
  };
}

// =============================================================================
// daemon (parent) - foreground mode + subcommand dispatch
// =============================================================================

export interface ForegroundResult {
  mode: "foreground";
  pid: number;
  watching: string[];
}

/** Simulated pid - this never spawns a real process. */
async function simulateForeground(): Promise<ForegroundResult> {
  return { mode: "foreground", pid: 29626, watching: ["claude", "codex"] };
}

/**
 * `smriti daemon` - real, non-throwaway implementation on the new blueprint.
 * No-subcommand ("foreground") path is this class's own execute(); every
 * named subcommand is a fully independent BaseCommand instance below.
 */
export class DaemonCommand extends BaseSubcommandCommand<ForegroundResult> {
  constructor(private readonly runForeground: () => Promise<ForegroundResult> = simulateForeground) {
    super();
  }

  readonly subcommands = {
    install: new DaemonInstallCommand(),
    uninstall: new DaemonUninstallCommand(),
    status: new DaemonStatusCommand(),
    stop: new DaemonStopCommand(),
    logs: new DaemonLogsCommand(),
  };

  name = "daemon";
  summary = "Cross-agent capture daemon";
  args = NO_ARGS;
  /**
   * The real CLI has no foreground-mode flags today - this exists to
   * exercise (and prove) BaseSubcommandCommand's fallthrough: a flag-looking
   * leading token with no subcommand name still reaches this command's own
   * validate()/execute(), not a "no subcommand chosen" no-op.
   */
  flags: FlagSpec[] = [{ flag: "--verbose", type: "boolean", description: "extra foreground logging" }];
  output = { description: "runs the daemon in the foreground (blocks); see subcommands for background management" };
  examples = STUB_EXAMPLES;
  detailedSummary =
    "With no subcommand, runs in the foreground and blocks until stopped. " +
    "Subcommands (install/uninstall/status/stop/logs) manage it as a background service.";

  protected async execute(parsed: ParsedArgs): Promise<ForegroundResult> {
    const result = await this.runForeground();
    return parsed.flags["--verbose"] ? { ...result, watching: [...result.watching, "(verbose)"] } : result;
  }
}

/**
 * Real backend for `DaemonCommand`'s foreground (no-subcommand) mode.
 * Mirrors index.ts's `runDaemonCommand`'s no-`sub` branch exactly:
 *   const { runDaemon } = await import("./daemon");
 *   const daemon = await runDaemon();
 *   const watched = daemon.watchedAgents.length > 0
 *     ? daemon.watchedAgents.join(", ")
 *     : "(none — no agent log dirs found)";
 *   console.error(`[smriti] daemon started, pid=${daemon.pid}, watching=${watched}`);
 *   await new Promise<never>(() => {});
 *
 * `runDaemon()` (from ../daemon/index.ts) is called with no options, same
 * as index.ts, so every `RunDaemonOptions` field (agentRoots, flushAgent,
 * log, debounceMs, enrichOnIngest) falls back to its own default. Its
 * `RunningDaemon` return (`{ pid, watchedAgents, shutdown() }`) supplies
 * both fields this file's `ForegroundResult` needs (`pid`, `watching` <-
 * `watchedAgents`); `shutdown()` is intentionally left uncalled here,
 * exactly as index.ts never calls it either - the daemon is stopped via
 * SIGTERM/SIGINT, whose handlers already live in daemon/server.ts.
 *
 * CONCERN (see report): index.ts blocks forever after logging the start
 * line (`await new Promise<never>(() => {})`) and never actually reaches a
 * `return`, i.e. the real CLI's foreground mode never resolves with a
 * `ForegroundResult` - the daemon process's lifetime *is* the command. This
 * factory reproduces that exact blocking call (so behaviorally it matches:
 * the returned promise will not resolve while running for real), with a
 * `return` after it purely so the function still type-checks against
 * `() => Promise<ForegroundResult>`; that final line is unreachable in
 * practice, same as index.ts's own trailing `return;` after its blocking
 * promise.
 */
export function createRealDaemonForegroundBackend(): () => Promise<ForegroundResult> {
  return async () => {
    const { runDaemon } = await import("../daemon");
    const daemon = await runDaemon();
    const watched =
      daemon.watchedAgents.length > 0
        ? daemon.watchedAgents.join(", ")
        : "(none — no agent log dirs found)";
    console.error(`[smriti] daemon started, pid=${daemon.pid}, watching=${watched}`);
    await new Promise<never>(() => {});
    return { mode: "foreground", pid: daemon.pid, watching: daemon.watchedAgents };
  };
}
