# 3-Stage Segmentation Pipeline - Quick Start

## Status: ✅ MVP Complete

The 3-stage prompt architecture has been fully implemented and tested. The new pipeline segments AI sessions into modular knowledge units with category-specific documentation.

## Try It Now

### Basic Usage
```bash
# Enable the new 3-stage pipeline
smriti share --project myapp --segmented
```

### With Custom Relevance Threshold
```bash
# Only share units scoring 7+ out of 10
smriti share --project myapp --segmented --min-relevance 7

# Share more liberally (5+)
smriti share --project myapp --segmented --min-relevance 5
```

### Share Specific Category
```bash
smriti share --category bug --segmented
smriti share --category architecture --segmented
```

### Share Single Session
```bash
smriti share --session abc123def --segmented
```

## What Happens

When you run `smriti share --segmented`, three things happen automatically:

### Stage 1: Segment Session → Knowledge Units
- LLM analyzes the session
- Identifies distinct topics (e.g., "Token expiry bug", "Redis caching decision")
- Assigns category, relevance score (0-10), and entities
- Gracefully degrades to single unit if LLM unavailable

### Stage 2: Generate Documents → Polished Markdown
- Applies category-specific template (bug docs, architecture docs, code, etc.)
- LLM synthesizes focused documentation per unit
- Adds YAML frontmatter with metadata
- Returns raw content if synthesis fails

### Stage 3: Save & Deduplicate (Phase 2)
- Writes to `.smriti/knowledge/<category>/`
- Deduplicates at unit level
- Updates manifest and CLAUDE.md

## Output

Files are organized by category:

```
.smriti/knowledge/
├── bug-fix/
│   ├── 2026-02-10_token-expiry-investigation.md
│   └── 2026-02-12_rate-limiting-fix.md
├── architecture-decision/
│   └── 2026-02-10_redis-caching-decision.md
├── code-implementation/
│   └── 2026-02-11_session-middleware.md
├── feature-design/
│   └── 2026-02-11_oauth2-integration.md
└── ...
```

Each file has structured metadata:

```yaml
---
id: unit-abc123
session_id: sess-xyz789
category: bug/fix
relevance_score: 8.5
entities: ["JWT", "Express", "Token expiry"]
files: ["src/auth.ts"]
shared_at: 2026-02-12T10:30:00Z
---

## Symptoms
...

## Root Cause
...

## Fix
...

## Prevention
...
```

## Category-Specific Templates

Each category gets documentation optimized for its purpose:

| Category | Structure |
|----------|-----------|
| `bug/*` | Symptoms → Root Cause → Investigation → Fix → Prevention |
| `architecture/*`, `decision/*` | Context → Options → Decision → Consequences |
| `code/*` | Implementation → Key Decisions → Gotchas → Usage |
| `feature/*` | Requirements → Design → Implementation → Testing |
| `topic/*` | Concept → Relevance → Key Points → Examples → Resources |
| `project/*` | What Changed → Why → Steps → Verification |

## Customization

Teams can customize documentation style by creating project-level prompt overrides:

```bash
mkdir -p .smriti/prompts

# Create a custom bug template
cat > .smriti/prompts/stage2-bug.md <<'EOF'
# Custom Bug Documentation

Transform bug investigations into incident reports.

## Content
{{content}}

## Your Custom Sections
- Timeline
- Resolution
- Lessons Learned
EOF
```

## Configuration

### Relevance Threshold
Default is 6/10 (balanced quality/coverage):
- Units below threshold are filtered out
- Override with `--min-relevance <float>`

### Model Selection
By default uses `qwen3:8b-tuned`:
- Override with `--reflect-model llama3:70b`

### Disable Legacy Reflection
New pipeline works independently:
- `--no-reflect` still disables legacy synthesis
- Use together: `smriti share --segmented --no-reflect`

## How It Works Behind the Scenes

### Stage 1 Prompt Injection
LLM gets rich context to understand session phases:
- **Tools Used**: Read (12×), Bash (8×), Grep (3×)
- **Files Modified**: src/auth.ts, src/db.ts
- **Git Operations**: commit (1×), pr_create (1×)
- **Errors**: Rate limit (1×), timeout (1×)
- **Test Results**: Tests run and passed
- **Duration**: Estimated from message count

