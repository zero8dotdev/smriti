---
id: fd956621-8cae-423b-8b42-3c397d5a9434
category: code
project: zero8-dev-avkash
agent: claude-code
author: zero8
shared_at: 2026-02-10T18:00:23.758Z
tags: ["code", "code/review"]
---

# This session focused on transitioning a project to an open-source model by sc...

> This session focused on transitioning a project to an open-source model by scrubbing sensitive secrets from history, enforcing branch protection rules, and implementing a restrictive BSL 1.1 license to prevent commercial competition. Key actions included force-pushing branches, updating documentation, and ensuring compliance with GitHub's repository governance.  

---

## Changes

- **Force-pushed 58 branches** and created 10 new ones, scrubbing `.env` and `.env.local.sample` from all histories using `git filter-branch`  
- **Removed `.env` from `.gitignore`** and added it to `.gitignore` to prevent future tracking  
- **Created LICENSE file** with BSL 1.1 terms, committed to `main` after resolving merge conflicts with PR #253  
- **Updated README.md** to explicitly mention BSL 1.1 license and expanded its description for clarity  
- **Added 13 topics** to the repo: `hr`, `leave-management`, `nextjs`, `supabase`, `slack`, `react`, `typescript`, `tailwindcss`, `ant-design`, `open-source`, `india`, `hr-management`, `employee-management`  
- **Re-enabled branch protection** on `main` with:  
  - 1 approving review required  
  - Force pushes blocked  
  - Branch deletion blocked  
- **Updated repository description** to:  
  `"India's open-source HR platform — leave management, team policies, and Slack integration for modern workplaces."`  
- **Set website URL** to `https://avkash.zero8.dev`  

---

## Decisions

- **BSL 1.1 license**: Chosen to restrict commercial use in competing HR management products while allowing open-source adoption.  
- **Scrub secrets from history**: Used `git filter-branch` to remove `.env` and `.env.local.sample` from all branches to prevent credential exposure.  
- **Re-enable branch protection**: Prioritized security over convenience to prevent accidental force-pushes to `main`.  
- **License file placement**: Committed to `main` after resolving merge conflicts to ensure visibility on GitHub.  

---

## Insights

- **Scrubbing secrets** is critical for open-source projects; `git filter-branch` is a reliable tool but requires careful execution.  
- **Branch protection rules** on GitHub are enforced at the repo/organization level and cannot be bypassed without temporary disabling.  
- **BSL 1.1 complexity**: Requires precise wording to balance open-source freedom with commercial restrictions.  
- **License visibility**: Must be explicitly committed to `main` to appear in repository metadata, not just PRs.  

---

## Context

- **Prior state**:
