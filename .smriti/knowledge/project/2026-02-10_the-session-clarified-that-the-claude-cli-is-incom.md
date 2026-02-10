---
id: 598764f9-ce18-4f90-b951-210e7f6afd1c
category: project
project: smriti
agent: claude-code
author: zero8
shared_at: 2026-02-10T11:30:13.118Z
tags: ["project"]
---

# The session clarified that the Claude CLI is incompatible with local Ollama m...

> The session clarified that the Claude CLI is incompatible with local Ollama models due to its reliance on Anthropic's API. The discussion emphasized alternative approaches for integrating local LLMs, including direct Ollama usage, custom agent development, or third-party tools, while highlighting architectural constraints around API compatibility and deployment requirements.

## Changes

- No files created/modified  
- No features added or bugs fixed  
- No configuration changes

## Decisions

- **Claude CLI integration**: Chose to prioritize Anthropic API compatibility over local model support, aligning with Claude Code's design constraints.  
- **Alternative pathways**: Evaluated options like custom agent development and third-party CLI tools to address local model needs without modifying Claude Code's core functionality.

## Insights

- **API dependency**: Claude Code's reliance on Anthropic's API limits flexibility for local model integration, requiring separate tooling or custom servers.  
- **Custom integration complexity**: Building a bridge between Ollama and Claude Code would demand significant infrastructure (e.g., a reverse proxy or API gateway) and is outside the scope of the CLI itself.  
- **Tooling specificity**: Ollama's CLI and similar tools are optimized for local model interaction, whereas Claude Code is tailored for cloud-based Claude models.

## Context

- **Existing setup**: The project uses Bun and relies on Claude Code for model interactions, but the team seeks to leverage a local Ollama model.  
- **Constraints**: Internet connectivity is required for Claude Code, while Ollama operates offline.  
- **Gotchas**: Mixing local and cloud models requires careful architecture to handle API differences and data flow.
