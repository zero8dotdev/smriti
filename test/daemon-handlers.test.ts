/**
 * test/daemon-handlers.test.ts
 *
 * Unit tests for the FS-event → agent routing helpers.
 */

import { describe, expect, test } from "bun:test";
import { sep } from "node:path";

import { resolveAgentForPath, type AgentRoot } from "../src/daemon/handlers";

const roots: AgentRoot[] = [
  { agent: "claude", root: `${sep}home${sep}user${sep}.claude${sep}projects` },
  { agent: "codex", root: `${sep}home${sep}user${sep}.codex` },
  { agent: "cline", root: `${sep}home${sep}user${sep}.cline${sep}tasks` },
];

describe("resolveAgentForPath", () => {
  test("returns the agent when path is exactly the root", () => {
    expect(resolveAgentForPath(roots[0].root, roots)).toBe("claude");
  });

  test("returns the agent when path is under the root", () => {
    expect(
      resolveAgentForPath(`${roots[0].root}${sep}proj-a${sep}sess.jsonl`, roots),
    ).toBe("claude");
  });

  test("returns null for paths outside any root", () => {
    expect(resolveAgentForPath(`${sep}tmp${sep}other.jsonl`, roots)).toBeNull();
  });

  test("does not match by prefix-substring (e.g. .claude/projects-archive)", () => {
    // A common bug shape: ".claude/projects" naively matching ".claude/projects-archive"
    const sibling = `${sep}home${sep}user${sep}.claude${sep}projects-archive${sep}old.jsonl`;
    expect(resolveAgentForPath(sibling, roots)).toBeNull();
  });

  test("dispatches the right agent across multiple watched roots", () => {
    expect(
      resolveAgentForPath(`${roots[1].root}${sep}sessions${sep}s.jsonl`, roots),
    ).toBe("codex");
    expect(
      resolveAgentForPath(`${roots[2].root}${sep}task-1${sep}messages.json`, roots),
    ).toBe("cline");
  });

  test("ignores roots whose root string is empty (unconfigured agents)", () => {
    const withEmpty: AgentRoot[] = [
      { agent: "copilot", root: "" },
      ...roots,
    ];
    // Empty root must not match anything.
    expect(resolveAgentForPath(roots[0].root, withEmpty)).toBe("claude");
    expect(resolveAgentForPath("", withEmpty)).toBeNull();
  });
});
