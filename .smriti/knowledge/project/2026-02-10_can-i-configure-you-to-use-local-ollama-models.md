---
id: 04321d7f-1ce4-41c6-823c-344026795afa
category: project
project: -Users-zero8
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.756Z
tags: ["project", "project/config"]
---
# Can I configure you to use local ollama models?
**user**: Can I configure you to use local ollama models?
**assistant**: No, Claude Code **does not natively support Ollama** or other non-Anthropic models. It's designed to work with Anthropic's Claude models (directly, or via Amazon Bedrock, Google Vertex AI, or Microsoft Foundry).

### Possible workaround: LLM gateway proxy

You could theoretically set up a proxy that translates between Ollama and the Anthropic Messages API format:

1. Run a gateway like **LiteLLM** that fronts your Ollama instance
2. Point Claude Code at it via the `ANTHROPIC_BASE_URL` environment variable

**However**, this is not officially supported, and many Claude Code features depend on capabilities specific to Anthropic models (tool use, extended thinking, etc.), so the experience would likely be degraded or broken.

### Supported providers

| Provider | How to configure |
|---|---|
| **Anthropic (direct)** | Default, uses `ANTHROPIC_API_KEY` |
| **Amazon Bedrock** | `CLAUDE_CODE_USE_BEDROCK=1` |
| **Google Vertex AI** | `CLAUDE_CODE_USE_VERTEX=1` |

If local/self-hosted models are important to you, you can submit a feature request at https://github.com/anthropics/claude-code/issues.
**user**: Cool! Can you configure my machine with opencode, then install best lightweight model using ollama. 
**assistant**: Let me research what OpenCode is and figure out the best setup for you.
**assistant**: Great finds! Let me check what's already on your machine, then get everything set up.
**assistant**: Homebrew and Ollama are already installed. Let me check your system specs and existing Ollama models, then install OpenCode.
**assistant**: You have 18GB RAM on Apple Silicon — perfect for a 7-8B parameter model. No Ollama models yet. Let me install OpenCode and pull a good coding model.
**assistant**: Got it. Let me install OpenCode and pull the best lightweight coding model for your setup.
**assistant**: OpenCode is installed. Now let me pull the best lightweight coding model. With your 18GB RAM on Apple Silicon, **Qwen 2.5 Coder 7B** is the sweet spot — excellent code quality while staying fast and responsive.
**assistant**: Model is downloaded. Now let me configure OpenCode to use it with Ollama.
**assistant**: Now let me create the config file.
**assistant**: Everything is set up. Let me verify it all works.
**assistant**: All done! Here's what was set up:

### Installed
| Component | Version | Details |
|---|---|---|
| **OpenCode** | 1.1.50 | `brew install opencode` via `anomalyco/tap` |
| **Qwen 2.5 Coder 7B** | 4.7 GB | Pulled via Ollama — best lightweight coding model for 18GB RAM |

### Configuration
- Config written to `~/.config/opencode/opencode.json`
- Points to Ollama's local API at `http://localhost:11434/v1`

### To use it
Just run:
```
opencode
```
Then select the **Ollama (local)** provider and **Qwen 2.5 Coder 7B** model.

### Tips
- If tool calls don't work well, increase Ollama's context window — run the model with `ollama run qwen2.5-coder:7b`, then `/set parameter num_ctx 16384`, then `/save qwen2.5-coder:7b-16k` to create a variant with larger context
- Everything runs 100% locally — no API keys needed, fully offline capable

