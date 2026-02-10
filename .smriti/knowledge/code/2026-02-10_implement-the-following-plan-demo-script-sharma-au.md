---
id: e96025a3-0459-4eae-964c-74dd8c004e1c
category: code
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.756Z
tags: ["code", "code/implementation"]
---
# Implement the following plan:  # Demo Script: Sharma Auto — Indian Multi-Showroom Business  ## Scena
**user**: Implement the following plan:

# Demo Script: Sharma Auto — Indian Multi-Showroom Business

## Scenario

**Sharma Auto** — A car dealership chain in Delhi NCR owned by Rajesh Sharma.

### Business Structure

**Showrooms (Branches):**
| # | Name | Address |
|---|------|---------|
| 1 | Karol Bagh Showroom | 14/2, Pusa Road, Karol Bagh, New Delhi 110005 |
| 2 | Noida Showroom | Plot 7, Sector 18, Noida, UP 201301 |
| 3 | Gurugram Showroom | SCO 45, MG Road, Gurugram, Haryana 122001 |

**Departments:**
| # | Name | Showroom-bound? |
|---|------|-----------------|
| 1 | Sales | Yes — staff assigned per-showroom |
| 2 | Service | Yes — staff assigned per-showroom |
| 3 | Accounts | No — central team, no branch |
| 4 | HR | No — central team |
| 5 | Marketing | No — central team |

**Staff (Indian names, realistic roles):**
| Name | Email | Role | Level | Dept | Branch |
|------|-------|------|-------|------|--------|
| Rajesh Sharma | rajesh@sharmaauto.in | admin (owner) | 5 | — | — |
| Priya Mehta | priya@sharmaauto.in | admin | 4 | HR | — (central) |
| Amit Kumar | amit@sharmaauto.in | admin | 4 | Sales | Karol Bagh (showroom mgr) |
| Sunita Verma | sunita@sharmaauto.in | member | 3 | Accounts | — (central) |
| Ravi Singh | ravi@sharmaauto.in | member | 1 | Sales | Karol Bagh |
| Deepak Yadav | deepak@sharmaauto.in | member | 1 | Sales | Noida |
| Neha Gupta | neha@sharmaauto.in | member | 2 | Service | Gurugram |
| Manoj Tiwari | manoj@sharmaauto.in | member | 1 | Marketing | — (central) |

### Demo Flow (12 steps)

