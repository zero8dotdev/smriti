---
id: 84aa0a49-6d65-455d-87d9-b53023cf06cd
category: feature
project: smriti
agent: claude-code
author: zero8
shared_at: 2026-02-10T11:34:06.067Z
tags: ["feature", "feature/implementation"]
---

# A persistent conversation memory layer was implemented for QMD using SQLite w...

> A persistent conversation memory layer was implemented for QMD using SQLite with FTS5 full-text search and vector embeddings. This enables cross-session context retrieval without exceeding LLM context windows, reducing token usage from ~6,200 (full conversation) to ~60 tokens (targeted recall). The solution integrates with Claude Code via hooks and provides `qmd memory` CLI commands for search, recall, and embedding.

## Changes

- **Created**:  
  - `src/ollama.ts` (Ollama API client for chat, summarize, recall)  
  - `src/memory.ts` (SQLite-based memory storage with FTS5 + vector search)  
  - `~/.claude/hooks/save-memory.sh` (hook to auto-save Claude Code conversations)  
- **Modified**:  
  - `src/store.ts` (integrated memory tables into DB initialization)  
  - `src/formatter.ts` (added JSON/CSV/Markdown export for memory data)  
  - `src/qmd.ts` (implemented `qmd memory` CLI with 10 subcommands: save, search, recall, list, show, embed, etc.)

## Decisions

- **SQLite + FTS5**: Chosen for lightweight, local storage with full-text search capabilities.  
- **BM25 + RRF fusion**: Used for hybrid search to balance keyword matching and semantic similarity.  
- **Async hooks**: Auto-save conversations without blocking user interaction.  
- **Session IDs**: Leveraged `session_id` from Claude Code hooks to isolate memory entries.  
- **Token optimization**: Prioritized recall over full-context retrieval to stay within LLM token limits.

## Insights

- **Token savings**: Recall reduces context size from ~6,200 tokens (full conversation) to ~60 tokens (targeted snippets).  
- **Scalability**: Memory recall remains efficient across 10+ sessions, while full-context approaches fail due to token limits.  
- **Embedding necessity**: Vector search requires periodic `qmd memory embed` to maintain relevance.  
- **Hook integration**: Minimal changes to Claude Code settings enabled seamless memory persistence.

## Context

The solution addresses the need for persistent, searchable conversation history without overwhelming LLM context windows. Constraints included avoiding external dependencies (e.g., no direct Claude integration for summarization), ensuring local storage, and maintaining performance. The memory layer now enables cross-session context retrieval, improving efficiency for repeated queries.
