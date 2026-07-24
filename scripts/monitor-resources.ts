/**
 * monitor-resources.ts - Sample RSS/CPU for Smriti-related processes
 * (daemon, ingest, any bun src/index.ts invocation) so resource usage
 * can be inspected without babysitting btop.
 *
 *   bun run monitor watch [--pattern <regex>] [--interval-ms 1000] [--out <path>]
 *   bun run monitor exec [--pattern <regex>] [--interval-ms 1000] [--out <path>] -- <command...>
 *
 * `watch` samples until Ctrl+C. `exec` runs the given command to
 * completion, sampling the whole time, then prints a peak-usage summary
 * for every matching process seen during the run (e.g. compare the
 * daemon's steady baseline against a one-off `smriti ingest claude`).
 *
 * Samples are always appended as CSV to --out (default .tmp/, gitignored)
 * so a run can be inspected after the fact.
 */
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

type Sample = {
  ts: number;
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPct: number;
  etime: string;
  command: string;
};

type ProcSummary = {
  pid: number;
  command: string;
  firstSeen: number;
  lastSeen: number;
  peakRssKb: number;
  peakCpuPct: number;
  sampleCount: number;
};

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const mode = args[0] === "exec" ? "exec" : "watch";
// Matches actual `bun ... index.ts` invocations (daemon/ingest/recall/etc),
// not just any process whose path happens to contain "smriti" (e.g. an
// editor's tsserver running out of this repo's node_modules).
const pattern = new RegExp(flag("pattern", "bun\\b.*index\\.ts"), "i");
const intervalMs = Number(flag("interval-ms", "1000"));
const outPath = flag("out", `.tmp/resource-monitor-${Date.now()}.csv`);

const dashIdx = args.indexOf("--");
const execCommand = mode === "exec" ? args.slice(dashIdx + 1) : [];
if (mode === "exec" && execCommand.length === 0) {
  console.error("exec mode requires a command after --, e.g.:");
  console.error("  bun run monitor exec -- smriti ingest claude");
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
let wroteHeader = false;

async function sampleOnce(): Promise<Sample[]> {
  const proc = Bun.spawn(["ps", "-eo", "pid,ppid,rss,pcpu,etime,args"], {
    stdout: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;

  const ts = Date.now();
  const samples: Sample[] = [];
  for (const line of text.split("\n").slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, rss, cpu, etime, command] = m;
    if (!pattern.test(command)) continue;
    if (command.includes("monitor-resources") || command.includes("ps -eo")) continue;
    samples.push({
      ts,
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      cpuPct: Number(cpu),
      etime,
      command: command.trim(),
    });
  }
  return samples;
}

function writeCsv(samples: Sample[]) {
  if (samples.length === 0) return;
  if (!wroteHeader) {
    appendFileSync(outPath, "ts,pid,ppid,rss_kb,cpu_pct,etime,command\n");
    wroteHeader = true;
  }
  const rows = samples
    .map((s) => `${s.ts},${s.pid},${s.ppid},${s.rssKb},${s.cpuPct},${s.etime},"${s.command.replace(/"/g, '""')}"`)
    .join("\n");
  appendFileSync(outPath, rows + "\n");
}

function summarize(all: Sample[]): ProcSummary[] {
  const byPid = new Map<number, ProcSummary>();
  for (const s of all) {
    const existing = byPid.get(s.pid);
    if (!existing) {
      byPid.set(s.pid, {
        pid: s.pid,
        command: s.command,
        firstSeen: s.ts,
        lastSeen: s.ts,
        peakRssKb: s.rssKb,
        peakCpuPct: s.cpuPct,
        sampleCount: 1,
      });
      continue;
    }
    existing.lastSeen = s.ts;
    existing.peakRssKb = Math.max(existing.peakRssKb, s.rssKb);
    existing.peakCpuPct = Math.max(existing.peakCpuPct, s.cpuPct);
    existing.sampleCount++;
  }
  return [...byPid.values()].sort((a, b) => b.peakRssKb - a.peakRssKb);
}

function printSummary(all: Sample[]) {
  const procs = summarize(all);
  if (procs.length === 0) {
    console.log(`\nNo processes matched /${pattern.source}/ during this run.`);
    return;
  }
  console.log(`\n${"PID".padEnd(8)}${"PEAK RSS".padEnd(12)}${"PEAK CPU".padEnd(10)}${"DURATION".padEnd(10)}COMMAND`);
  for (const p of procs) {
    const rssMb = (p.peakRssKb / 1024).toFixed(1) + " MB";
    const durationS = ((p.lastSeen - p.firstSeen) / 1000).toFixed(1) + "s";
    console.log(
      `${String(p.pid).padEnd(8)}${rssMb.padEnd(12)}${(p.peakCpuPct.toFixed(1) + "%").padEnd(10)}${durationS.padEnd(10)}${p.command.slice(0, 80)}`
    );
  }
  console.log(`\nRaw samples: ${outPath}`);
}

async function main() {
  const allSamples: Sample[] = [];
  let stopped = false;

  const loop = (async () => {
    while (!stopped) {
      const samples = await sampleOnce();
      allSamples.push(...samples);
      writeCsv(samples);
      await Bun.sleep(intervalMs);
    }
  })();

  if (mode === "watch") {
    console.log(`Watching /${pattern.source}/ every ${intervalMs}ms — Ctrl+C to stop and print summary.`);
    process.on("SIGINT", () => {
      stopped = true;
      printSummary(allSamples);
      process.exit(0);
    });
    await loop;
  } else {
    console.log(`Sampling /${pattern.source}/ every ${intervalMs}ms while running: ${execCommand.join(" ")}`);
    const child = Bun.spawn(execCommand, { stdout: "inherit", stderr: "inherit" });
    const exitCode = await child.exited;
    stopped = true;
    await loop;
    printSummary(allSamples);
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
