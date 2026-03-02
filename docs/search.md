# Search & Recall

Smriti has two ways to retrieve memory: `search` and `recall`. They use
different retrieval strategies and are optimized for different situations.

---

## search vs recall

| | `smriti search` | `smriti recall` |
|--|-----------------|-----------------|
| **Retrieval** | Full-text (BM25) | Full-text + vector (hybrid) |
| **Deduplication** | None — all matching messages | One best result per session |
| **Synthesis** | No | Yes, with `--synthesize` |
| **Best for** | Finding specific text, scanning results | Getting context before starting work |

Use **search** when you know roughly what you're looking for and want to scan
results. Use **recall** when you want the most relevant context from your
history, deduplicated and optionally compressed.

---

## How Search Works

`smriti search` runs a BM25 full-text query against every ingested message.
It's fast, synchronous, and returns ranked results immediately — no model
loading.

```bash
smriti search "rate limiting"
smriti search "auth" --project myapp --agent claude-code
smriti search "deployment" --category decision --limit 10
```

Filters (`--project`, `--category`, `--agent`) narrow results with SQL JOINs
against Smriti's metadata tables. They compose — all filters apply together.

---

## How Recall Works

`smriti recall` goes further. It runs full-text search, deduplicates results
so you get at most one snippet per session (the highest-scoring one), and
optionally synthesizes everything into a single coherent summary.

```bash
smriti recall "how did we handle rate limiting"
smriti recall "database setup" --synthesize
smriti recall "auth flow" --synthesize --model qwen3:0.5b
```

**Without filters:** recall uses QMD's full hybrid pipeline — BM25 +
vector embeddings + Reciprocal Rank Fusion. Semantic matches work here: "auth
flow" can surface results that talk about "login mechanism."

**With filters:** recall currently uses full-text search only. The hybrid
pipeline is bypassed when `--project`, `--category`, or `--agent` is applied.
This is a known limitation — filtered recall loses semantic matching. It's
on the roadmap to fix.

---

## Synthesis

`--synthesize` sends the recalled context to Ollama and asks it to produce a
single coherent summary. This is the difference between getting 10 raw
snippets and getting a paragraph that distills what matters.

```bash
smriti recall "connection pooling decisions" --synthesize
```

Requires Ollama running locally. See [Configuration](./configuration.md#ollama-setup)
for setup. Use `--model` to pick a lighter model if the default is too slow.

---

## Vector Search

Vector search finds semantically similar content — results that mean the same
thing even if they don't share the same words. It requires embeddings to be
built first:

```bash
smriti embed
```

This runs locally via node-llama-cpp and EmbeddingGemma. It can take a few
minutes on a large history, but only processes new messages — subsequent runs
are fast.

Once embeddings exist, unfiltered `smriti recall` automatically uses the full
hybrid pipeline (BM25 + vector + RRF). Filtered recall and `smriti search`
currently use BM25 only.

---

## Filtering

All filters compose and work across both commands:

```bash
# Scope to a project
smriti recall "auth" --project myapp

# Scope to a specific agent
smriti search "deployment" --agent cursor

# Scope to a category
smriti recall "why did we choose postgres" --category decision

# Combine them
smriti search "migration" --project api --category decision --limit 5
```

Category filtering is hierarchical — `--category decision` matches
`decision`, `decision/technical`, `decision/process`, and
`decision/tooling`.

---

## Token Compression

The point of recall isn't just finding relevant content — it's making that
content usable in a new session without blowing up the context window.

| Scenario | Raw | Via Smriti | Reduction |
|----------|-----|------------|-----------|
| Relevant context from past sessions | ~20,000 tokens | ~500 tokens | **40x** |
| Multi-session recall + synthesis | ~10,000 tokens | ~200 tokens | **50x** |
| Full project conversation history | 50,000+ tokens | ~500 tokens | **100x** |

That's what `--synthesize` is for — not a summary for you to read, but
compressed context for your next agent session to start with.
