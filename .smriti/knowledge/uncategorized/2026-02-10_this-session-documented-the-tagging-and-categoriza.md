---
id: dc3a6584
category: uncategorized
project: 
agent: 
author: zero8
shared_at: 2026-02-10T17:53:50.785Z
tags: []
---

# This session documented the tagging and categorization system for the smriti ...

> This session documented the tagging and categorization system for the smriti CLI, ensuring consistent category management across workflows, sharing, and synchronization. Key additions include a detailed category tree, auto-classification logic, tag filtering behavior, and a config file for team-specific custom tags. These changes improve usability, reduce ambiguity in tag propagation, and enable collaborative workflows while maintaining data integrity during sync.  

---

## Changes

- **Modified**: `/Users/zero8/zero8.dev/smriti/README.md`  
  - Added **"Tagging & Categories"** section with 7 subsections:  
    1. Default category tree (7 top-level + 21 subcategories)  
    2. Auto-classification (rule-based + LLM fallback)  
    3. Manual tagging syntax (`smriti tag <session-id> <category>`)  
    4. Custom category creation (`smriti categories add`)  
    5. Tag filtering behavior per command (`smriti list/search/recall/share`)  
    6. **Categories in Share & Sync** (symmetric serialization/deserialization, YAML frontmatter, subdirectory organization)  
    7. Practical command examples  
  - Added **"Sync should restore all secondary category tags from frontmatter"** issue (#1)  
  - Created **"Config file for team custom tags"** issue (#2)  
- **Created**: `.smriti/config.json` (write-only, extended to include `categories` array for team-specific tags)  

---

## Decisions

- **Symmetric serialization/deserialization**: Ensured category IDs written by `share` are exactly restored by `sync` to avoid reclassification. Secondary tags are serialized but not yet deserialized, flagged as a limitation.  
- **Config file design**: Extended `.smriti/config.json` to include a `categories` array for team-specific tags, avoiding orphaned tags during sync.  
- **Backward compatibility**: Maintained support for legacy exports with scalar `category` fields while adding new `tags` array support.  
- **CLI integration**: Added `smriti config init/add-category/show` commands to manage team config, ensuring custom categories are available to the LLM classifier.  

---

## Insights

- **Tag propagation ambiguity**: Without explicit config files, team-specific tags risk being orphaned during sync. A centralized config file resolves this by defining shared categories.  
- **LLM classifier limitations**: Current LLM fallback only uses built-in categories. Extending the classifier to recognize custom