This metadata helps LLM detect topic boundaries and session structure.

### Graceful Degradation
- **Stage 1 fails?** → Falls back to single unit treating entire session as one
- **Stage 2 fails?** → Returns raw unit content as markdown
- **Pipeline never breaks** → Always produces output

### Unit-Level Deduplication
Prevents resharing the same content:
- Hashes: content + category + entities + files
- Checks before writing
- Enables sharing new units from partially-shared sessions

## Verification

### Test It Works
```bash
# Run the test suite
bun test test/team-segmented.test.ts

# Should see: 14 pass, 0 fail
```

### Check Output Quality
```bash
# Share a session
smriti share --project myapp --segmented

# Inspect generated documents
head -20 .smriti/knowledge/bug-fix/*.md
# Should have category-specific sections

# Check frontmatter
cat .smriti/knowledge/bug-fix/*.md | grep "^---" -A 10
# Should have unit_id, relevance_score, entities
```

### Compare with Legacy
```bash
# Side-by-side comparison
# Legacy (single-stage)
smriti share --project myapp

# New (3-stage)
smriti share --project myapp --segmented

# New should produce multiple focused files vs. one mixed file
```

## Performance

| Metric | Value |
|--------|-------|
| **Token Usage** | ~30K per session (vs 11K legacy, but 2+ docs produced) |
| **Time** | ~26 seconds sequential (parallelizable in Phase 2) |
| **Files per Session** | 2-4 focused docs (vs 1 mixed doc) |

## Backward Compatibility

✅ **Fully backward compatible**
- Legacy `smriti share` unchanged (no `--segmented` flag)
- Existing workflows unaffected
- Can opt-in whenever ready

## What's New Since Plan

### Implemented ✅
- Stage 1: Session segmentation with metadata injection
- Stage 2: Category-specific documentation templates
- Type definitions and interfaces
- Database schema extensions
- CLI flags (`--segmented`, `--min-relevance`)
- Unit-level deduplication
- Graceful error handling with fallbacks
- 14 unit tests (all passing)

### Deferred (Phase 2+)
- ⏳ Stage 3: Metadata enrichment (entity extraction, freshness detection)
- ⏳ Relationship graphs and contradiction detection
- ⏳ Multi-session knowledge units
- ⏳ Progress indicators and parallelization

## Troubleshooting

### "Ollama API error"
**Cause**: Ollama not running
**Solution**:
```bash
ollama serve  # Start Ollama in another terminal
```

### "No units above relevance threshold"
**Cause**: All detected units scored below `--min-relevance`
**Solution**: Lower threshold or check session quality
```bash
smriti share --project myapp --segmented --min-relevance 5
```

### "Category validation failed"
**Cause**: LLM suggested unknown category
**Solution**: Code validates and falls back to parent category automatically

### Empty output files
**Cause**: Stage 2 synthesis failed
**Solution**: Files still written with raw content. Try with different model:
```bash
smriti share --project myapp --segmented --reflect-model llama3:8b
```

## Next Steps

### Immediate (You can do this)
- [ ] Test with a few sessions: `smriti share --segmented`
- [ ] Check output quality and verify categories make sense
- [ ] Adjust `--min-relevance` to find your sweet spot
- [ ] Create custom `.smriti/prompts/` templates if needed

### Phase 2 (Future)
- [ ] Automatic entity extraction from generated docs
- [ ] Technology version detection (Node 18 vs 20, etc.)
- [ ] Freshness scoring (deprecated features)
- [ ] Parallelized Stage 2 for faster processing
- [ ] Progress indicators for long operations

### Phase 3 (Future)
- [ ] Relationship graph (find related documents)
- [ ] Contradiction detection (conflicting advice)
- [ ] `smriti conflicts` command
- [ ] Knowledge base coherence analysis

## Documentation

- **Full Plan**: See `/Users/zero8/zero8.dev/smriti` — the provided plan document
- **Implementation Details**: See `IMPLEMENTATION.md` in this directory
- **Source Code**:
  - `src/team/segment.ts` — Stage 1 logic
  - `src/team/document.ts` — Stage 2 logic
  - `src/team/prompts/` — Prompt templates
  - `test/team-segmented.test.ts` — Tests
