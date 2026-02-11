---
id: e479ed40-79cb-4b2a-a959-3e3f85ae7047
category: project
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T18:05:52.959Z
tags: ["project", "project/setup"]
---

# This session established a production-ready setup integrating OpenFGA for RBA...

> This session established a production-ready setup integrating OpenFGA for RBAC, PostgreSQL for persistent storage, and Bun/Hono for the API layer. Key changes include remapping OpenFGA's HTTP API to avoid port conflicts, switching from SQLite to PostgreSQL for both OpenFGA and the application database, and implementing endpoints for resource creation with permission-based access control. These changes ensure scalability, separation of concerns, and robust authorization workflows.

---

## Changes

- **Files created/modified**:  
  - `docker-compose.yml`: Added PostgreSQL service, remapped OpenFGA HTTP API to port 8082, configured shared `pg_data` volume.  
  - `init.sql`: Created `openfga` and `app` databases on PostgreSQL startup.  
  - `db.ts`: Replaced SQLite with `Bun.SQL` for PostgreSQL, updated DDL to Postgres syntax (`SERIAL`, `TIMESTAMPTZ`).  
  - `auth.ts`: Refactored to use `Bun.sql` tagged templates for PostgreSQL queries.  
  - `fga.ts`: Updated OpenFGA client to point to `http://localhost:8082` (HTTP API).  
  - New endpoint: `POST /api/resources` to create resources, with automatic tuple creation for ownership.  

- **Features added**:  
  - Resource creation endpoint with ownership assignment via OpenFGA.  
  - Permission checks for viewing resources via `requirePermission("viewer", ...)` in middleware.  
  - Example flow: User creates a resource → system grants "owner" relation → other users request view via `/api/resources/:resourceId`.  

- **Config changes**:  
  - `docker-compose.yml`: PostgreSQL service with health check, OpenFGA data store engine set to `postgres`.  
  - Environment variables: `OPENFGA_DATASTORE_ENGINE=postgres`, `OPENFGA_DATASTORE_URL=postgres://postgres:postgres@localhost:5432/openfga`.  

---

## Decisions

- **PostgreSQL over SQLite**: Chose PostgreSQL for production reliability, scalability, and ACID compliance, even though OpenFGA originally used SQLite.  
- **Port remapping**: Migrated OpenFGA HTTP API to 8082 to avoid conflict with SigNoz on 8080, ensuring service availability.  
- **Shared database**: Used a single PostgreSQL instance for both OpenFGA and the application to simplify management and reduce overhead.  
- **RBAC model**: Defined ownership via "owner" relation and inherited permissions through organizational roles, avoiding redundant tuple creation for nested permissions.  

---

## Insights

- **Port conflicts are critical**: Always check for port usage before deploying services; remapping is a quick fix but requires updating all dependent configurations.  
- **Database separation vs. unification**: While OpenFGA and the app could use separate databases, a shared PostgreSQL instance simplifies maintenance and reduces operational complexity.  
- **RBAC via tuples**: The model relies on explicit tuple creation for ownership, which is intentional to avoid accidental permission inheritance.  
- **Bun.SQL as a bridge**: Using `Bun.SQL` for PostgreSQL allows leveraging Bun's built-in SQL tools while maintaining compatibility with OpenFGA's data model.  

---

## Context

Prior to this session, the system used SQLite for both OpenFGA and the application database, with OpenFGA's HTTP API on port 8080. The port conflict with SigNoz required remapping, and the decision to switch to
