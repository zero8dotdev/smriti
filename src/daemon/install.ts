/**
 * daemon/install.ts - Service-file generation and lifecycle install/uninstall.
 *
 * On macOS, generates a LaunchAgent plist at
 *   ~/Library/LaunchAgents/dev.zero8.smriti.plist
 * and registers it via launchctl, so the daemon starts at user login
 * and restarts on crash.
 *
 * On Linux, generates a systemd user unit at
 *   ~/.config/systemd/user/smriti.service
 * and registers it via systemctl --user. Same semantics: starts at
 * login, restarts on crash.
 *
 * Idempotent: re-installing produces the same files and registered
 * service. Uninstalling is the inverse — it tears down the registration
 * and removes the unit file, leaving the system in its pre-install state.
 *
 * The pure template generators (generatePlist, generateSystemdUnit) are
 * exported so they can be unit-tested without invoking launchctl/systemctl.
 * The runner abstraction (RunCmd) lets the integration paths be tested
 * with a mock command runner.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DAEMON_LOG_FILE } from "../config";

export const SMRITI_LABEL = "dev.zero8.smriti";

/** The path used to launch the daemon — typically Bun + the script path. */
export type LaunchTarget = {
  /** Executable to invoke (usually process.execPath / the bun binary). */
  exec: string;
  /** Arguments after the executable, ending with "daemon". */
  args: string[];
};

export type InstallTarget = {
  platform: "darwin" | "linux";
  /** Path to the service file the installer will write. */
  servicePath: string;
};

// Pure template generators --------------------------------------------------

export function generatePlist(opts: { launch: LaunchTarget; logFile: string }): string {
  const args = [opts.launch.exec, ...opts.launch.args];
  const programArguments = args
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SMRITI_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logFile)}</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
}

export function generateSystemdUnit(opts: { launch: LaunchTarget }): string {
  const execStart = [opts.launch.exec, ...opts.launch.args]
    .map(quoteShellArg)
    .join(" ");
  return `[Unit]
Description=Smriti daemon — cross-agent capture
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
# Keep the daemon nice — it's background indexing, not anything urgent.
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=default.target
`;
}

// Platform / target resolution ---------------------------------------------

export function resolveInstallTarget(): InstallTarget {
  const platform = process.platform;
  if (platform === "darwin") {
    return {
      platform: "darwin",
      servicePath: join(homedir(), "Library", "LaunchAgents", `${SMRITI_LABEL}.plist`),
    };
  }
  if (platform === "linux") {
    return {
      platform: "linux",
      servicePath: join(homedir(), ".config", "systemd", "user", "smriti.service"),
    };
  }
  throw new Error(
    `Unsupported platform ${platform}. Smriti daemon currently supports macOS and Linux only.`,
  );
}

/**
 * Resolve the executable + args that the service file will invoke.
 * Defaults to process.execPath (bun) + the current process.argv[1]
 * (the smriti entry point, whatever the user invoked us with) +
 * the "daemon" subcommand.
 */
export function resolveLaunchTarget(): LaunchTarget {
  const script = process.argv[1];
  if (!script) {
    throw new Error("Could not resolve script path from process.argv[1] — refusing to write a broken service file.");
  }
  return {
    exec: process.execPath,
    args: [script, "daemon"],
  };
}

// Runner abstraction -------------------------------------------------------

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunCmd = (cmd: string, args: string[]) => Promise<RunResult>;

export const defaultRunCmd: RunCmd = async (cmd, args) => {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: proc.exitCode ?? 0, stdout, stderr };
};

// Install / uninstall ------------------------------------------------------

export type InstallOptions = {
  /** Override the launch target. Useful for tests + ad-hoc deployments. */
  launch?: LaunchTarget;
  /** Override the install target. Useful for tests. */
  target?: InstallTarget;
  /** Override the log file path. */
  logFile?: string;
  /** Override the command runner. Useful for tests. */
  run?: RunCmd;
  /** Logger. */
  log?: (msg: string) => void;
  /** If true, overwrite an existing service file even if it's already there. */
  force?: boolean;
};

export type InstallResult = {
  servicePath: string;
  wrote: boolean;
  alreadyRegistered: boolean;
};

