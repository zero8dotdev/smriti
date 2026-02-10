---
id: 2e5f420a-e376-4ad4-8b35-ad94838cbc42
category: project
project: smriti
agent: claude-code
author: zero8
shared_at: 2026-02-10T11:29:44.501Z
tags: ["project", "project/dependency"]
---

# The session involved setting up a new project named **Smriti** for a local RA...

> The session involved setting up a new project named **Smriti** for a local RAG (Retrieval-Augmented Generation) system, integrating QMD memory commands and Bun as the development framework. A structured folder layout was created, including source files, database schemas, and comprehensive documentation (CLAUDE.md) to guide implementation and usage. This setup ensures scalability, maintainability, and clear separation of concerns for the RAG system.  

---

## Changes

- Created folder structure at `/Users/zero8/zero8.dev/smriti/`  
  - `src/` (source code: `memory.ts`, `ollama.ts`, `formatter.ts`, `cli/`)  
  - `db/` (database schema: `tables/`, `functions/`, `triggers/`, `policies/`)  
  - `CLAUDE.md` (complete QMD memory command reference, auto-save hooks, API docs)  
  - `README.md` (quick start guide)  
  - `package.json` (Bun project configuration)  
  - `.gitignore` (version control exclusions)  
- Moved existing implementation files into `src/` and `db/` directories  
- Added QMD memory command documentation to `CLAUDE.md`  

---

## Decisions

- **Project name**: Chose **Smriti** (Sanskrit for "memory") to reflect the system's role as a knowledge repository.  
- **Folder structure**:  
  - `src/` for application logic (separating concerns from database and CLI tools).  
  - `db/` for schema and policies (centralizing database design).  
  - Root-level `CLAUDE.md` for centralized documentation.  
- **Bun framework**: Selected for its modern tooling and compatibility with QMD CLI integration.  
- **Auto-save hooks**: Documented to ensure seamless integration with Claude Code sessions.  

---

## Insights

- **Naming conventions**: Using culturally resonant names like Smriti improves team alignment and project identity.  
- **Scalability**: Separating source code, database, and CLI tools allows for modular expansion.  
- **Documentation**: CLAUDE.md serves as both a reference and onboarding guide, reducing cognitive load for new contributors.  
- **Bun integration**: Leveraging Bun's CLI and package management simplifies dependency handling and script execution.  

---

## Context

The user had already implemented core files for the RAG system but needed a structured project layout to organize code and documentation. The project must support QMD memory commands (e.g., `memory list`, `memory save`) and integrate with Bun for development. Constraints included ensuring compatibility with existing Claude Code sessions and providing clear guidance for future contributions. The setup enables rapid iteration while maintaining clarity for team collaboration.
