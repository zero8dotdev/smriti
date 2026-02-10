---
id: 04321d7f-1ce4-41c6-823c-344026795afa
category: project
project: smriti
agent: claude-code
author: zero8
shared_at: 2026-02-10T11:33:12.798Z
tags: ["project", "project/config"]
---

# This session resolved OpenCode's tool-calling issues by switching to Qwen3 8B...

> This session resolved OpenCode's tool-calling issues by switching to Qwen3 8B, upgrading Ollama, and configuring custom behaviors. Key improvements include native tool support, concise interaction rules, and theme customization, enabling efficient local development without plugins.  

---

## Changes

- **Model upgrade**:  
  - Replaced `qwen2.5-coder:7b` with `qwen3:8b-tuned` (5.2GB) for native tool calling.  
  - Removed `qwen2.5-coder:7b-tuned` as default.  
- **Ollama upgrade**:  
  - Updated to v0.15.6 to enable `ollama launch` for model deployment.  
- **Config files**:  
  - Created `~/.config/opencode/AGENTS.md` for global rules (e.g., no filler text, prefer tools over code blocks).  
  - Modified `opencode.json` to set `temperature: 0.2` and enable all tools.  
- **Theme setup**:  
  - Created `~/.config/opencode/themes/claude.json` with dark navy background, amber accents, and syntax highlighting.  
- **Commands directory**:  
  - Added `/md`, `/summarize`, `/explain`, `/review`, `/doc` in `~/.config/opencode/commands/` for custom skills.  

---

## Decisions

- **Model selection**: Chose Qwen3 8B over Qwen2.5-Coder due to native tool support and smaller size (5.2GB vs. 4.7GB), balancing performance and hardware constraints.  
- **AGENTS.md**: Prioritized concise, rule-based behavior to avoid filler text and ensure direct tool execution.  
- **Theme customization**: Adopted a Claude-like theme for familiarity, with diff colors and syntax highlighting to improve readability.  
- **Command simplification**: Reduced prompt complexity for `/summarize` and `/explain` to align with the 8B model’s limitations.  

---

## Insights

- **Model limitations**: Smaller models (like 8B) struggle with long, structured prompts, requiring simplified instructions for effective tool calling.  
- **Tool integration**: OpenCode’s built-in system eliminates the need for plugins, streamlining workflows via config files and commands.  
- **User experience**: Custom themes and rules significantly enhance usability, making interactions faster and more intuitive for developers.  
- **Hardware constraints**: Qwen3 8B’s 5.2GB size fits within 18GB RAM, ensuring stability for
