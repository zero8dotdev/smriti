---
id: 94d5d582-f9d5-481f-bc59-42291c79f8a8
category: project
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.749Z
tags: ["project", "project/setup"]
---
# Implement the following plan:  # OpenFGA Integration Plan  ## Overview Integrate OpenFGA into the ex
**user**: Implement the following plan:

# OpenFGA Integration Plan

## Overview
Integrate OpenFGA into the existing Bun + Hono HTTPS API to provide RBAC authorization. Users get roles (admin, member) in organizations, and resources owned by orgs inherit permission checks.

## RBAC Model
- **user** — represents authenticated users (mapped from JWT `sub`)
- **organization** — has `admin` and `member` relations; admins are implicitly members
- **resource** — owned by an organization; org admins can edit, org members can view

## Files to Create

### 1. `docker-compose.yml`
- OpenFGA server with SQLite datastore
- Migration service runs first (`openfga migrate`)
- Ports: 8080 (HTTP API), 8081 (gRPC), 3001 (Playground — shifted from 3000 to avoid conflict)
- Health check on `/healthz`

### 2. `fga.ts` — OpenFGA client module
- Creates `OpenFgaClient` pointing to `http://localhost:8080`
- `initFga()`: lists stores, reuses existing or creates new one, writes the RBAC authorization model
- `getFgaClient()`: singleton accessor for use in routes/middleware

### 3. `middleware.ts` — JWT + authorization middleware
- `jwtAuth`: Hono's built-in `jwt()` middleware (HS256, same secret as auth.ts)
- `requirePermission(relation, objectResolver)`: factory that checks OpenFGA before allowing access

### 4. `fga-routes.ts` — Authorization management API
All routes JWT-protected:
- `POST /api/fga/tuples` — write relationship tuples `{ writes: [...] }`
- `DELETE /api/fga/tuples` — delete tuples `{ deletes: [...] }`
- `POST /api/fga/check` — check a permission `{ user, relation, object }`
- `GET /api/fga/relations` — list objects for a user `?user=...&relation=...&type=...`

## Files to Modify

### 5. `index.ts`
- Import and mount `fgaRoutes` at `/api/fga`
- Call `initFga()` before starting the server (fail-fast if OpenFGA unreachable)
- Add example protected route: `GET /api/resources/:resourceId` with `jwtAuth` + `requirePermission("viewer", ...)`

### 6. `.gitignore`
- No changes needed (already ignores `*.db`)

## Dependencies
- `bun add @openfga/sdk`

## Startup Sequence
1. `docker compose up -d` — starts OpenFGA
2. `bun --hot index.ts` — initializes FGA store/model, then starts HTTPS server

## Verification
```bash
# 1. Start OpenFGA
docker compose up -d

# 2. Start the server
bun run index.ts

# 3. Sign up and get a token
TOKEN=$(curl -sk -X POST https://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"pass123"}' | jq -r .token)

# 4. Make user:1 admin of org:acme
curl -sk -X POST https://localhost:3000/api/fga/tuples \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"writes":[{"user":"user:1","relation":"admin","object":"organization:acme"}]}'

# 5. Assign resource to org
curl -sk -X POST https://localhost:3000/api/fga/tuples \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"writes":[{"user":"organization:acme","relation":"owner","object":"resource:doc1"}]}'

# 6. Access protected resource (should succeed — admin → member → viewer)
curl -sk https://localhost:3000/api/resources/doc1 \
  -H "Authorization: Bearer $TOKEN"

# 7. Check permission directly
curl -sk -X POST https://localhost:3000/api/fga/check \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user":"user:1","relation":"viewer","object":"resource:doc1"}'
```


If you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: /Users/zero8/.claude/projects/-Users-zero8-zero8-dev-openfga/40b3e2ee-e169-40cb-8085-a8f04cb303d3.jsonl
**assistant**: (no content)
**assistant**: All done. Here's a summary of what was implemented:

**New files:**
- `docker-compose.yml` — OpenFGA server with SQLite datastore, migration service, ports 8080/8081/3001
- `fga.ts` — OpenFGA client module with `initFga()` (creates/reuses store, writes RBAC model) and `getFgaClient()` singleton
- `middleware.ts` — `jwtAuth` (Hono JWT middleware, HS256) and `requirePermission(relation, objectResolver)` factory
- `fga-routes.ts` — CRUD for tuples (`POST/DELETE /api/fga/tuples`), permission check (`POST /api/fga/check`), and relation listing (`GET /api/fga/relations`)

**Modified files:**
- `index.ts` — mounts FGA routes at `/api/fga`, calls `await initFga()` before server start, adds protected `GET /api/resources/:resourceId` route with viewer permission check

**Dependency added:**
- `@openfga/sdk@0.9.1`

**RBAC model:**
- `user` type
- `organization` with `admin` and `member` relations (admins are implicitly members)
- `resource` with `owner`, `editor`, `viewer` relations (org admins can edit, org members can view)

**To run:**
```bash
docker compose up -d   # start OpenFGA
bun --hot index.ts     # start the server (initializes FGA store/model automatically)
```
**user**: can we make another databse docker container, for postgres, and we will use that for openfga and application database as well. configure docker compose to do that.  
**assistant**: (no content)
**assistant**: Now I need an `init.sql` to create both databases (one for OpenFGA, one for the app) when Postgres starts.
**assistant**: Now update `auth.ts` to use `Bun.sql` tagged template queries instead of SQLite's `.query()` / `.run()` methods.
**assistant**: I see — `Bun.sql` is already a pre-configured `SQL` instance. To create one with a custom URL, I need to use `new Bun.SQL()`. Let me update `db.ts`.
**assistant**: No errors — type-check passes clean.
**assistant**: Done. Here's what changed:

**`docker-compose.yml`** — replaced SQLite-based OpenFGA with a shared Postgres setup:
- Added `postgres` service (Postgres 17) with health check, exposed on port 5432
- OpenFGA migrate/run now use `OPENFGA_DATASTORE_ENGINE=postgres` pointing at the `openfga` database
- `init.sql` runs on first start to create both `openfga` and `app` databases
- Single `pg_data` volume for persistence

**`db.ts`** — switched from `bun:sqlite` to `Bun.SQL` (Postgres):
- Uses `new Bun.SQL({ url: "postgres://postgres:postgres@localhost:5432/app" })`
- Table DDL updated to Postgres syntax (`SERIAL`, `TIMESTAMPTZ`)

**`auth.ts`** — updated queries for `Bun.SQL` tagged template API:
- `db.query(...).get()` / `db.run(...)` replaced with `await db\`...\`` tagged templates
- Insert uses `RETURNING id` to get the new row ID

**`init.sql`** — new file, creates the two databases on first Postgres startup.

Startup is the same:
```bash
docker compose up -d    # starts Postgres + OpenFGA
bun --hot index.ts      # connects to both databases
```
**user**: docker compose up -d
**assistant**: Still pulling images. Let me wait for it to finish.
**assistant**: Port 8080 is already in use on your machine. Let me check what's using it and update the compose to use a different host port.
**assistant**: The `signoz` container is using port 8080. Let me remap OpenFGA's HTTP API to a different host port.
**assistant**: Also need to update `fga.ts` to point to the new port.
**assistant**: Now restart the failed OpenFGA container.
**assistant**: All containers are up:
- **postgres** — healthy on port `5432`
- **openfga** — starting on port `8082` (HTTP API), `8081` (gRPC), `3001` (Playground)

Port 8080 was already taken by SigNoz, so I remapped OpenFGA's HTTP API to **8082** (in both `docker-compose.yml` and `fga.ts`).
**user**: <task-notification>
<task-id>bfe3b1a</task-id>
<output-file>/private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/bfe3b1a.output</output-file>
<status>failed</status>
<summary>Background command "Start Postgres and OpenFGA containers" failed with exit code 1</summary>
</task-notification>
Read the output file to retrieve the result: /private/tmp/claude/-Users-zero8-zero8-dev-openfga/tasks/bfe3b1a.output
**assistant**: That was the original `docker compose up -d` that failed due to the port 8080 conflict — we already resolved it. The second run succeeded and all containers are up and healthy, as shown in the `docker compose ps` output above.
**user**: So now we do have a setup for the openfga and our own user database, Now let's create an endpoint where an authorized user can create a resource. and once created, we will create an other user to to request view.
**assistant**: (no content)
**assistant**: Let me read the existing plan and explore the current codebase state.
**assistant**: (no content)
**assistant**: Good, I have a full picture of the codebase. Let me now design the implementation.
**user**: [Request interrupted by user for tool use]
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