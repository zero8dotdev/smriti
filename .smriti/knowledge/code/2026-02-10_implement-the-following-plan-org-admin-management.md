---
id: 44fff7a5-fafb-4939-b032-de20721d57bc
category: code
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.754Z
tags: ["code", "code/implementation"]
---
# Implement the following plan:  # Org Admin Management System  ## Goal Enable org admins to create or
**user**: Implement the following plan:

# Org Admin Management System

## Goal
Enable org admins to create organizations, manage members (create accounts, assign roles/levels/departments/branches), and manage departments and branches — all with FGA permission checks. Levels, departments, and branches are **metadata only** (no FGA model changes).

## Files to Modify

### 1. `db.ts` — Add 4 new tables

Append after the existing `resources` table (order matters for FK references):

```sql
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,              -- slug e.g. 'acme'
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS org_members (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  level INTEGER,                    -- seniority: 1, 2, 3...
  department_id INTEGER REFERENCES departments(id),
  branch_id INTEGER REFERENCES branches(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, user_id)
);
```

### 2. `org-routes.ts` — New file (bulk of the work)

A Hono router mounted at `/api/orgs`. Uses `requirePermission("admin", ...)` for admin-gated routes.

**Organization:**
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST /` | `/api/orgs` | jwtAuth | Create org — creator auto-becomes admin (inserts org row + org_members row + FGA admin tuple) |
| `GET /:orgId` | `/api/orgs/:orgId` | jwtAuth + orgAdmin | Get org details |

**Departments:**
| Method | Path | Description |
|--------|------|-------------|
| `POST /:orgId/departments` | Create department `{ name }` → 201 |
| `GET /:orgId/departments` | List departments |
| `PATCH /:orgId/departments/:deptId` | Update name |
| `DELETE /:orgId/departments/:deptId` | Delete (nullifies refs in org_members first) |

**Branches:**
| Method | Path | Description |
|--------|------|-------------|
| `POST /:orgId/branches` | Create branch `{ name, address? }` → 201 |
| `GET /:orgId/branches` | List branches |
| `PATCH /:orgId/branches/:branchId` | Update name/address |
| `DELETE /:orgId/branches/:branchId` | Delete (nullifies refs in org_members first) |

**Members:**
| Method | Path | Description |
|--------|------|-------------|
| `POST /:orgId/members` | Create single user account + add to org `{ email, password, role?, level?, departmentId?, branchId? }` → 201. Writes FGA tuple `user:<id>` is `<role>` of `organization:<orgId>`. If email already exists, reuses existing user. |
| `POST /:orgId/members/batch` | Batch create `{ members: [...] }` → `{ created, errors }`. Batches FGA writes into one call. |
| `GET /:orgId/members` | List members (JOIN users/departments/branches). Optional query filters: `?role=&department=&branch=` |
| `GET /:orgId/members/:userId` | Get single member detail |
| `PATCH /:orgId/members/:userId` | Update metadata. If `role` changes: delete old FGA tuple + write new one in single `.write()` call |
| `DELETE /:orgId/members/:userId` | Remove from org + delete FGA tuple |

All department/branch/member routes require `jwtAuth` + `requirePermission("admin", ...)`.

### 3. `index.ts` — Mount new routes

```typescript
import orgRoutes from "./org-routes";
app.route("/api/orgs", orgRoutes);
```

## No changes needed
- `fga.ts` — Model already has `organization` with `admin`/`member` relations
- `middleware.ts` — `requirePermission` already works for this
- `auth.ts` — Existing signup/login unchanged
- `resource-routes.ts` — Unchanged
- `fga-routes.ts` — Unchanged

## FGA Tuple Lifecycle

| Action | FGA Write | FGA Delete |
|--------|-----------|------------|
| Create org | `user:<creator>` admin `organization:<id>` | — |
| Add member (role=member) | `user:<id>` member `organization:<orgId>` | — |
| Add member (role=admin) | `user:<id>` admin `organization:<orgId>` | — |
| Change role member→admin | write admin | delete member |
| Change role admin→member | write member | delete admin |
| Remove member | — | delete `<current_role>` |

## Verification (end-to-end curl flow)

```bash
# 1. Sign up org creator
TOKEN=$(curl -sk -X POST https://localhost:3000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.com","password":"secret123"}' | jq -r .token)

# 2. Create organization (creator auto-becomes admin)
curl -sk -X POST https://localhost:3000/api/orgs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"acme","name":"Acme Corp"}'

# 3. Create a department
curl -sk -X POST https://localhost:3000/api/orgs/acme/departments \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Engineering"}'

# 4. Create a branch
curl -sk -X POST https://localhost:3000/api/orgs/acme/branches \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"HQ","address":"123 Main St"}'

# 5. Create single member (L2 engineer at HQ)
curl -sk -X POST https://localhost:3000/api/orgs/acme/members \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@acme.com","password":"pass123","role":"member","level":2,"departmentId":1,"branchId":1}'

# 6. Batch create members
curl -sk -X POST https://localhost:3000/api/orgs/acme/members/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"members":[
    {"email":"bob@acme.com","password":"pass123","role":"member","level":1,"departmentId":1},
    {"email":"carol@acme.com","password":"pass123","role":"admin","level":3}
  ]}'

