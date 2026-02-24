# Stage 1: Knowledge Unit Segmentation

You are analyzing a technical conversation to extract distinct knowledge units that can be documented independently.

## Session Metadata

**Duration**: {{duration_minutes}} minutes
**Messages**: {{total_messages}}
**Tools Used**: {{tools_used}}
**Files Modified**: {{files_modified}}
**Git Operations**: {{git_operations}}
**Errors**: {{error_count}}
**Test Results**: {{test_results}}

## Category Taxonomy

Valid categories are:
- `bug/fix` - Bug fixes with root cause and solution
- `bug/investigation` - Bug debugging and investigation process
- `architecture/design` - System design decisions
- `architecture/decision` - Architecture decisions (ADRs)
- `code/implementation` - Code implementation details
- `code/pattern` - Design patterns and idioms
- `feature/design` - Feature design and planning
- `feature/implementation` - Feature implementation work
- `project/setup` - Project setup and scaffolding
- `project/config` - Configuration and environment setup
- `topic/learning` - Learning and tutorials
- `topic/explanation` - Explanations and deep dives
- `decision/technical` - Technical decisions
- Other valid category combinations with parent/child structure

## Conversation

{{conversation}}

## Task

Analyze this conversation and identify **distinct knowledge units** that could be shared as independent documents.

For each unit, extract:
1. **Topic** - A concise description (5-10 words)
2. **Category** - Best matching category from taxonomy above
3. **Relevance** - Score 0-10 for how valuable this is to share (0=noise, 10=critical)
4. **Entities** - List of technologies, libraries, patterns, or concepts
5. **Line Ranges** - Message indices belonging to this unit (0-indexed)

Return **ONLY** valid JSON (no preamble or explanation):

```json
{
  "units": [
    {
      "topic": "Token expiry bug investigation",
      "category": "bug/investigation",
      "relevance": 8.5,
      "entities": ["JWT", "Token expiry", "Authentication", "Express"],
      "lineRanges": [{"start": 0, "end": 25}]
    },
    {
      "topic": "Redis caching strategy decision",
      "category": "architecture/decision",
      "relevance": 7.0,
      "entities": ["Redis", "Caching", "Performance", "Decision"],
      "lineRanges": [{"start": 26, "end": 45}]
    }
  ]
}
```

Notes:
- Aim for 2-4 units per session (more fragmentation = smaller docs, easier to search)
- Skip trivial units (relevance < 5 is borderline, only include if substantive)
- Use line ranges to map units back to original conversation
- Return empty `units` array if no meaningful knowledge extracted
