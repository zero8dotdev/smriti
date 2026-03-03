# Rule-Based Engine - Quick Reference

## Using the New Rule System

### For End Users

```bash
# Categorize messages using loaded rules
smriti categorize

# Search by category (rules help categorize)
smriti search "bug" --category bug/report

# Categorize specific session
smriti categorize --session <session-id>
```

### For Developers

#### Loading Rules Programmatically

```typescript
import { getRuleManager } from "./categorize/rules/loader";

// Load rules for a project
const ruleManager = getRuleManager();
const rules = await ruleManager.loadRules({
  language: "typescript",
  framework: "nextjs",
  projectPath: "/path/to/project"
});

// Use rules for classification
const results = classifyByRules(text, rules);
```

#### Detecting Project Language

```typescript
import { detectProject } from "./detect/language";

const result = await detectProject("/path/to/project");
console.log(result.language);    // "typescript"
console.log(result.framework);   // "nextjs"
console.log(result.confidence);  // 0.95
```

#### Adding Custom Rules (Phase 1.5)

```yaml
# .smriti/rules/custom.yml
version: "1.0.0"
language: custom

rules:
  - id: custom-api-pattern
    pattern: '\b(API|REST|endpoint)\b'
    category: architecture/design
    weight: 0.7
    frameworks: ["nextjs"]  # Optional: only applies to Next.js projects
    description: "Identifies API design patterns"
```

## Rule File Format

### Structure

```yaml
version: "1.0.0"
language: general              # or typescript, python, rust, go, javascript
framework: nextjs              # Optional: applies to specific framework
extends:                       # Optional: inherit rules from other files
  - general
  - javascript

rules:
  - id: unique-rule-id         # Required: must be unique within tier
    pattern: '\b(keyword)\b'   # Required: valid RegEx
    category: bug/report       # Required: must exist in smriti_categories
    weight: 0.8                # Required: 0-1, higher = more confident
    frameworks:                # Optional: frameworks this rule applies to
      - nextjs
    description: "..."         # Optional: human-readable description
```

### Pattern Tips

- Use raw strings: `'\b(word|pattern)\b'`
- Regex is **case-insensitive** by default
- Test patterns with online regex tools first
- Escape special chars: `\.` for dot, `\[` for bracket
- Use word boundaries `\b` for whole words
- Use `\s*` for optional whitespace

### Category Reference

**Top-level**: bug, code, architecture, feature, project, decision, topic

**Sub-categories**:
- bug/report, bug/fix, bug/investigation
- code/implementation, code/pattern, code/review, code/snippet
- architecture/design, architecture/decision, architecture/tradeoff
- feature/requirement, feature/design, feature/implementation
- project/setup, project/config, project/dependency
- decision/technical, decision/process, decision/tooling
- topic/learning, topic/explanation, topic/comparison

## 3-Tier Override Examples

### Base Rule (Tier 1 - general.yml)

```yaml
- id: rule-bug
  pattern: '\b(error|crash)\b'
  category: bug/report
  weight: 0.7
```

### Project Rule (Tier 2 - .smriti/rules/custom.yml)

```yaml
# Override: make TypeScript errors more confident
- id: rule-bug
  weight: 0.9  # Increased from 0.7
```

### Runtime Rule (Tier 3 - programmatic)

```typescript
const runtimeRules = [
  {
    id: "rule-bug",
    weight: 0.95  // Highest precedence wins
  }
];

const merged = ruleManager.mergeRules(base, project, runtime);
// result: weight = 0.95
```

## Performance Tips

### Caching

- Rule patterns compile once and cache in memory
- GitHub rules cache for 7 days (fallback to stale if offline)
- Clear cache with: `ruleManager.clear()`

### Optimization

```typescript
// ✅ Good: Load rules once, reuse
const rules = await ruleManager.loadRules({ language: "typescript" });
for (const msg of messages) {
  classifyByRules(msg, rules);  // <5ms per message
}

// ❌ Bad: Load rules for each message
for (const msg of messages) {
  const rules = await ruleManager.loadRules(...);  // 50-100ms each
  classifyByRules(msg, rules);
}
```

## Debugging

### View Loaded Rules

```bash
# List all rules (Phase 1.5 - stubbed)
smriti rules list

# List rules for specific category
smriti rules list --category bug
```

### Validate Rules File

```bash
# Check YAML syntax and rule format (Phase 1.5 - stubbed)
smriti rules validate .smriti/rules/custom.yml
```

### Check Detection

```typescript
import { detectProject } from "./detect/language";

const result = await detectProject(".");
console.log("Language:", result.language);
console.log("Framework:", result.framework);
console.log("Confidence:", result.confidence);
console.log("Markers:", result.markers);
```

## Common Issues

### Invalid YAML Syntax

❌ Error: `YAMLParseError: Unexpected scalar`
- Solution: Use proper YAML quoting
- Use single quotes for patterns: `pattern: '\b(word)\b'`
- Or double quotes with escaping: `pattern: "\\b(word)\\b"`

### Rule Not Applied

❌ Pattern matches but rule not applied
- Check: Is category valid? (smriti categories)
- Check: Is framework specified? (only applies if project framework matches)
- Check: Is rule in right tier? (check load order)
- Check: Pattern case-sensitive? (classification is case-insensitive)

### Slow Classification

❌ Categorization takes >500ms
- Likely: Rules loading on each call (cache them)
- Or: Large number of rules (optimize patterns)
- Or: Network lag loading from GitHub (use local files during dev)

## File Locations

```
.smriti/
├── rules/
│   ├── base.yml         ← Auto-generated from GitHub
│   ├── custom.yml       ← User-defined project rules
│   └── README.md        ← Documentation (Phase 1.5)
├── CLAUDE.md            ← Project context
└── prompts/             ← Custom prompts
```

## Integration with Classification

Rules are used in this order:

1. **Load**: RuleManager reads YAML files
2. **Merge**: Apply 3-tier precedence (runtime > project > base)
3. **Filter**: Remove rules that don't match project framework
4. **Compile**: Convert pattern strings to RegExp (cached)
5. **Classify**: Match message against all compiled patterns
6. **Score**: Calculate confidence = weight × (0.5 + 0.5 × density)
7. **Deduplicate**: Keep highest confidence per category
8. **Sort**: Return results sorted by confidence (descending)

## Next Steps

See `PHASE1_IMPLEMENTATION.md` for detailed technical documentation.

See original plan for Phase 1.5 (language-specific rules) and Phase 2 (auto-updates).

---

For questions or issues, refer to:
- Implementation details: `PHASE1_IMPLEMENTATION.md`
- Architecture plan: Root directory rule-based engine plan
- Test examples: `test/detect.test.ts`, `test/rules-loader.test.ts`
