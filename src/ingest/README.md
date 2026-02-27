# Ingest Module

## Purpose

Ingest imports conversations from supported agents and stores normalized memory in the local database.

## Structure

- `index.ts`: orchestration entry point
- `parsers/*`: pure agent parsers (no DB writes)
- `session-resolver.ts`: project/session resolution + incremental state
- `store-gateway.ts`: centralized persistence for messages/meta/sidecars/costs
- `claude.ts`, `codex.ts`, `cursor.ts`, `cline.ts`, `copilot.ts`, `generic.ts`: discovery helpers + compatibility wrappers

## Design Rules

- Parsers must not write to DB.
- DB writes should go through store-gateway.
- Session/project resolution should go through session-resolver.
- Orchestrator owns control flow and aggregation.

## Adding a New Agent

1. Add parser in `parsers/<agent>.ts`.
2. Add discovery logic in `src/ingest/<agent>.ts`.
3. Wire into `ingest()` in `index.ts`.
4. Add parser + orchestrator tests.
