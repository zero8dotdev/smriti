---
id: 40b3e2ee-e169-40cb-8085-a8f04cb303d3
category: feature
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T18:06:41.716Z
tags: ["feature", "feature/implementation"]
---

# This session implemented a secure HTTPS API server using Bun and Hono, with J...

> This session implemented a secure HTTPS API server using Bun and Hono, with JWT-based authentication and SQLite for user storage. OpenFGA was integrated to enforce fine-grained access control, enabling policy-driven authorization for login/signup endpoints. These changes establish a foundation for scalable, secure, and policy-enforced API operations.  

---

## Changes

- **Files created/modified**:  
  - `index.ts` — Updated to use Hono with HTTPS and route handlers  
  - `auth.ts` — Added `/api/auth/signup` and `/api/auth/login` endpoints with JWT token generation  
  - `db.ts` — SQLite database with `users` table for email/password storage  
  - `.env` — Added `JWT_SECRET` for JWT signing and `OPENFGA_CONFIG` for OpenFGA setup  
  - `openfga.db` — OpenFGA database file for policy storage (added to `.gitignore`)  
  - `.gitignore` — Updated to exclude `certs/`, `openfga.db`, and environment files  

- **Features added**:  
  - JWT authentication with password hashing via `Bun.password.hash()`  
  - OpenFGA integration for access control policies  
  - Error handling for missing fields, duplicate emails, and invalid credentials  

- **Config changes**:  
  - Set `JWT_SECRET` in `.env` for production  
  - Configured OpenFGA via `OPENFGA_CONFIG` to point to `openfga.db`  

---

## Decisions

- **Hono over Bun's built-in server**: Chose Hono for its middleware-friendly routing and better support for JSON payload handling compared to Bun's `Bun.serve()`  
- **SQLite for user storage**: Prioritized simplicity and rapid development over PostgreSQL, acknowledging scalability limitations  
- **JWT for stateless auth**: Selected JWT for scalability and compatibility with distributed systems, despite the need for secure secret management  
- **OpenFGA for access control**: Opted for OpenFGA over role-based systems to enable dynamic, policy-driven authorization without hardcoding permissions  

---

## Insights

- **SQLite trade-offs**: While SQLite is easy to set up, it’s unsuitable for production-scale user data due to lack of
