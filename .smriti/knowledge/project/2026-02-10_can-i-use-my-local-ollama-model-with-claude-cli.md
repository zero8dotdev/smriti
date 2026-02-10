---
id: 598764f9-ce18-4f90-b951-210e7f6afd1c
category: project
project: zero8-dev
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.747Z
tags: ["project"]
---
# Can I use my local ollama model with claude cli?
**user**: Can I use my local ollama model with claude cli?
**assistant**: Claude Code (the CLI) is designed to work with Claude models through the Anthropic API. It **does not have built-in support for local Ollama models**.

Claude Code connects directly to Anthropic's Claude models, so it requires an Anthropic API key and internet connectivity.

However, a few alternatives if you want to work with local LLMs:

1. **Use Ollama directly** - Run your Ollama server and interact with it via its HTTP API yourself, rather than through Claude Code

2. **Extend Claude Code** - Claude Code supports building custom agents with the Claude Agent SDK, but this would still require connecting to Claude models via the Anthropic API

3. **Use other CLI tools** - Tools like [Ollama's CLI](https://ollama.ai) or other local LLM interfaces are designed specifically for local models

If you're interested in building applications that use local Ollama models with Bun (per your project setup), you could create your own server that integrates both, but that would be separate from Claude Code itself.

Is there a specific use case you're trying to achieve? I can help you set that up.