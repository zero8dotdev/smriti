---
id: 9028693f-3fb1-47b9-8a2b-a5d6771d5059
category: bug
project: zero8-dev-avkash
agent: claude-code
author: zero8
shared_at: 2026-02-10T17:59:24.766Z
tags: ["bug", "bug/report"]
---

# The session focused on preparing the Avkash project for open-source release b...

> The session focused on preparing the Avkash project for open-source release by implementing standardized documentation, licensing, and security practices. Key actions included rewriting the README, creating a contribution guide, adding a Business Source License 1.1, removing Vercel-specific integrations, and cleaning up committed secrets. These changes ensure the project is accessible, compliant, and secure for open-source collaboration.  

---

## Changes

- **Modified `README.md`**: Updated to include project description, features, tech stack, prerequisites, installation steps, environment variables table, and links to CONTRIBUTING.md/LICENSE.  
- **Created `CONTRIBUTING.md`**: Defined fork/clone process, branch naming conventions, commitlint rules (`type(scope): message`), PR workflow, and pre-commit hooks (husky + lint-staged).  
- **Added `LICENSE`**: Implemented BSL 1.1 with licensor `zero8.dev`, licensed work `Avkash`, and restrictions on reselling.  
- **Removed Vercel integrations**:  
  - Deleted `@vercel/analytics` from `package.json`  
  - Removed `Analytics` import and component from `src/app/layout.tsx`  
  - Deleted `vercel.sh` and removed `.vercel` from `.gitignore`  
- **Cleaned secrets**:  
  - Removed `.env` from git tracking via `git rm --cached .env`  
  - Updated `.gitignore` to explicitly ignore `.env`  
  - Renamed `.env.local.sample` → `.env.example` and stripped real Slack/Razorpay values  
  - Added `data_dump.sql` to `.gitignore`  

---

## Decisions

- **BSL 1.1 License**: Chosen to allow self-hosting for internal use while restricting commercial resale, with a transition to Apache 2.0 after 4 years. This balances permissiveness and control.  
- **Secret Cleanup**: Removed `.env` from git to prevent exposure of real credentials, even though historical commits may still contain them.  
- **Commitlint Rules**: Enforced structured commit messages to improve code review clarity and auditability.  
- **Pre-Commit Hooks**: Integrated husky + lint-staged to automate formatting, linting, and type-checking, ensuring code quality before commits.  

---

## Insights

- **Secret Management**: Committed secrets (e.g., Slack/Razorpay keys) in git history pose a risk, even if rotated. Future steps may require `git filter-repo` to purge historical data.  
- **Build Dependencies**: The `sharp` module caused pre-push build failures, highlighting the need for environment-specific dependency management.  
- **License Strategy**: BSL 1.1 is ideal for projects requiring both open-source flexibility and commercial restrictions, but its complexity demands clear documentation.  
- **Open-Source Readiness**: Standardized documentation and contributor workflows are critical for attracting and onboarding collaborators.  

---

## Context

The project was transitioning from a private to open-source repository, requiring strict adherence to licensing, security, and documentation standards. Constraints included avoiding Vercel-specific dependencies, preventing secret exposure, and
