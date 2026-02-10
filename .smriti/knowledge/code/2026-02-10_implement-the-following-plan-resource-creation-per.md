---
id: 2ecff2c6-8821-4d3f-8f87-66d4bd29a4e1
category: code
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.752Z
tags: ["code", "code/implementation"]
---
# Implement the following plan:  # Resource Creation & Permission-Checked Viewing  ## Goal Add a `reso
**user**: Implement the following plan:

# Resource Creation & Permission-Checked Viewing

## Goal
Add a `resources` table, a `POST` endpoint to create resources (writing FGA tuples automatically), and wire the existing `GET /api/resources/:id` to fetch from the DB with FGA viewer permission checks.

## Files to Modify

### 1. `db.ts`
Add a `resources` table alongside the existing `users` table:
```sql
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```
- `id` is TEXT so we can use human-readable slugs (e.g. `doc1`) matching the FGA object format `resource:<id>`.
- `org_id` is TEXT matching the FGA org format (e.g. `acme`).

### 2. `resource-routes.ts` (new file)
A Hono router with JWT-protected routes:

- **`POST /api/resources`** — Create a resource
  - Body: `{ id, name, orgId }`
  - Requires JWT (`jwtAuth`)
  - Checks the caller is an `admin` of `organization:<orgId>` via FGA (only admins can create resources for their org)
  - Inserts row into `resources` table
  - Writes FGA tuple: `organization:<orgId>` is `owner` of `resource:<id>`
  - Returns `201` with the created resource

- **`GET /api/resources/:id`** — View a resource
  - Requires JWT (`jwtAuth`)
  - Requires FGA `viewer` permission on `resource:<id>` via `requirePermission`
  - Fetches the resource from the DB and returns it

### 3. `index.ts`
- Import and mount `resourceRoutes` at `/api/resources`
- Remove the existing placeholder `app.get("/api/resources/:resourceId", ...)` route (replaced by the new router)

## No changes needed
- `fga.ts` — RBAC model already defines `resource` type with `owner`, `editor`, `viewer`
- `middleware.ts` — `jwtAuth` and `requirePermission` already exist
- `fga-routes.ts` — tuple management API already works
- `auth.ts` — signup/login unchanged

## Verification (end-to-end curl flow)
```bash
# 1. Sign up user A (admin)
TOKEN_A=$(curl -sk -X POST https://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"pass123"}' | jq -r .token)

# 2. Make user A admin of org:acme
curl -sk -X POST https://localhost:3000/api/fga/tuples \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"writes":[{"user":"user:1","relation":"admin","object":"organization:acme"}]}'

# 3. User A creates a resource owned by org:acme
curl -sk -X POST https://localhost:3000/api/resources \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"id":"doc1","name":"Design Doc","orgId":"acme"}'

# 4. Sign up user B (no org membership)
TOKEN_B=$(curl -sk -X POST https://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"viewer@test.com","password":"pass123"}' | jq -r .token)

# 5. User B tries to view resource → 403 (no permission)
curl -sk https://localhost:3000/api/resources/doc1 \
  -H "Authorization: Bearer $TOKEN_B"

# 6. Add user B as member of org:acme
curl -sk -X POST https://localhost:3000/api/fga/tuples \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"writes":[{"user":"user:2","relation":"member","object":"organization:acme"}]}'

# 7. User B views resource → 200 (member → viewer via FGA)
curl -sk https://localhost:3000/api/resources/doc1 \
  -H "Authorization: Bearer $TOKEN_B"
```


If you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: /Users/zero8/.claude/projects/-Users-zero8-zero8-dev-openfga/e479ed40-79cb-4b2a-a959-3e3f85ae7047.jsonl
**assistant**: (no content)
**assistant**: Good, I have full context now. The JWT `sub` is the user's numeric `id`. Let me implement all three changes.
**assistant**: All three changes are done. Here's a summary:

**`db.ts`** — Added the `resources` table with `id` (TEXT PK), `name`, `org_id`, `created_by` (FK to users), and `created_at`.