export async function installDaemon(opts: InstallOptions = {}): Promise<InstallResult> {
  const target = opts.target ?? resolveInstallTarget();
  const launch = opts.launch ?? resolveLaunchTarget();
  const logFile = opts.logFile ?? DAEMON_LOG_FILE;
  const run = opts.run ?? defaultRunCmd;
  const log = opts.log ?? ((m: string) => console.error(`[install] ${m}`));

  // Ensure parent dir exists.
  mkdirSync(dirname(target.servicePath), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });

  const content =
    target.platform === "darwin"
      ? generatePlist({ launch, logFile })
      : generateSystemdUnit({ launch });

  let wrote = false;
  if (!existsSync(target.servicePath) || opts.force) {
    writeFileSync(target.servicePath, content);
    wrote = true;
    log(`wrote ${target.servicePath}`);
  } else {
    // If the contents already match what we'd write, skip the rewrite
    // and the registration toggle. This is the "idempotent" path.
    const existing = readFileSync(target.servicePath, "utf-8");
    if (existing === content) {
      log(`service file unchanged at ${target.servicePath}`);
    } else {
      log(
        `service file at ${target.servicePath} differs from generated content; ` +
        `pass --force to overwrite. Skipping.`,
      );
      return { servicePath: target.servicePath, wrote: false, alreadyRegistered: false };
    }
  }

  // Register / reload.
  if (target.platform === "darwin") {
    // Try the modern launchctl invocation first; fall back to legacy if needed.
    const uid = process.getuid?.() ?? 0;
    const domain = `gui/${uid}`;
    const bootstrap = await run("launchctl", ["bootstrap", domain, target.servicePath]);
    if (bootstrap.code === 0) {
      log(`launchctl bootstrap ok`);
      return { servicePath: target.servicePath, wrote, alreadyRegistered: false };
    }
    // Bootstrap fails with code 17 (EEXIST) if the label is already loaded.
    // That's the "already registered" path — not an error.
    if (bootstrap.stderr.includes("already") || bootstrap.code === 17) {
      log(`launchctl bootstrap: already registered`);
      return { servicePath: target.servicePath, wrote, alreadyRegistered: true };
    }
    // Older macOS: fall back to launchctl load.
    const load = await run("launchctl", ["load", "-w", target.servicePath]);
    if (load.code === 0) {
      log(`launchctl load ok`);
      return { servicePath: target.servicePath, wrote, alreadyRegistered: false };
    }
    throw new Error(
      `launchctl registration failed: bootstrap exit=${bootstrap.code} stderr=${bootstrap.stderr.trim()}, ` +
      `load exit=${load.code} stderr=${load.stderr.trim()}`,
    );
  }

  // Linux
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr.trim()}`);
  }
  const enable = await run("systemctl", ["--user", "enable", "--now", "smriti"]);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable --now smriti failed: ${enable.stderr.trim()}`);
  }
  log(`systemctl enable --now smriti ok`);
  return { servicePath: target.servicePath, wrote, alreadyRegistered: false };
}

export type UninstallOptions = {
  target?: InstallTarget;
  run?: RunCmd;
  log?: (msg: string) => void;
};

export type UninstallResult = {
  servicePath: string;
  removedFile: boolean;
  unregistered: boolean;
};

export async function uninstallDaemon(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const target = opts.target ?? resolveInstallTarget();
  const run = opts.run ?? defaultRunCmd;
  const log = opts.log ?? ((m: string) => console.error(`[uninstall] ${m}`));

  let unregistered = false;
  if (target.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const bootout = await run("launchctl", ["bootout", `gui/${uid}/${SMRITI_LABEL}`]);
    if (bootout.code === 0) {
      unregistered = true;
      log(`launchctl bootout ok`);
    } else if (existsSync(target.servicePath)) {
      // Fall back to unload.
      const unload = await run("launchctl", ["unload", target.servicePath]);
      if (unload.code === 0) {
        unregistered = true;
        log(`launchctl unload ok`);
      } else {
        log(`launchctl unregister failed (continuing): bootout=${bootout.code} unload=${unload.code}`);
      }
    } else {
      log(`launchctl bootout exit=${bootout.code} (no service file to fall back to)`);
    }
  } else if (target.platform === "linux") {
    const disable = await run("systemctl", ["--user", "disable", "--now", "smriti"]);
    if (disable.code === 0) {
      unregistered = true;
      log(`systemctl disable --now ok`);
    } else {
      log(`systemctl disable --now failed (continuing): ${disable.stderr.trim()}`);
    }
  }

  let removedFile = false;
  if (existsSync(target.servicePath)) {
    try {
      unlinkSync(target.servicePath);
      removedFile = true;
      log(`removed ${target.servicePath}`);
    } catch (err) {
      log(`failed to remove ${target.servicePath}: ${(err as Error).message}`);
    }
  }

  // On Linux, daemon-reload to forget the unit.
  if (target.platform === "linux") {
    await run("systemctl", ["--user", "daemon-reload"]);
  }

  return { servicePath: target.servicePath, removedFile, unregistered };
}

// Helpers -------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quoteShellArg(s: string): string {
  // systemd ExecStart accepts double-quoted strings with backslash-escaping.
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
