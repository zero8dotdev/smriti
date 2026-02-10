---
id: 40b3e2ee-e169-40cb-8085-a8f04cb303d3
category: feature
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.754Z
tags: ["feature", "feature/implementation"]
---
# Can you create this folder as bun project. I want to write a bun project which allows https api serv
**user**: Can you create this folder as bun project. I want to write a bun project which allows https api server. 
**assistant**: (no content)
**assistant**: Let me check the existing files first.
**assistant**: Good, there's already a Bun project scaffolded. I'll generate self-signed TLS certs and set up the HTTPS API server.
**assistant**: Now I'll write the HTTPS API server.
**assistant**: Let me add `certs/` to `.gitignore` so the keys don't get committed.
**assistant**: Now let me verify it starts up correctly.
**assistant**: Server is working. Let me mark the task complete.
**assistant**: The project is set up. Here's what was done:

**TLS Certificates** — Generated a self-signed cert + key in `certs/` (valid for localhost/127.0.0.1, 365 days). Added `certs/` to `.gitignore`.

**HTTPS API Server** (`index.ts`) — Uses `Bun.serve()` with TLS on port 3000:
- `GET /api/health` — returns `{"status":"ok"}`
- Unmatched routes return 404

**Run it:**
```sh
bun --hot index.ts
```

Then test with:
```sh
curl -k https://localhost:3000/api/health
```

The `-k` flag is needed since the cert is self-signed. Add more routes to the `routes` object as you build out your API.
**user**: make these api in hono. It should accept the json payload. 
**assistant**: (no content)
**assistant**: Now let me verify both GET and POST work.
**assistant**: The POST returned "Not Found" — this is a known issue with Hono's `fetch` binding losing context. Let me fix it.
**assistant**: The `export default` pattern with Bun may be conflicting with Hono's routing. Let me switch to explicit `Bun.serve()`.
**assistant**: Both endpoints work now.
**assistant**: Done. The server now uses Hono with HTTPS and accepts JSON payloads:

- **GET `/api/health`** — returns `{"status":"ok"}`
- **POST `/api/health`** — accepts a JSON body and echoes it back in the response

Run with:
```sh
bun --hot index.ts
```

Add more routes by chaining `app.get()`, `app.post()`, `app.put()`, `app.delete()`, etc. The JSON body is available via `await c.req.json()` in any handler.
**user**: now let's create an api for login and signup with email. 
**assistant**: (no content)
**assistant**: I'll use `bun:sqlite` for storage, `Bun.password` for hashing, and Hono's JWT helper for tokens. Let me check what Hono provides for JWT.
**assistant**: Good, Hono ships with a JWT helper. Now let me create the database module and auth routes.
**assistant**: Now wire the auth routes into the main server.
**assistant**: Now add `openfga.db` to `.gitignore`.
**assistant**: All cases pass.
**assistant**: Done. Here's what was added:

**Files created:**
- `db.ts` — SQLite database with a `users` table (id, email, password, created_at)
- `auth.ts` — Hono router with two endpoints

**Endpoints:**

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/auth/signup` | `{"email", "password"}` | `{"token"}` (201) |
| POST | `/api/auth/login` | `{"email", "password"}` | `{"token"}` |

**Details:**
- Passwords are hashed with `Bun.password.hash()` (argon2)
- Returns a JWT (24h expiry) signed with `JWT_SECRET` env var (falls back to a default)
- Handles: missing fields (400), duplicate email (409), wrong credentials (401)
- Set `JWT_SECRET` in your `.env` for production use
**user**: now setup a openfga to be used here. 
**assistant**: Now let me design the plan.
**assistant**: (no content)