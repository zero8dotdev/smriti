---
id: bc0a47ce-db71-4cf0-87bc-ea467c9f6ce0
category: topic
project: zero8-dev
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.748Z
tags: ["topic", "topic/explanation"]
---
# Let's discuss about the local memory system. A rag based approach to store / share all the conversat
**user**: Let's discuss about the local memory system. A rag based approach to store / share all the conversation a user will have with cli based agents. So the idea is, A user        
  usages different models, different agents, like claude, codex, and what not. They also use cursor, antigravity to work on the same project. So smriti will be a unified       
  system on top of the qmd, Which will store all the things you are talking with LLMs and store it category wise.                                                               
                                                                                                                                                                                
  We will need system to categories these conversation, about project, topic. code, and what not. And also we should be able to right context with the team.                    
                                                                                                                                                                                
  So the idea is all team members work on projects with isolated context. But there should be a way to build the eventual knowledge base of the team.
**assistant**: This is a fascinating concept - "smriti" (memory) as a unified knowledge layer across all AI agent interactions. Let me explore what already exists in your project, then we can discuss the architecture together.
**user**: [Request interrupted by user for tool use]
**user**: help me plan
**assistant**: Let me ask some key questions to shape the architecture before we plan.
**assistant**: Great context. A few more questions to nail down the design.
**assistant**: Now I have a solid understanding. Let me explore the existing qmd project to build on it properly.
**assistant**: There's already a `smriti/` directory. Let me explore it along with `qmd` references.
**assistant**: Great - there's already a well-designed spec for smriti. The `src/` directory is empty though, so no code has been written yet. Let me check a couple more things.
**assistant**: Let me check QMD's current state to understand the foundation.
**assistant**: Let me read the existing QMD memory implementation and store to understand the foundation.
**assistant**: Now I have a full understanding of the system. Let me read the QMD CLI to see how memory commands are wired, then I'll design the plan.
**assistant**: Excellent. Now I have the full picture. QMD's `memory.ts` is already a working implementation with 849 lines of code (sessions, messages, FTS5+vector search, embedding, summarization, recall). The `smriti/` directory has the spec but no code yet.

Before I write the plan, a couple of final design decisions:
**assistant**: Now I have the complete picture. Let me write the plan.
**assistant**: The plan is ready. Here's the summary:

**Smriti** builds on QMD's existing memory infrastructure (sessions, messages, FTS5+vector search, embeddings, Ollama) and adds three layers:

1. **Multi-agent ingestion** - Parsers for Claude Code, Codex, Cursor with agent/project metadata tracking via mapping tables (no modification to QMD's schema)
2. **Schema-based categorization** - 7 top-level categories with 25+ subcategories, rule-based auto-classification with optional Ollama fallback
3. **Git-based team sharing** - Export categorized knowledge as markdown files with frontmatter to `.smriti/` in project repos, import via `smriti sync`

The CLI has 13 commands covering ingest, search, categorize, share, and management. Implementation order starts with DB schema, then ingestion, then categorization, then search extensions, then team sharing.