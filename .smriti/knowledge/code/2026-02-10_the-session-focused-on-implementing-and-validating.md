---
id: 44fff7a5-fafb-4939-b032-de20721d57bc
category: code
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T18:07:35.557Z
tags: ["code", "code/implementation"]
---

# The session focused on implementing and validating an access control system f...

> The session focused on implementing and validating an access control system for Sharma Auto using FGA (Flexible Graph Access Control) and a demo script to ensure end-to-end functionality. Key outcomes included resolving stale data conflicts, automating cleanup for repeatable demos, and debating architectural choices for role-based permissions. The demo script now ensures a clean slate on each run, and the team evaluated two approaches for authorization: maintaining a simple FGA model with app-level checks or expanding FGA with scoped relations.  

---

## Changes

- **Files created/modified**:  
  - `demo-sharma-auto.sh` (initial commit, handles database truncation, FGA store deletion, and demo execution)  
  - Added cleanup trap to stop the server process after demo completion  
- **Features added**:  
  - Automated cleanup of database tables (`users`, `orgs`, `departments`, `branches`, `members`, `resources`)  
  - Deletion of OpenFGA stores to prevent stale tuples from interfering with demos  
  - Server restart logic to ensure a fresh FGA store on each run  
- **Bugs fixed**:  
  - Resolved 500 errors caused by lingering FGA tuples from previous demo runs  
  - Fixed 409 conflicts by truncating the database before rerunning the demo  

---

## Decisions

- **Approach A (simple FGA + app-level checks)**:  
  - Chosen for immediate implementation due to its simplicity and alignment with the current FGA model.  
  - Rationale: Avoids overcomplicating the FGA model while allowing gradual integration of role-based logic.  
- **Cleanup automation**:  
  - Decided to truncate all database tables and delete FGA stores on each demo run to ensure isolation.  
  - Rationale: Prevents data contamination between demo iterations and ensures consistent testing.  
- **Server process management**:  
  - Added a trap to stop the server process after the demo completes to avoid orphaned processes.  
  - Rationale: Ensures resource cleanup and prevents accidental interference with other workflows.  

---

## Insights

- **FGA model limitations**: The current flat model (`admin`/`member`) lacks granularity for role-based access (e.g., branch managers, HR admins). Expanding FGA with scoped relations (e.g., `branch_manager`, `hr_admin`) would centralize authorization logic but requires careful migration.  
- **Stale data risks**: FGA tuples persist across runs, leading to conflicts unless explicitly cleaned. Database truncation alone is insufficient; FGA stores must also be reset.  
- **Phased implementation**: The team opted for a hybrid approach, using app-level checks for immediate needs while planning a future FGA model expansion. This avoids over-engineering while keeping the door open for future enhancements.  

---

## Context

- **Existing state**: FGA model is flat, with `admin` and `member` roles. The `level` field in `org_members` is unused for authorization.  
- **Constraints**:  
  - Demo
