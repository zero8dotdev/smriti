---
id: 2e5f420a
category: project
project: 
agent: 
author: zero8
shared_at: 2026-02-10T18:09:49.702Z
tags: ["project", "project/setup"]
---

# A new local RAG project named **Smriti** was created under the `/Users/zero8/...

> A new local RAG project named **Smriti** was created under the `/Users/zero8/zero8.dev/` directory to serve as a knowledge repository for conversations, agents, and memory storage. The project uses Bun as its runtime and includes a `CLAUDE.md` documentation file to guide usage of the QMD memory system. This setup enables seamless integration with the user’s existing workflow and ensures clear documentation for future development.  

---

## Changes

- Created folder structure:  
  - `/Users/zero8/zero8.dev/smriti/` (project root)  
  - `/Users/zero8/zero8.dev/smriti/CLAUDE.md` (documentation for QMD memory system)  
  - `/Users/zero8/zero8.dev/smriti/package.json` (Bun project configuration)  
- Added Bun CLI commands to `CLAUDE.md` for memory management (`qmd memory list`, `qmd memory save`, etc.).  
- Configured `package.json` with Bun as the default runtime and project-specific scripts.  

---

## Decisions

- **Project name**: Chose **Smriti** (Sanskrit for "memory") to reflect the system’s role as a knowledge repository.  
- **Runtime**: Selected Bun for its modern tooling, faster execution, and compatibility with the QMD CLI.  
- **Documentation**: Prioritized `CLAUDE.md` as the primary guide to ensure clarity for future contributors and to align with existing project conventions.  

---

## Insights

- **Cultural naming**: Using Hindu mythology terms like *Smriti* adds contextual depth and aligns with the project’s purpose as a memory-centric system.  
- **Bun integration**: Bundling the project with Bun simplifies dependency management and leverages its modern tooling for rapid development.  
- **CLAUDE.md structure**: Explicitly documenting QMD commands ensures users can quickly understand how to interact with the memory system without reverse-engineering the code.  

---

## Context

The project was initiated to replace a fragmented setup of ad-hoc memory storage for RAG workflows. Constraints included the need for a unified documentation system and a runtime that supports CLI tools like QMD. The solution leverages Bun’s ecosystem for performance and compatibility, while `CLAUDE.md` ensures onboarding simplicity for collaborators.
