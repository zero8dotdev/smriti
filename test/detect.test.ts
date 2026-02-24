/**
 * test/detect.test.ts - Language and framework detection tests
 */

import { test, expect, beforeAll } from "bun:test";
import { detectProject, detectLanguageVersion } from "../src/detect/language";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Setup
// =============================================================================

let testDir: string;

beforeAll(() => {
  testDir = join(tmpdir(), `smriti-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

// =============================================================================
// Tests
// =============================================================================

test("detects TypeScript from tsconfig.json + package.json", async () => {
  const projectDir = join(testDir, "ts-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(join(projectDir, "tsconfig.json"), '{"compilerOptions": {}}');
  writeFileSync(join(projectDir, "package.json"), '{"name": "test"}');

  const result = await detectProject(projectDir);
  expect(result.language).toBe("typescript");
  expect(result.confidence).toBeGreaterThan(0.3);
  expect(result.markers.length).toBeGreaterThan(0);
});

test("detects Python from pyproject.toml", async () => {
  const projectDir = join(testDir, "py-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "pyproject.toml"),
    '[tool.poetry]\nname = "test"\n'
  );

  const result = await detectProject(projectDir);
  expect(result.language).toBe("python");
  expect(result.confidence).toBeGreaterThan(0.1);
});

test("detects Rust from Cargo.toml", async () => {
  const projectDir = join(testDir, "rust-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "Cargo.toml"),
    '[package]\nname = "test"\nversion = "0.1.0"\n'
  );

  const result = await detectProject(projectDir);
  expect(result.language).toBe("rust");
  expect(result.confidence).toBeGreaterThan(0.2);
});

test("detects Go from go.mod", async () => {
  const projectDir = join(testDir, "go-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(join(projectDir, "go.mod"), 'module example.com/test\n\ngo 1.21\n');

  const result = await detectProject(projectDir);
  expect(result.language).toBe("go");
  expect(result.confidence).toBeGreaterThan(0.2);
});

test("detects Next.js framework", async () => {
  const projectDir = join(testDir, "nextjs-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(join(projectDir, "tsconfig.json"), "{}");
  writeFileSync(
    join(projectDir, "package.json"),
    '{"dependencies": {"next": "^14.0.0", "react": "^18.0.0"}}'
  );
  writeFileSync(join(projectDir, "next.config.js"), "module.exports = {};");

  const result = await detectProject(projectDir);
  expect(result.language).toBe("typescript");
  expect(result.framework).toBe("nextjs");
});

test("detects FastAPI framework", async () => {
  const projectDir = join(testDir, "fastapi-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "requirements.txt"),
    "fastapi==0.104.0\nuvicorn==0.24.0\n"
  );

  const result = await detectProject(projectDir);
  expect(result.language).toBe("python");
  expect(result.framework).toBe("fastapi");
});

test("detects Axum framework", async () => {
  const projectDir = join(testDir, "axum-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "Cargo.toml"),
    '[package]\nname = "test"\n\n[dependencies]\naxum = "0.7"\n'
  );

  const result = await detectProject(projectDir);
  expect(result.language).toBe("rust");
  expect(result.framework).toBe("axum");
});

test("returns null language for unknown directory", async () => {
  const projectDir = join(testDir, "unknown-project");
  mkdirSync(projectDir, { recursive: true });

  const result = await detectProject(projectDir);
  expect(result.language).toBeNull();
  expect(result.confidence).toBe(0);
});

test("detects language version from package.json", async () => {
  const projectDir = join(testDir, "version-test");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "package.json"),
    '{"engines": {"node": ">=18.0.0"}, "dependencies": {"typescript": "^5.0.0"}}'
  );

  const version = await detectLanguageVersion(projectDir, "typescript");
  expect(version).toBeTruthy();
});
