# Ingest Architecture

Smriti ingest now follows a layered architecture with explicit boundaries.

## Layers

1. Parser Layer (`src/ingest/parsers/*`)
- Agent-specific extraction only.
- Reads source transcripts and returns normalized parsed sessions/messages.
- No database writes.

2. Session Resolver (`src/ingest/session-resolver.ts`)
- Resolves `projectId`/`projectPath` from agent + path.
- Handles explicit project overrides.
- Computes `isNew` and `existingMessageCount` for incremental ingest.

3. Store Gateway (`src/ingest/store-gateway.ts`)
- Central write path for persistence.
- Stores messages, sidecar blocks, session meta, and costs.
- Encapsulates database write behavior.

4. Orchestrator (`src/ingest/index.ts`)
- Composes parser -> resolver -> gateway.
- Handles result aggregation, per-session error handling, progress reporting.
- Controls incremental behavior (Claude append-only transcripts).

## Why this structure

- Testability: each layer can be tested independently.
- Maintainability: persistence logic is centralized.
- Extensibility: new agents mostly require parser/discovery only.
- Reliability: incremental and project resolution behavior are explicit.

## Current behavior

- `claude`/`claude-code`: incremental ingest based on existing message count.
- `codex`, `cursor`, `cline`, `copilot`, `generic/file`: orchestrated through the same pipeline.
- Legacy `ingest*` functions in agent modules remain as compatibility wrappers and delegate to orchestrator.

## Verification

Architecture is covered by focused tests:
- `test/ingest-parsers.test.ts`
- `test/session-resolver.test.ts`
- `test/store-gateway.test.ts`
- `test/ingest-orchestrator.test.ts`
- `test/ingest-claude-orchestrator.test.ts`
- `test/ingest-pipeline.test.ts`
