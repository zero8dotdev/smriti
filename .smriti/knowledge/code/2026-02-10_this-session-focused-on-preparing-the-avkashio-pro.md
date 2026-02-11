---
id: a9a45641-1bf9-41da-9aa4-1f61815d71ab
category: code
project: zero8-dev-avkash
agent: claude-code
author: zero8
shared_at: 2026-02-10T17:58:23.419Z
tags: ["code", "code/review"]
---

# This session focused on preparing the avkash.io project for open-source relea...

> This session focused on preparing the avkash.io project for open-source release by creating essential documentation, configuring a restrictive license, removing Vercel integration, and scanning for secrets. These steps ensure clarity for contributors, compliance with open-source norms, and security hygiene for the codebase.  

---

## Changes

- **Created `README.md`** at the project root to introduce the project, its purpose, and usage instructions.  
- **Created `CONTRIBUTING.md`** in the `docs/` directory to outline contribution guidelines, code standards, and onboarding steps.  
- **Added `LICENSE`** file at the root with AGPL-3.0 text to enable self-hosting while prohibiting reselling.  
- **Removed Vercel integration** by deleting `vercel.json` and any related configuration files.  
- **Scanned the codebase for secrets** using `trufflehog --since 7d .` to identify and remediate potential sensitive data.  

---

## Decisions

- **License choice**: AGPL-3.0 was selected to allow self-hosting while requiring derivative works to share modifications, aligning with the project’s open-source goals and preventing reselling.  
- **Vercel removal**: Decided to eliminate Vercel integration to avoid cloud provider lock-in and simplify deployment options for self-hosting.  
- **Secrets scan tool**: Chose `trufflehog