1. **Owner signs up** — Rajesh creates his account
2. **Creates org** — `sharma-auto` / "Sharma Auto Pvt Ltd"
3. **Sets up departments** — Sales, Service, Accounts, HR, Marketing
4. **Sets up showrooms** — 3 branches with real Delhi NCR addresses
5. **Batch-creates staff** — All 7 employees in one call (with dept/branch assignments)
6. **Lists all staff** — Shows the full org with joined dept/branch names
7. **Filters by department** — `?department=Sales` to see only sales team
8. **Amit (showroom mgr) creates attendance register** — Resource `attendance-kb-feb2026` for Karol Bagh
9. **Ravi (sales exec, member) views attendance** — 200 OK via FGA member→viewer chain
10. **Ravi tries to create a resource** — 403 (members can't create)
11. **Transfer Deepak** from Noida → Karol Bagh showroom — PATCH branch
12. **Terminate Ravi** — DELETE from org → verify 403 on resource access

### File to Create

- `demo-sharma-auto.sh` — Self-contained bash script with colored output, step labels, pass/fail indicators

### No code changes needed
The existing `db.ts`, `org-routes.ts`, `resource-routes.ts`, `index.ts` all remain unchanged.

### Verification
Run: `bun run index.ts &` then `bash demo-sharma-auto.sh`


If you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: /Users/zero8/.claude/projects/-Users-zero8-zero8-dev-openfga/2ecff2c6-8821-4d3f-8f87-66d4bd29a4e1.jsonl
**assistant**: (no content)
**assistant**: The script is ready at `demo-sharma-auto.sh`. Here's what it does across the 12 steps:

| Step | Action | Validation |
|------|--------|------------|
| 1 | Rajesh signs up | HTTP 201, captures JWT |
| 2 | Creates `sharma-auto` org | HTTP 201 |
| 3 | Creates 5 departments | HTTP 201 each, captures IDs |
| 4 | Creates 3 showroom branches | HTTP 201 each, captures IDs |
| 5 | Batch-creates 7 staff with dept/branch assignments | HTTP 201, captures user IDs |
| 6 | Lists all staff | HTTP 200, prints formatted table |
| 7 | Filters `?department=Sales` | HTTP 200, shows sales team only |
| 8 | Amit logs in & creates `attendance-kb-feb2026` resource | HTTP 201 |
| 9 | Ravi logs in & views attendance | HTTP 200 (member→viewer FGA chain) |
| 10 | Ravi tries to create a resource | HTTP 403 (members can't create) |
| 11 | Transfer Deepak from Noida → Karol Bagh | HTTP 200, verifies new branch |
| 12 | Terminate Ravi, verify 403 on resource access | HTTP 200 delete, HTTP 403 on view |

To run it:

```bash
bun run index.ts &
bash demo-sharma-auto.sh
```
**user**: for validation text, change it to something, which a business person can understand. 
**assistant**: (no content)
**assistant**: Now I'll update all the technical jargon throughout the script to business-friendly language.
**assistant**: Now update all the step titles and check_status labels to business-friendly language:
**assistant**: Now update the summary section at the end:
**assistant**: Also update the script header comment:
**assistant**: Done. Here's what changed — all technical jargon replaced with business language:

| Before (technical) | After (business-friendly) |
|---|---|
| `PASS` / `FAIL` | `Done` / `Failed` |
| `HTTP 201`, `HTTP 403` | Hidden from output |
| `Org created` | `Company 'Sharma Auto Pvt Ltd' registered` |
| `Batch member creation` | `All employees onboarded` |
| `List all members` | `Staff directory loaded` |
| `Filter members by Sales dept` | `Sales team filtered` |
| `Amit created attendance resource` | `Attendance register created — managers can create company documents` |
| `Ravi can VIEW attendance (member→viewer)` | `Ravi can view the attendance register — employees get read access automatically` |
| `Ravi DENIED resource creation` | `Ravi was blocked — regular employees cannot create company documents` |
| `Ravi DENIED access after termination` | `Ravi is blocked — ex-employees lose access to all company documents instantly` |
| `FGA chain: member of sharma-auto → viewer of...` | `Any employee of Sharma Auto can view company documents` |
| `FGA tuples removed` | `Once an employee leaves, they can no longer see anything in the system` |
| `FGA verified:` summary with technical terms | `Access Control — What was demonstrated:` with plain English |
**user**: run it and show me the output
**assistant**: Server is up. Running the demo script now.
**assistant**: All 12 steps passed. The output now reads in plain business language — no HTTP codes, no FGA jargon, no technical IDs. Every line tells a business person what happened and why it matters.
**user**: <task-notification>
<task-id>b11a330</task-id>
<output-file>/private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b11a330.output</output-file>
<status>completed</status>
<summary>Background command "Start the server in background" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b11a330.output
**assistant**: 

The server process that was running in the background has exited (it completed after the demo finished). Nothing to worry about — the demo already ran successfully with all 12 steps passing.
**user**: commit this
**assistant**: This directory isn't a git repository yet. Let me initialize one first.
**assistant**: This is a fresh repo with all project files untracked. I'll commit just the demo script since that's what we created, or would you prefer an initial commit with everything? Since you said "commit this" referring to the demo script, I'll add only that file.
**assistant**: Committed as `65c43a9` — `demo-sharma-auto.sh` is the initial commit on `main`. The rest of the project files remain untracked.
**user**: can you run the demo
**assistant**: The demo failed at Step 1 because Rajesh's account already exists from the previous run (409 conflict). The database still has the data from earlier. I need to clean the database first so the demo starts fresh.
**assistant**: Database cleared. Running the demo again.
**assistant**: Step 8 failed — the resource creation returned 500. Let me check the server logs.
**assistant**: That worked. The issue is likely the old `attendance-kb-feb2026` resource still exists in OpenFGA from the prior run. The database was truncated but the FGA tuples weren't cleaned. Let me check and clean up, then also look at the resource table.
**assistant**: The resource is in the DB already from this run — so the DB insert succeeded but the FGA tuple write after it failed (causing the 500). The old FGA tuples from the previous run are conflicting. Let me do a full clean — both the database and the FGA store.
**assistant**: The FGA store persists across runs. I need to delete the old store so it starts clean. Let me delete it via the OpenFGA API, then restart the server.
**assistant**: Now restart the server so it creates a fresh FGA store.
**assistant**: All 12 steps passed cleanly. The earlier failure was because stale data from the previous run was still in the database and OpenFGA store — once both were reset, the demo ran end-to-end without issues.
**user**: <task-notification>
<task-id>b93417b</task-id>
<output-file>/private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b93417b.output</output-file>
<status>completed</status>
<summary>Background command "Start the server in background" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b93417b.output
**assistant**: 

The background server process exited — that's fine, the demo already completed successfully.
**user**: <task-notification>
<task-id>b43f19b</task-id>
<output-file>/private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b43f19b.output</output-file>
<status>completed</status>
<summary>Background command "Start fresh server" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b43f19b.output
**assistant**: 

Same — the second server instance also exited after the demo finished. Nothing to act on.
**user**: you can fresh start by cleaning all the data. 
**assistant**: (no content)
**assistant**: I'll add a cleanup step at the top of the demo script that resets both the database and the OpenFGA store before running.
**assistant**: Now add a cleanup trap at the end to stop the server when the demo finishes:
**assistant**: Now let's run it to verify it works end-to-end from a dirty state.
**assistant**: All 12 steps passed. The script now handles everything automatically on each run:

1. **Truncates all database tables** (users, orgs, departments, branches, members, resources)
2. **Deletes all OpenFGA stores** so permission tuples start clean
3. **Restarts the server** so it creates a fresh FGA store
4. Then runs the full 12-step demo

You can run `bash demo-sharma-auto.sh` as many times as you want — it always starts from a clean slate.
**user**: bash demo
**assistant**: All 12 steps passed, clean run from scratch.
**user**: i dont see the output in the terminal. the table
**assistant**: (no content)
**assistant**: The table is generated by a `python3` block that pipes into `2>/dev/null`, so any error would be silently swallowed. Let me test just that section to see what's happening on your system.
**user**: [Request interrupted by user for tool use]
**user**: can you proceed further. 
**assistant**: (no content)
**assistant**: This is a different task — a new feature for attendance marking with deputations. Let me explore the current codebase to understand what needs to change.
**assistant**: Good, I have a thorough understanding of the codebase. Now let me design the implementation.
**assistant**: You've hit your limit · resets 6:30pm (Asia/Calcutta)
**user**: can you answer my previous plan question?
**assistant**: (no content)
**assistant**: This is a great architectural question. Let me think through it in the context of Sharma Auto.

## The Problem

Right now the FGA model is **flat** — there's just `admin` and `member` on an organization. Any admin can do everything: hire/fire staff, create deputations, manage resources. But in reality:

- **Rajesh** (owner, level 5) — should control everything
- **Priya** (HR, level 4) — should manage staff, not financial documents
- **Amit** (showroom mgr, level 4) — should manage *his* showroom's staff, not other showrooms

The `level` field already exists in `org_members` but is **decorative** — FGA doesn't know about it.

## Two Approaches

### Approach A: Keep FGA simple, enforce levels in application code

The FGA model stays as-is (`admin`/`member`). The application code checks `level` before allowing sensitive operations:

```
Can this admin create a deputation?
  → FGA says: yes, they're an admin
  → App code says: but their level is 3, need level 4+ to depute staff
  → Result: denied
```

**Pros**: Simple FGA model, fast to implement, levels are easy to tweak in DB.
**Cons**: Authorization logic is split between FGA and application code. Two sources of truth.

### Approach B: Encode authority into FGA with scoped relations

Expand the FGA model so different actions have different relations:

```
type organization {
  owner          — can do anything (Rajesh)
  admin          — can manage staff, resources
  branch_manager — can manage staff within their branch
  member         — regular employee
}

type branch {
  parent_org     — links branch to org
  manager        — can depute/manage within this branch
}

type deputation {
  creator        — who can create deputations
}
```

Now Amit gets `manager` on `branch:karol-bagh` specifically, not blanket admin power. Priya gets a relation on the HR domain but not on branches.

**Pros**: Single source of truth for all authorization. FGA handles everything.
**Cons**: More complex model, more tuples to manage, model changes require careful migration.

## Who Controls What — The Delegation Chain

In a real Indian business hierarchy:

```
Rajesh (owner, L5)
  ├── Can change the authorization model itself
  ├── Can grant/revoke admin access
  └── Can do anything

Priya (HR admin, L4)
  ├── Can hire/fire staff (add/remove members)
  ├── Can change department assignments
  ├── Cannot manage showroom operations
  └── Cannot change who else is an admin

Amit (showroom mgr, L4)
  ├── Can manage staff within Karol Bagh only
  ├── Can create deputations for his branch staff
  ├── Can create resources for his branch
  └── Cannot manage other showrooms

Sunita (accounts, L3)
  ├── Can view financial resources
  └── Cannot manage staff or branches
```

The key insight: **the ability to grant permissions is itself a permission**. Rajesh can make someone an admin. Priya can onboard staff. Amit can manage his branch. But none of them should be able to elevate themselves above their level.

## My Recommendation for This Stage

Given where the project is right now, I'd suggest **Approach A with a clear path to B**:

1. Keep FGA model as-is for now
2. Add `level` checks in application code for sensitive operations (deputation creation requires level >= 4, hiring requires admin role, etc.)
3. Use the `branch_id` on `org_members` to scope branch managers — Amit can only depute/manage staff who share his branch
4. Later, when the model stabilizes, migrate the level/scope logic into FGA relations

This avoids over-engineering the FGA model before the business rules are fully settled.
**assistant**: Good choice. Let me design the full FGA model expansion. I need to think carefully about the `branch` type and how `can_manage` composes with the existing model.
**assistant**: Now I have a complete picture. Let me write the plan.
**user**: [Request interrupted by user for tool use]
**user**: Implement the following plan:

# Attendance & Deputation with Full FGA Authorization Model

## What's Changing

Add attendance marking and deputation (temporary branch assignment) with **branch-scoped permissions in FGA** — not application-level hacks.

---

## 1. Expanded FGA Authorization Model

### Current model (flat)
```
user
organization  → admin, member
resource      → owner, editor, viewer
```

### New model (branch-scoped)
```
user
organization  → admin, member          (unchanged)
branch        → parent, manager, can_manage   (NEW)
resource      → owner, editor, viewer  (unchanged)
```

### New type: `branch`

| Relation | Type | Who gets it | Meaning |
|----------|------|-------------|---------|
| `parent` | direct | `organization:sharma-auto` | Links branch to its org |
| `manager` | direct | `user:amit` (for Karol Bagh) | Showroom manager |
| `can_manage` | computed | managers + org admins | Who can create deputations, manage branch staff |

**`can_manage` resolves as:**
- Anyone with `manager` on this branch, OR
- Anyone with `admin` on the parent organization

This means:
- **Rajesh** (org admin) → `can_manage` on ALL branches via parent→admin
- **Amit** (branch manager) → `can_manage` on Karol Bagh ONLY via direct `manager`
- **Ravi** (member) → NO `can_manage` anywhere

### FGA type definition for `branch`
```typescript
{
  type: "branch",
  relations: {
    parent: { this: {} },
    manager: { this: {} },
    can_manage: {
      union: {
        child: [
          { computedUserset: { relation: "manager" } },
          { tupleToUserset: {
              tupleset: { relation: "parent" },
              computedUserset: { relation: "admin" }
          }},
        ],
      },
    },
  },
  metadata: {
    relations: {
      parent:  { directly_related_user_types: [{ type: "organization" }] },
      manager: { directly_related_user_types: [{ type: "user" }] },
    },
  },
}
```

### When tuples are written

| Event | Tuple written |
|-------|---------------|
| Branch created | `organization:sharma-auto` → `parent` → `branch:{id}` |
| Admin member assigned to a branch | `user:{id}` → `manager` → `branch:{branchId}` |
| Admin member's branch changed | Delete old manager tuple, write new one |
| Admin member removed from org | Delete manager tuple if they had a branch |

---

## 2. New Database Tables

### `deputations`
```sql
CREATE TABLE IF NOT EXISTS deputations (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT valid_deputation_window CHECK (end_time > start_time)
)
```

### `attendance`
```sql
CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  check_in TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'half-day')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, user_id, date)
)
```

---

## 3. New API Routes (`attendance-routes.ts`)

| Method | Path | Who can call | FGA check |
|--------|------|-------------|-----------|
| `POST` | `/:orgId/attendance` | Any org member (marks own) | DB membership check |
| `GET` | `/:orgId/attendance` | Admin = all, member = own | FGA admin check |
| `POST` | `/:orgId/deputations` | Branch manager or org admin | `can_manage` on branch |
| `GET` | `/:orgId/deputations` | Org admin | FGA admin check |
| `DELETE` | `/:orgId/deputations/:id` | Org admin | FGA admin check |

### Core logic: `getEffectiveBranch(orgId, userId)`

```
1. SELECT from deputations WHERE user_id AND start_time <= now() AND end_time > now()
2. If found → return deputation branch (isDeputation: true)
3. Else → return home branch from org_members (isDeputation: false)
```

### Deputation creation permission check

```typescript
// The deputation targets a branch — check can_manage on THAT branch
requirePermission("can_manage", (c) => {
  const branchId = /* from request body */;
  return `branch:${branchId}`;
})
```

This means Amit can create deputations for employees going TO his branch (Karol Bagh), and Rajesh can create deputations for any branch.

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `fga.ts` | Add `branch` type definition to the authorization model |
| `db.ts` | Add `deputations` and `attendance` table creation |
| `attendance-routes.ts` | **New file** — 5 routes for attendance + deputation |
| `org-routes.ts` | Write `parent` tuple on branch creation; write/update `manager` tuple on admin member creation/update; delete `manager` tuple on member removal |
| `index.ts` | Mount `attendanceRoutes` at `/api/orgs` |
| `demo-sharma-auto.sh` | Add 5 new demo steps (12-16), update TRUNCATE, shift termination to step 17 |

---

## 5. Changes to Existing Routes in `org-routes.ts`

### Branch creation (line 116-130) — add FGA tuple
After inserting the branch in DB, write:
```typescript
await getFgaClient().write({
  writes: [
    { user: `organization:${orgId}`, relation: "parent", object: `branch:${branch.id}` },
  ],
});
```

### Single member creation (line 194-233) — add manager tuple
After the existing FGA write, if `role === "admin" && body.branchId`:
```typescript
await getFgaClient().write({
  writes: [
    { user: `user:${userId}`, relation: "manager", object: `branch:${body.branchId}` },
  ],
});
```

### Batch member creation (line 237-293) — add manager tuples
Inside the loop, if `role === "admin" && m.branchId`, add to fgaWrites:
```typescript
fgaWrites.push({ user: `user:${userId}`, relation: "manager", object: `branch:${m.branchId}` });
```

### Member update (line 443-492) — swap manager tuples on branch/role change
If admin's branch changed, or role changed between admin/member:
- Delete old `manager` tuple (if was admin with a branch)
- Write new `manager` tuple (if now admin with a branch)

### Member deletion (line 496-517) — delete manager tuple
If deleted member was admin with a branch:
```typescript
if (existing.role === "admin" && existing.branch_id) {
  // Add to deletes: manager tuple for the branch
}
```

---

## 6. Updated Demo Script Steps

Steps 1-11 remain the same. New steps inserted before the termination step:

| Step | Action | Validates |
|------|--------|-----------|
| 12 | Rajesh deputes Deepak to Gurugram (7-day window) | Org admin can manage any branch |
| 13 | Deepak marks attendance → recorded at Gurugram | Deputation overrides home branch |
| 14 | Ravi marks attendance → recorded at Karol Bagh | No deputation → home branch |
| 15 | Admin views attendance filtered by branch | Admin sees all records |
| 16 | Cancel deputation, verify 0 active | Reverts to home branch |
| 17 | Terminate Ravi → verify 403 | (existing step 12, renumbered) |

Update TRUNCATE to include `attendance, deputations`.
Update final summary: "All 17 steps completed".

---

## 7. Verification

```bash
bash demo-sharma-auto.sh
```

Checks:
- Branch manager (Amit) can manage his branch via FGA `can_manage`
- Org admin (Rajesh) can manage any branch via FGA `parent→admin`
- Member (Ravi) cannot create deputations (403 via FGA)
- Attendance auto-routes to deputation branch when active
- Attendance falls back to home branch when no deputation
- All 17 steps pass


If you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: /Users/zero8/.claude/projects/-Users-zero8-zero8-dev-openfga/44fff7a5-fafb-4939-b032-de20721d57bc.jsonl
**assistant**: (no content)
**assistant**: Let me read the key files I need to modify.
**assistant**: Now I have a full understanding of the codebase. Let me start implementing.
**assistant**: **Step 1: Update FGA model with `branch` type.**
**assistant**: **Step 2: Add `deputations` and `attendance` tables in db.ts.**
**assistant**: **Step 3: Create `attendance-routes.ts`.**
**assistant**: **Step 4: Update branch creation in org-routes.ts to write `parent` FGA tuple.**
**assistant**: **Step 5: Update single member creation to write `manager` tuple for admins with branches.**
**assistant**: **Step 6: Update batch member creation to write `manager` tuples.**
**assistant**: **Step 7: Update member update (PATCH) to swap manager tuples on branch/role change.**

Let me re-read the relevant section of org-routes.ts to see the current state after edits.
**assistant**: **Step 8: Update member deletion to remove `manager` tuple.**
**assistant**: **Step 9: Mount attendance routes in index.ts.**
**assistant**: **Step 10: Update the demo script.** I need to:
1. Update the TRUNCATE to include `attendance, deputations`
2. Add steps 12-16 (deputation & attendance)
3. Renumber old step 12 (terminate Ravi) to step 17
4. Update the final summary
**assistant**: Now replace everything from Step 12 (terminate Ravi) onwards with steps 12-17 and new summary.
**assistant**: All code changes are done. Let me run the demo script to test.
**assistant**: The demo script failed because PostgreSQL isn't running. Let me check what services need to be started.
**assistant**: Services are running but OpenFGA shows "unhealthy". Let me restart it and try.
**assistant**: Good, both services are healthy now. Let me also check the database is reachable and then run the demo.
**assistant**: The TRUNCATE is failing because the new tables (`attendance`, `deputations`) don't exist yet in the database. The tables are only created when the server starts (in `db.ts`). Let me fix the TRUNCATE to handle this gracefully.
**assistant**: The `attendance` and `deputations` tables don't exist yet. The demo script truncates tables before starting the server, but these tables are only created at server startup. I need to make the truncate handle missing tables gracefully.
**assistant**: All 17 steps passed. Let me mark the task as complete.
**assistant**: All 17 steps pass. Here's a summary of what was implemented:

### Files modified

| File | Change |
|------|--------|
| `fga.ts` | Added `branch` type with `parent`, `manager`, and computed `can_manage` relations |
| `db.ts` | Added `deputations` and `attendance` table creation |
| `attendance-routes.ts` | **New** — 5 routes: mark attendance, view attendance, create/list/delete deputations |
| `org-routes.ts` | Branch creation writes `parent` tuple; member create/batch/update/delete manage `manager` tuples |
| `index.ts` | Mounted `attendanceRoutes` at `/api/orgs` |
| `demo-sharma-auto.sh` | Added steps 12-16, renumbered termination to 17, updated TRUNCATE and summary |

### FGA authorization model

The `branch` type resolves `can_manage` as:
- Direct `manager` on the branch, OR
- `admin` on the branch's parent `organization` (via `tupleToUserset`)

This means org admins (Rajesh) can manage all branches, while branch managers (Amit) can only manage their assigned branch — enforced entirely through FGA, not application logic.

### New demo steps (12-16)
- **12**: Rajesh deputes Deepak to Gurugram (org admin manages any branch via FGA)
- **13**: Deepak's attendance routes to Gurugram (deputation overrides home branch)
- **14**: Ravi's attendance routes to Karol Bagh (no deputation = home branch)
- **15**: Admin views all attendance records with branch info
- **16**: Cancel deputation, verify 0 active deputations remain