/**
 * test/daemon-install.test.ts
 *
 * Unit tests for the service-file installer. Tests the pure template
 * generators against fixtures, and tests the install/uninstall flow
 * against a mock RunCmd and a temp directory for the service path —
 * so we don't actually register anything with the real launchctl /
 * systemctl during CI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  SMRITI_LABEL,
  generatePlist,
  generateSystemdUnit,
  installDaemon,
  uninstallDaemon,
  type InstallTarget,
  type RunCmd,
  type RunResult,
} from "../src/daemon/install";

// Helpers ------------------------------------------------------------

let tmpHome: string;
let darwinTarget: InstallTarget;
let linuxTarget: InstallTarget;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "smriti-install-test-"));
  darwinTarget = {
    platform: "darwin",
    servicePath: join(tmpHome, "LaunchAgents", `${SMRITI_LABEL}.plist`),
  };
  linuxTarget = {
    platform: "linux",
    servicePath: join(tmpHome, "systemd", "user", "smriti.service"),
  };
});

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function recordingRunner(): { calls: { cmd: string; args: string[] }[]; run: RunCmd; nextResult: (r: RunResult) => void } {
  const calls: { cmd: string; args: string[] }[] = [];
  let queued: RunResult[] = [];
  const run: RunCmd = async (cmd, args) => {
    calls.push({ cmd, args });
    return queued.shift() ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run, nextResult: (r) => queued.push(r) };
}

const LAUNCH = { exec: "/usr/local/bin/bun", args: ["/path/to/smriti.js", "daemon"] };

// Template generators ------------------------------------------------

describe("generatePlist", () => {
  test("emits a valid plist structure with the smriti label", () => {
    const plist = generatePlist({ launch: LAUNCH, logFile: "/tmp/daemon.log" });
    expect(plist).toContain(`<string>${SMRITI_LABEL}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/usr/local/bin/bun</string>");
    expect(plist).toContain("<string>/path/to/smriti.js</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>/tmp/daemon.log</string>");
  });

  test("escapes XML-special characters in paths", () => {
    const plist = generatePlist({
      launch: { exec: "/path/with<gt>&amp;\"quote", args: ["x"] },
      logFile: "/tmp/x",
    });
    expect(plist).toContain("&lt;gt&gt;&amp;amp;&quot;quote");
    expect(plist).not.toMatch(/<\/string><[^/]/); // no broken XML
  });
});

describe("generateSystemdUnit", () => {
  test("emits an ExecStart line with the launch target", () => {
    const unit = generateSystemdUnit({ launch: LAUNCH });
    expect(unit).toContain("Description=Smriti daemon — cross-agent capture");
    expect(unit).toContain("ExecStart=/usr/local/bin/bun /path/to/smriti.js daemon");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("quotes ExecStart args that need escaping", () => {
    const unit = generateSystemdUnit({
      launch: { exec: "/usr/local/bin/bun", args: ["/path with spaces/main.js", "daemon"] },
    });
    expect(unit).toContain('ExecStart=/usr/local/bin/bun "/path with spaces/main.js" daemon');
  });
});

// installDaemon ------------------------------------------------------

describe("installDaemon (macOS)", () => {
  test("writes plist and invokes launchctl bootstrap", async () => {
    const r = recordingRunner();
    const result = await installDaemon({
      target: darwinTarget,
      launch: LAUNCH,
      logFile: "/tmp/test.log",
      run: r.run,
      log: () => {},
    });

    expect(result.wrote).toBe(true);
    expect(existsSync(darwinTarget.servicePath)).toBe(true);
    expect(readFileSync(darwinTarget.servicePath, "utf-8")).toContain(SMRITI_LABEL);

    expect(r.calls[0].cmd).toBe("launchctl");
    expect(r.calls[0].args[0]).toBe("bootstrap");
    expect(r.calls[0].args[2]).toBe(darwinTarget.servicePath);
  });

  test("treats already-loaded label as success, not error", async () => {
    const r = recordingRunner();
    r.nextResult({ code: 17, stdout: "", stderr: "Bootstrap failed: 17: already loaded" });

    const result = await installDaemon({
      target: darwinTarget,
      launch: LAUNCH,
      run: r.run,
      log: () => {},
    });

    expect(result.alreadyRegistered).toBe(true);
  });

  test("falls back to launchctl load when bootstrap fails with a non-EEXIST code", async () => {
    const r = recordingRunner();
    r.nextResult({ code: 1, stdout: "", stderr: "Bootstrap failed: some other reason" });
    r.nextResult({ code: 0, stdout: "", stderr: "" });

    await installDaemon({
      target: darwinTarget,
      launch: LAUNCH,
      run: r.run,
      log: () => {},
    });

    expect(r.calls[0].args[0]).toBe("bootstrap");
    expect(r.calls[1].cmd).toBe("launchctl");
    expect(r.calls[1].args[0]).toBe("load");
  });

  test("idempotent: re-install with matching content skips rewrite", async () => {
    const r1 = recordingRunner();
    await installDaemon({ target: darwinTarget, launch: LAUNCH, run: r1.run, log: () => {} });

    const r2 = recordingRunner();
    const result = await installDaemon({ target: darwinTarget, launch: LAUNCH, run: r2.run, log: () => {} });

    // File content matches, so it's not rewritten — but launchctl is still
    // called (registration is the cheap idempotent operation).
    expect(result.wrote).toBe(false);
    expect(r2.calls.length).toBeGreaterThan(0);
  });
});

describe("installDaemon (Linux)", () => {
  test("writes service file and runs daemon-reload + enable --now", async () => {
    const r = recordingRunner();
    const result = await installDaemon({
      target: linuxTarget,
      launch: LAUNCH,
      run: r.run,
      log: () => {},
    });

    expect(result.wrote).toBe(true);
    expect(existsSync(linuxTarget.servicePath)).toBe(true);
    expect(readFileSync(linuxTarget.servicePath, "utf-8")).toContain("ExecStart=");

    expect(r.calls[0]).toEqual({ cmd: "systemctl", args: ["--user", "daemon-reload"] });
    expect(r.calls[1]).toEqual({ cmd: "systemctl", args: ["--user", "enable", "--now", "smriti"] });
  });

  test("throws when systemctl daemon-reload fails", async () => {
    const r = recordingRunner();
    r.nextResult({ code: 1, stdout: "", stderr: "no systemd" });

    await expect(
      installDaemon({ target: linuxTarget, launch: LAUNCH, run: r.run, log: () => {} }),
    ).rejects.toThrow(/daemon-reload failed/);
  });
});

// uninstallDaemon ----------------------------------------------------

describe("uninstallDaemon (macOS)", () => {
  test("removes plist and calls launchctl bootout", async () => {
    // Pre-seed the service file
    mkdirSync(dirname(darwinTarget.servicePath), { recursive: true });
    writeFileSync(darwinTarget.servicePath, "<plist/>", { flag: "w" });

    const r = recordingRunner();
    const result = await uninstallDaemon({ target: darwinTarget, run: r.run, log: () => {} });

    expect(result.unregistered).toBe(true);
    expect(result.removedFile).toBe(true);
    expect(existsSync(darwinTarget.servicePath)).toBe(false);

    expect(r.calls[0].cmd).toBe("launchctl");
    expect(r.calls[0].args[0]).toBe("bootout");
  });
});

describe("uninstallDaemon (Linux)", () => {
  test("calls systemctl disable --now and removes service file", async () => {
    mkdirSync(dirname(linuxTarget.servicePath), { recursive: true });
    writeFileSync(linuxTarget.servicePath, "[Unit]\n", { flag: "w" });

    const r = recordingRunner();
    const result = await uninstallDaemon({ target: linuxTarget, run: r.run, log: () => {} });

    expect(result.unregistered).toBe(true);
    expect(result.removedFile).toBe(true);
    expect(r.calls[0]).toEqual({ cmd: "systemctl", args: ["--user", "disable", "--now", "smriti"] });
    // daemon-reload after removal
    expect(r.calls.some((c) => c.args.join(" ") === "--user daemon-reload")).toBe(true);
  });

  test("succeeds even when no service file exists", async () => {
    const r = recordingRunner();
    const result = await uninstallDaemon({ target: linuxTarget, run: r.run, log: () => {} });
    expect(result.removedFile).toBe(false);
    // systemctl disable is still attempted (it's idempotent and cheap)
    expect(r.calls.length).toBeGreaterThan(0);
  });
});