Sources:
- [OpenCode Providers Docs](https://opencode.ai/docs/providers/)
- [OpenCode GitHub](https://github.com/anomalyco/opencode)
- [Ollama + OpenCode Guide](https://github.com/p-lemonish/ollama-x-opencode)
- [Ollama Library](https://ollama.com/library)
**user**: try it out
**assistant**: I can use `opencode run` for a non-interactive test. Let me try it.
**assistant**: It works! The model responded with a correct prime-checking function. Here's what it generated:

```python
def is_prime(n):
    if n <= 1:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True
```

**Qwen 2.5 Coder 7B** is running locally through Ollama and responding to OpenCode. The whole stack is working:

- **Ollama** serving the model locally on `localhost:11434`
- **OpenCode** connecting to it and getting code completions
- No API keys, no cloud — fully local on your machine

To use it interactively, just run:
```
opencode -m ollama/qwen2.5-coder:7b
```

Or launch `opencode` and select the model from the UI.
**user**: set it to default model. And Also use the best practices to tune it for speed and acuracy. 
**assistant**: Good research. Let me now:
1. Create a tuned Ollama model with optimized parameters
2. Set it as the default in OpenCode
3. Configure environment variables for Apple Silicon speed
**assistant**: Tuned model created. Now let me set up the Ollama environment variables and update the OpenCode config.
**assistant**: Now let me add the Ollama environment variables and update the OpenCode config.
**assistant**: Now let me source the env vars and verify everything works.
**assistant**: Let me run a quick test with the tuned model to confirm it works as default.
**assistant**: It's using the tuned model by default and producing clean code. Here's a summary of everything configured:

### Tuned Model (`qwen2.5-coder:7b-tuned`)
| Parameter | Value | Why |
|---|---|---|
| `num_ctx` | 16384 | Needed for agentic tool use in OpenCode |
| `temperature` | 0.2 | Low = deterministic, accurate code |
| `top_p` | 0.9 | Focused token selection |
| `top_k` | 40 | Limits candidate tokens for speed |
| `repeat_penalty` | 1.1 | Prevents repetitive output |
| `num_gpu` | 999 | Offloads all layers to Metal GPU |
| `num_thread` | 6 | Matches your performance cores |

### Environment Variables (added to `~/.zshrc`)
| Variable | Value | Why |
|---|---|---|
| `OLLAMA_FLASH_ATTENTION` | 1 | Faster attention computation on Apple Silicon |
| `OLLAMA_KV_CACHE_TYPE` | q8_0 | Quantized KV cache — less memory, faster inference |
| `OLLAMA_KEEP_ALIVE` | 10m | Keeps model loaded in memory between requests |

### OpenCode Config
- Default model set to `ollama/qwen2.5-coder:7b-tuned` in `~/.config/opencode/opencode.json`
- Just run `opencode` — no flags needed

> **Note:** Open a new terminal tab or run `source ~/.zshrc` to pick up the Ollama environment variables.
**user**: make it always open the tuned model by default. And What all tools I need to allow, So that I can move to a new folder and ask it to create a new bun API server?
**assistant**: Now I have everything. Let me update the config.
**assistant**: The `model` key is already set, so it should default. But let me verify it's actually being picked up, and then update the config with the right tool permissions for your Bun API workflow.
**assistant**: Good — both models are visible. Now let me update the config to allow all the tools you'll need for scaffolding a Bun API project.
**assistant**: Let me do a quick end-to-end test to confirm the default model and permissions work.
**assistant**: The permission format needs fixing. Let me check the valid values.
**assistant**: Got it — the valid values are `"allow"`, `"ask"`, and `"deny"`. Let me fix the config.
**assistant**: Working perfectly. Here's the final setup:

### Default Model
`qwen2.5-coder:7b-tuned` is now the default — no `-m` flag needed. Just run `opencode` from any folder.

### Tools Auto-Allowed
These are all set to `"allow"` (no confirmation prompts) so OpenCode can scaffold a project autonomously:

| Tool | What it does |
|---|---|
| `bash` | Run shell commands (`bun init`, `bun add`, etc.) |
| `read` | Read existing files |
| `edit` | Modify files with string replacements |
| `glob` | Find files by pattern |
| `grep` | Search file contents |
| `list` | List directories |
| `todoread`/`todowrite` | Track task progress |

### To create a Bun API server
```bash
mkdir ~/my-api && cd ~/my-api
opencode
```
Then ask it: *"Initialize a new Bun project and create a REST API server with routes for users CRUD"*

All the tools it needs (creating files, running `bun init`, installing packages, editing code) will run without prompting you for approval.
**user**: {"name": "bash", "arguments": {"command": "mkdir opencode && cd opencode && bun init"}} it is giving me json response. 
**assistant**: That's a known issue with smaller models — the model is outputting the tool call as raw JSON text instead of properly invoking it through OpenCode's tool calling protocol. This usually means the model needs a larger context window or a model that better supports tool use. Let me fix this.
**assistant**: Found the issue. **qwen2.5-coder:7b has known tool-calling bugs with OpenCode**. The Ollama docs recommend a **64K context minimum** and suggest different models. Let me check if `ollama launch` is available (handles this automatically) and switch to a model with proper tool support.
**assistant**: `ollama launch` needs v0.15+ (you have v0.13.5), and qwen3-coder needs 250GB RAM — way too big. Let me find the right model for your hardware.
**assistant**: The full GLM-4.7 is too big, but **GLM-4.7-Flash** (30B MoE with only 3B active params) is purpose-built for OpenCode tool calling. Let me also upgrade Ollama to get the `ollama launch` command.
**assistant**: Ollama was installed as a macOS app, not Homebrew. Let me update it properly.
**assistant**: This will replace the Ollama app. The running Ollama server will need to restart.
**assistant**: Ollama v0.15.6 with `ollama launch` support. Now let me pull GLM-4.7-Flash — the model Ollama officially recommends for OpenCode with proper tool calling.
**assistant**: GLM-4.7-Flash is 19GB — just over your 18GB. Let me check what `ollama launch opencode` recommends for your hardware, and also look at Qwen3 8B which has native tool calling.
**assistant**: The `ollama launch` has a device error — let me skip that and just set up the right model manually. **Qwen3 8B** has native tool calling support (unlike Qwen2.5-Coder). Let me also check the newer qwen3-coder-next sizes.
**assistant**: **Qwen3 8B** at 5.2GB is the sweet spot — small enough to leave plenty of room for 32K context + OS overhead, and has native tool calling. Let me set it up.
**assistant**: Now let me create the tuned variant with 32K context for agentic tool use.
**assistant**: Now update the OpenCode config to use the new model as default.
**assistant**: Now let me test the new setup with a tool-calling task.
**assistant**: **Tool calling is working!** Qwen3 properly invoked the `write` tool and created the file, instead of dumping raw JSON. Let me verify.
**assistant**: It created the file with actual code. Here's what changed and why:

### What was wrong
**Qwen2.5-Coder 7B** doesn't support OpenCode's tool-calling protocol properly — it outputs raw JSON instead of invoking tools.

### What's fixed
Switched to **Qwen3 8B** which has **native tool calling** support. It properly invokes `write`, `edit`, `bash`, etc. through OpenCode's protocol.

### Summary of changes

| What | Before | After |
|---|---|---|
| **Model** | qwen2.5-coder:7b | **qwen3:8b-tuned** |
| **Context window** | 16K | **32K** (recommended 32K+ for agentic) |
| **Tool calling** | Broken (raw JSON) | **Working** |
| **Ollama** | v0.13.5 | **v0.15.6** |
| **Size** | 4.7 GB | 5.2 GB |

### Your models now
```
ollama list
qwen3:8b-tuned        ← DEFAULT (tool calling works)
qwen2.5-coder:7b-tuned  ← still available for code completion
qwen2.5-coder:7b        ← base model
```

You're all set. Run `opencode` from any folder and it'll use Qwen3 8B Tuned with all tools auto-approved.
**user**: okay, I started using that. But here is my review. I know it's local setup so the it is going to give slow responses. 

But how do I make it more concise, and better interaction, Do I need to install a plugin for open code?
**assistant**: Good — no plugins needed. OpenCode has built-in ways to handle this. Let me set up three things: a global `AGENTS.md` for concise behavior, and tune the build agent config.
**assistant**: Now let me update the OpenCode config to tune the build agent.
**assistant**: Let me test it to confirm the concise behavior kicks in.
**assistant**: Clean — it used the tool directly, wrote minimal code, and gave a one-line confirmation. No plugins needed. Here's what was done:

### What was set up

**1. Global rules** (`~/.config/opencode/AGENTS.md`)
- No filler/preambles — just acts
- Prefers using tools over showing code blocks
- Executes commands directly instead of suggesting them
- TypeScript by default, modern ES modules

**2. Build agent tuned** (in `opencode.json`)
- `temperature: 0.2` — focused, deterministic output
- All tools explicitly enabled

**3. No plugins needed** — OpenCode's built-in system handles this:

| Feature | How |
|---|---|
| Custom instructions | `AGENTS.md` (global or per-project) |
| Concise behavior | Rules in AGENTS.md |
| Tool permissions | `permission` in opencode.json |
| Agent tuning | `agent.build` in opencode.json |

### Tip for per-project rules
When you create your Bun API project, drop an `AGENTS.md` in the project root:
```markdown
# Bun API Project
- Use Bun.serve() for HTTP
- Use Bun's built-in test runner
- Hono for routing
```
This overrides global rules with project-specific context.
**user**: Okay, Now how do I make open code act like your cli ui?
**assistant**: No plugins needed — just a custom theme and config. Let me create a Claude Code-inspired theme for OpenCode.
**assistant**: Now update the config to use the theme and tune the TUI.
**assistant**: Let me verify it loads without errors.
**assistant**: Everything works. Here's what you now have:

### Custom "Claude" theme
Created at `~/.config/opencode/themes/claude.json` — matches Claude Code's look:
- **Dark navy background** (`#1a1a2e`) 
- **Warm amber accent** (`#d4a574`) for prompts, headings, highlights
- **Soft green** for code strings and success states
- **Purple** keywords, **blue** functions — clean syntax highlighting
- Diff colors matching Claude Code's style

### TUI settings
- **macOS scroll acceleration** enabled for natural trackpad feel

### Keybindings cheat sheet (built-in, matches Claude Code patterns)
| Action | Shortcut |
|---|---|
| New session | `ctrl+x n` |
| Switch session | `ctrl+x l` |
| Compact context | `ctrl+x c` |
| Command palette | `ctrl+p` |
| Undo message | `ctrl+x u` |
| Redo message | `ctrl+x r` |
| Toggle details | `ctrl+x d` |
| Open editor | `ctrl+x e` |
| Change theme | `/themes` |
| Change model | `/models` |
| Exit | `ctrl+x q` |

### To tweak the theme
Edit `~/.config/opencode/themes/claude.json` and change any color, or switch live with `/themes` inside OpenCode. If you want to try other built-in themes: `catppuccin`, `tokyonight`, `gruvbox`, `nord`, `one-dark`, or `matrix` are all available.
**user**: Can you also change the system prompt to have lesss restriction 
**assistant**: I'll update both the Ollama model's system prompt and the OpenCode AGENTS.md to be less restrictive and more action-oriented for coding.
**user**: [Request interrupted by user for tool use]
**user**: I think you need to write a more expert level system prompt for an coding and code teaching assitance. 
**assistant**: Good call. Let me write a proper expert-level prompt focused on being a great coder and teacher.
**assistant**: Now rebuild the model and update AGENTS.md to match.
**assistant**: Let me test both modes — coding and teaching.
**assistant**: Concise, names the concept (type coercion), gives an example. Now let me test a coding task.
**user**: [Request interrupted by user for tool use]
**user**: How can I add skills like, writing in markdown and summerizing things in points to this ollama model? 
**assistant**: Now I know the format. Let me create the skills as custom commands.
**assistant**: Let me verify they load.
**assistant**: Works — but let me also test the `/md` and `/explain` commands to make sure arguments pass through.
**assistant**: All commands working. Here's what you now have:

### Custom Skills (slash commands)

| Command | What it does | Example |
|---|---|---|
| `/md` | Converts anything to clean Markdown | `/md my meeting notes here...` |
| `/summarize` | Distills content into bullet points | `/summarize <paste an article>` |
| `/explain` | Teaches a concept with structure | `/explain What is a closure?` |
| `/review` | Code review with actionable feedback | `/review @src/index.ts` |
| `/doc` | Generates developer documentation | `/doc @src/api/routes.ts` |

### How they work
- Each is a markdown file in `~/.config/opencode/commands/`
- Filename = command name (`md.md` → `/md`)
- `$ARGUMENTS` gets replaced with whatever you type after the command
- `@filename` references pull in file contents automatically

### To add more skills
Just create a new `.md` file in `~/.config/opencode/commands/`:
```
~/.config/opencode/commands/your-skill.md
```
Then invoke it with `/your-skill` inside OpenCode.
**user**: try out the new skills in opencode
**assistant**: Mixed results. `/md` worked well, but `/summarize` didn't bullet-point and `/explain` didn't follow the structured format. Let me test `/review` and `/doc`, then tighten up the prompts.
**assistant**: The 8B model is struggling with the longer, structured prompts. Let me simplify the commands — smaller models work better with shorter, more direct instructions.
**assistant**: Now let me retest with the simplified prompts.
**assistant**: You've hit your limit · resets 1:30am (Asia/Calcutta)
**user**: <task-notification>
<task-id>b422d24</task-id>
<output-file>/private/tmp/claude-501/-Users-zero8/tasks/b422d24.output</output-file>
<status>completed</status>
<summary>Background command "Test /doc skill" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude-501/-Users-zero8/tasks/b422d24.output
**assistant**: You've hit your limit · resets 1:30am (Asia/Calcutta)
**user**: <task-notification>
<task-id>b3e051f</task-id>
<output-file>/private/tmp/claude-501/-Users-zero8/tasks/b3e051f.output</output-file>
<status>completed</status>
<summary>Background command "Test /review skill" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude-501/-Users-zero8/tasks/b3e051f.output
**assistant**: You've hit your limit · resets 1:30am (Asia/Calcutta)
**user**: <task-notification>
<task-id>b3a1480</task-id>
<output-file>/private/tmp/claude-501/-Users-zero8/tasks/b3a1480.output</output-file>
<status>completed</status>
<summary>Background command "Test simplified /summarize" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude-501/-Users-zero8/tasks/b3a1480.output
**assistant**: You've hit your limit · resets 1:30am (Asia/Calcutta)