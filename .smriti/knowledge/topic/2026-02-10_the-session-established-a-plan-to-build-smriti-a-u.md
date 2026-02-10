---
id: bc0a47ce-db71-4cf0-87bc-ea467c9f6ce0
category: topic
project: smriti
agent: claude-code
author: zero8
shared_at: 2026-02-10T11:32:09.484Z
tags: ["topic", "topic/explanation"]
---

# The session established a plan to build **smriti**, a unified memory system f...

> The session established a plan to build **smriti**, a unified memory system for managing conversations between users and AI agents across projects. It leverages QMD's existing memory infrastructure while adding multi-agent ingestion, schema-based categorization, and Git-based team knowledge sharing. This ensures isolated project contexts while enabling team-wide knowledge accumulation.  

---

## Changes

- Created `smriti/schema.sql` for multi-agent metadata tracking (agent_id, project_id, category)  
- Added `smriti/parsers/` directory with Claude Code, Codex, Cursor-specific ingestion logic  
- Implemented `smrit,cli/commands.ts` with 13 CLI commands (e.g., `smriti ingest`, `smriti sync`)  
- Developed `smriti/templates/` for markdown export templates with frontmatter metadata  
- Updated `qmd/memory.ts` to include smriti schema joins (no schema changes to QMD)  
- Created `.smriti/` directory structure for project-specific knowledge storage  

---

## Decisions

- **Leverage QMD's schema**: Avoid modifying QMD's existing memory schema to prevent conflicts; instead, add metadata tables for agent/project tracking.  
- **Rule-based categorization**: Prioritize deterministic classification (e.g., regex for code snippets) over Ollama fallback to ensure consistency, with Ollama as a secondary option for ambiguous cases.  
- **Git-based sharing**: Export knowledge as markdown files with frontmatter to `.smriti/` in project repos, enabling version-controlled team collaboration without centralized storage.  
- **CLI-first design**: Focus on command-line tools for ingestion, categorization, and sync to align with CLI-based agent workflows.  

---

## Insights

- **Schema extension is safer than replacement**: Modifying QMD's schema would risk breaking existing workflows, so metadata tables are the optimal approach.  
- **Categorization needs precision**: Rule-based systems are faster and more reliable for structured data like code, while Ollama handles unstructured text.  
- **Git as a knowledge layer**: Using Git for sharing avoids single points of failure and enables team members to review/merge changes incrementally.  
- **CLI commands must be atomic**: Each command (e.g., `smriti ingest`) should handle partial failures gracefully to prevent inconsistent state.  

---

## Context

Prior state: QMD's `memory.ts` handled sessions, messages, and vector search, but lacked multi-agent metadata and categorization. Constraints: No schema changes to QMD, isolation per project, and team-wide knowledge sharing. Gotchas: Ensuring parser compatibility with diverse agents (Claude, Codex, Cursor) and avoiding duplication of QMD's core logic.
