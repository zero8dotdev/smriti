#!/usr/bin/env bun

import { execSync } from "node:child_process";

type Commit = {
  sha: string;
  subject: string;
  body: string;
  type: string;
  scope: string | null;
  breaking: boolean;
};

type Bump = "none" | "patch" | "minor" | "major";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function isStableTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

function parseSemver(tag: string): [number, number, number] {
  const m = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fmtSemver(v: [number, number, number]): string {
  return `v${v[0]}.${v[1]}.${v[2]}`;
}

function bump(base: [number, number, number], level: Bump): [number, number, number] {
  const [maj, min, pat] = base;
  if (level === "major") return [maj + 1, 0, 0];
  if (level === "minor") return [maj, min + 1, 0];
  if (level === "patch") return [maj, min, pat + 1];
  return [maj, min, pat];
}

function maxBump(a: Bump, b: Bump): Bump {
  const order: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };
  return order[a] >= order[b] ? a : b;
}

function getLatestStableTag(exclude?: string): string | null {
  const tags = run("git tag --list")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter(isStableTag)
    .filter((t) => !exclude || t !== exclude);
  if (tags.length === 0) return null;
  tags.sort((a, b) => {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (pa[0] !== pb[0]) return pa[0] - pb[0];
    if (pa[1] !== pb[1]) return pa[1] - pb[1];
    return pa[2] - pb[2];
  });
  return tags[tags.length - 1] || null;
}

function parseCommit(raw: string): Commit | null {
  const parts = raw.split("\t");
  if (parts.length < 3) return null;
  const sha = parts[0] || "";
  const subject = parts[1] || "";
  const body = parts.slice(2).join("\t");
  const m = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/);
  if (!m) {
    return {
      sha,
      subject,
      body,
      type: "invalid",
      scope: null,
      breaking: false,
    };
  }
  const type = m[1] || "invalid";
  const scope = m[2] || null;
  const breaking = Boolean(m[3]) || /BREAKING CHANGE:/i.test(body);
  return { sha, subject, body, type, scope, breaking };
}

function bumpForCommit(c: Commit): Bump {
  if (c.breaking) return "major";
  if (c.type === "feat") return "minor";
  if (c.type === "fix" || c.type === "perf" || c.type === "refactor" || c.type === "revert") return "patch";
  return "none";
}

function isConventional(c: Commit): boolean {
  if (c.type === "invalid") return false;
  const allowed = new Set([
    "feat",
    "fix",
    "perf",
    "refactor",
    "docs",
    "chore",
    "ci",
    "test",
    "build",
    "revert",
    "release",
  ]);
  return allowed.has(c.type);
}

function getCommits(rangeFrom: string | null, rangeTo: string): Commit[] {
  const range = rangeFrom ? `${rangeFrom}..${rangeTo}` : rangeTo;
  const raw = run(`git log --no-merges --pretty=format:%H%x09%s%x09%b ${range}`);
  if (!raw) return [];
  return raw
    .split("\n")
    .map(parseCommit)
    .filter((c): c is Commit => Boolean(c));
}

function buildNotes(commits: Commit[]): string {
  const valid = commits.filter(isConventional);
  if (valid.length === 0) return "### Changed\n\n- No user-facing conventional commits in this range.\n";

  const groups: Record<string, string[]> = {
    major: [],
    feat: [],
    fix: [],
    perf: [],
    refactor: [],
    docs: [],
    chore: [],
    ci: [],
    test: [],
    build: [],
    revert: [],
    release: [],
  };

  for (const c of valid) {
    const line = `- ${c.subject} (${c.sha.slice(0, 7)})`;
    if (c.breaking) groups.major.push(line);
    (groups[c.type] || groups.chore).push(line);
  }

  const sections: string[] = [];
  if (groups.major.length) sections.push(`### Breaking\n\n${groups.major.join("\n")}`);
  if (groups.feat.length) sections.push(`### Added\n\n${groups.feat.join("\n")}`);
  if (groups.fix.length || groups.perf.length || groups.refactor.length || groups.revert.length) {
    sections.push(
      `### Changed\n\n${[...groups.fix, ...groups.perf, ...groups.refactor, ...groups.revert].join("\n")}`
    );
  }
  if (groups.docs.length) sections.push(`### Documentation\n\n${groups.docs.join("\n")}`);
  const ops = [...groups.chore, ...groups.ci, ...groups.test, ...groups.build, ...groups.release];
  if (ops.length) sections.push(`### Maintenance\n\n${ops.join("\n")}`);
  return `${sections.join("\n\n")}\n`;
}

function main() {
  const mode = arg("--mode") || "metadata";
  const toRef = arg("--to") || "HEAD";
  const fromRefArg = arg("--from-ref");
  const fromTagArg = arg("--from-tag");
  const currentTag = arg("--current-tag");
  const githubOutput = arg("--github-output");

  const fromTag = fromTagArg || getLatestStableTag(currentTag || undefined);
  const rangeFrom = fromRefArg || fromTag;
  const commits = getCommits(rangeFrom || null, toRef);
  const invalid = commits.filter((c) => !isConventional(c));

  if (mode === "lint") {
    if (invalid.length > 0) {
      console.error("Non-conventional commits detected:");
      for (const c of invalid) {
        console.error(`- ${c.sha.slice(0, 7)} ${c.subject}`);
      }
      process.exit(1);
    }
    console.log("All commits follow conventional commit rules.");
    return;
  }

  let required: Bump = "none";
  for (const c of commits) required = maxBump(required, bumpForCommit(c));

  const baseVersion = fromTag ? parseSemver(fromTag) : ([0, 1, 0] as [number, number, number]);
  const nextVersion = fmtSemver(bump(baseVersion, required));
  const notes = buildNotes(commits);

  const out = {
    from_tag: fromTag,
    from_ref: rangeFrom || null,
    to_ref: toRef,
    commit_count: commits.length,
    invalid_count: invalid.length,
    bump: required,
    next_version: nextVersion,
    release_notes: notes,
  };

  if (githubOutput) {
    const lines = [
      `from_tag=${out.from_tag || ""}`,
      `commit_count=${out.commit_count}`,
      `invalid_count=${out.invalid_count}`,
      `bump=${out.bump}`,
      `next_version=${out.next_version}`,
      "release_notes<<EOF",
      out.release_notes,
      "EOF",
    ];
    Bun.write(githubOutput, `${lines.join("\n")}\n`);
  }

  if (invalid.length > 0) {
    console.error("Non-conventional commits detected:");
    for (const c of invalid) {
      console.error(`- ${c.sha.slice(0, 7)} ${c.subject}`);
    }
    process.exit(1);
  }

  console.log(JSON.stringify(out, null, 2));
}

main();