# 7. List members
curl -sk https://localhost:3000/api/orgs/acme/members \
  -H "Authorization: Bearer $TOKEN"

# 8. Promote Alice to admin
curl -sk -X PATCH https://localhost:3000/api/orgs/acme/members/2 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role":"admin","level":3}'

# 9. Alice (now admin) can create resources
ALICE_TOKEN=$(curl -sk -X POST https://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@acme.com","password":"pass123"}' | jq -r .token)

curl -sk -X POST https://localhost:3000/api/resources \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"doc-1","name":"Design Doc","orgId":"acme"}'
# => 201

# 10. Bob (member) can view resource but not create
BOB_TOKEN=$(curl -sk -X POST https://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"bob@acme.com","password":"pass123"}' | jq -r .token)

curl -sk https://localhost:3000/api/resources/doc-1 \
  -H "Authorization: Bearer $BOB_TOKEN"
# => 200

# 11. Remove Bob, verify he loses access
curl -sk -X DELETE https://localhost:3000/api/orgs/acme/members/3 \
  -H "Authorization: Bearer $TOKEN"

curl -sk https://localhost:3000/api/resources/doc-1 \
  -H "Authorization: Bearer $BOB_TOKEN"
# => 403
```


If you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: /Users/zero8/.claude/projects/-Users-zero8-zero8-dev-openfga/94d5d582-f9d5-481f-bc59-42291c79f8a8.jsonl
**assistant**: (no content)
**assistant**: Now I have a full picture of the codebase. Let me start implementing.
**assistant**: Now creating the org-routes.ts file with all the routes.
**assistant**: Let me verify the files compile and check the final state.
**assistant**: Type-checking passes cleanly. Here's a summary of what was implemented:

### Changes made

**`db.ts`** — Added 4 new tables after `resources`:
- `organizations` — org id (slug) + name
- `departments` — per-org departments with unique name constraint
- `branches` — per-org branches with optional address
- `org_members` — links users to orgs with role, level, department, and branch metadata

**`org-routes.ts`** — New Hono router with 14 endpoints:
- **Org**: `POST /` (create org, creator auto-becomes admin with FGA tuple), `GET /:orgId` (admin-gated)
- **Departments**: CRUD at `/:orgId/departments` — create, list, patch name, delete (nullifies member refs first)
- **Branches**: CRUD at `/:orgId/branches` — create, list, patch name/address, delete (nullifies member refs first)
- **Members**: `POST /:orgId/members` (single), `POST /:orgId/members/batch`, `GET /:orgId/members` (with `?role=&department=&branch=` filters), `GET /:orgId/members/:userId`, `PATCH /:orgId/members/:userId` (role change swaps FGA tuples in one call), `DELETE /:orgId/members/:userId` (removes FGA tuple)

All admin routes use `jwtAuth` + `requirePermission("admin", ...)`. Existing user accounts are reused when email already exists.

**`index.ts`** — Mounted `orgRoutes` at `/api/orgs`.
**user**: run it and test with the curl commands
**assistant**: (no content)
**assistant**: Server is running. Now let me run through the curl test flow.
**assistant**: All 4 members listed with joined department/branch names. Now the critical FGA permission tests.
**assistant**: Alice (promoted to admin) successfully created a resource. Now test Bob (member) can view it.
**assistant**: Bob (member) can view the resource via FGA's `member -> viewer` chain. Now the final test: remove Bob and verify access is revoked.
**assistant**: All 11 steps pass.
**assistant**: All 11 end-to-end tests passed:

| Step | Test | Result |
|------|------|--------|
| 1 | Sign up org creator | 201 - token returned |
| 2 | Create organization | 201 - `acme` created, creator auto-admin |
| 3 | Create department | 201 - `Engineering` (id=1) |
| 4 | Create branch | 201 - `HQ` (id=1) |
| 5 | Create single member (Alice) | 201 - member with level=2, dept=Engineering, branch=HQ |
| 6 | Batch create (Bob + Carol) | 201 - 2 created, 0 errors |
| 7 | List members | 4 members with joined dept/branch names |
| 8 | Promote Alice to admin | FGA tuple swapped (member deleted, admin written) |
| 9 | Alice creates resource | 201 - admin permission confirmed via FGA |
| 10 | Bob views resource | 200 - member has viewer access via FGA chain |
| 11 | Remove Bob, re-check | `deleted: true` then **403 forbidden** - access revoked |

The full FGA permission lifecycle works: create org -> assign roles -> role changes swap tuples -> removal deletes tuples and revokes access.
**user**: <task-notification>
<task-id>b5779bc</task-id>
<output-file>/private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b5779bc.output</output-file>
<status>failed</status>
<summary>Background command "Start the server" failed with exit code 137</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b5779bc.output
**assistant**: That's just the server process being terminated by the `KillShell` command I ran after all tests completed (exit code 137 = SIGKILL). Everything worked correctly — all 11 curl tests passed before I killed the server.
**user**: now make this above tabluar example in a way that show decent indian size business enteties. like a showroom owner who has multiple showroom. and have some department, which are not assigned to any particular showroom, but their are department, who just are bound to that showroom. and there are different actions, (for now you can say some action, like marking attandance) and demonestrate the flow for a business man. 
**assistant**: (no content)
**assistant**: Let me build a realistic Indian business demo script for this.
**user**: [Request interrupted by user for tool use]
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