**`resource-routes.ts`** (new) — Hono router with two JWT-protected routes:
- `POST /` — Validates body (`id`, `name`, `orgId`), checks the caller is an `admin` of `organization:<orgId>` via FGA, inserts the row, writes the FGA ownership tuple (`organization:<orgId>` → `owner` → `resource:<id>`), and returns 201.
- `GET /:id` — Uses the existing `requirePermission("viewer", ...)` middleware, then fetches the resource from the DB (returning 404 if missing).

**`index.ts`** — Imported and mounted `resourceRoutes` at `/api/resources`, removed the old placeholder `GET /api/resources/:resourceId` route, and cleaned up the unused `jwtAuth`/`requirePermission` imports.
**user**: run the verification curl flow
**assistant**: (no content)
**assistant**: Let me start the server first, then run through the verification flow.
**assistant**: Server is running. Now let me run through the verification flow step by step.
**assistant**: All 7 steps passed. Let me kill the background server.
**assistant**: The entire end-to-end verification flow passed:

| Step | Action | Result |
|------|--------|--------|
| 1 | Sign up admin user | Got token (user id 1) |
| 2 | Make user 1 admin of `organization:acme` | `ok: true` |
| 3 | Admin creates `doc1` resource for org acme | **201** — resource created, FGA tuple written |
| 4 | Sign up viewer user | Got token (user id 2) |
| 5 | User 2 tries to view `doc1` (no org membership) | **403** — `"forbidden"` |
| 6 | Add user 2 as member of `organization:acme` | `ok: true` |
| 7 | User 2 views `doc1` again | **200** — full resource returned |

The FGA permission chain works correctly: `organization:acme` owns `resource:doc1`, and org members inherit `viewer` access through the `tupleToUserset` relation defined in the authorization model.
**user**: <task-notification>
<task-id>b4457d6</task-id>
<output-file>/private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b4457d6.output</output-file>
<status>completed</status>
<summary>Background command "Start the server in background" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/b4457d6.output
**assistant**: The background server task completed — it was already shut down after the verification flow finished successfully. No action needed.
**user**: great job! now can we create a way to enable the org admin to create multiple users. and their relationship. an org admin should be able to decide the org levels, users at each level, their role, their department. org admin can create branches and tag the users to their respective branches. 
**assistant**: (no content)
**assistant**: Let me start by reading the existing plan and exploring the codebase to understand what we're building on.
**assistant**: This is a different task — an org management system. Let me explore the current codebase state in parallel.
**assistant**: (no content)
**assistant**: I have a good understanding of the current codebase. Before designing the plan, I need to clarify a few things about the scope of this feature.
**assistant**: Good, that clarifies the design. Let me now design the implementation plan.
**assistant**: 

The plan agent produced a thorough design. Let me review the critical files to validate the approach, then write the final plan.
**assistant**: Good — I've confirmed the FGA client's `.write()` accepts both `writes` and `deletes` in the same call. The plan's approach for role changes (delete old + write new in one call) is correct. Now let me write the final plan.
**assistant**: The plan is ready. Here's a summary of what it covers:

**3 files touched:**
- **`db.ts`** — 4 new tables: `organizations`, `departments`, `branches`, `org_members`
- **`org-routes.ts`** (new) — 14 endpoints for org creation, department/branch CRUD, member management (single + batch create, list, update, delete)
- **`index.ts`** — Mount the new routes at `/api/orgs`

**Key design points:**
- `POST /api/orgs` creates an org and auto-makes the caller admin (FGA tuple + DB row)
- `POST /:orgId/members` creates a user account and assigns them in one step, writing the FGA tuple
- `PATCH /:orgId/members/:userId` handles role changes by swapping FGA tuples (delete old + write new)
- Levels, departments, and branches are pure DB metadata — no FGA model changes
- Batch endpoint for creating multiple users at once
- Deleting a department/branch nullifies references in org_members before removal
**user**: [Request interrupted by user for tool use]
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