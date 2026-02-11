---
id: e96025a3-0459-4eae-964c-74dd8c004e1c
category: code
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T18:08:30.285Z
tags: ["code", "code/implementation"]
---

# This session implemented deputation and attendance tracking features, enhanci...

> This session implemented deputation and attendance tracking features, enhancing access control via FGA and improving user experience. Key changes include adding FGA type definitions, database tables, API routes, and demo script updates to support branch-level permissions and dynamic role-based access.

---

## Changes

- **Files modified**  
  - `fga.ts`: Added `branch` type with `parent`, `manager`, and computed `can_manage` relations  
  - `db.ts`: Added `deputations` and `attendance` table creation  
  - `attendance-routes.ts`: New file with 5 routes for attendance and deputation management  
  - `org-routes.ts`:  
    - Branch creation writes `parent` FGA tuple  
    - Member creation/update/deletion manages `manager` tuples  
  - `index.ts`: Mounted `attendanceRoutes` at `/api/orgs`  
  - `demo-sharma-auto.sh`:  
    - Added steps 12-16 for deputation/attendance testing  
    - Updated TRUNCATE to include `attendance`, `deputations`  
    - Renumbered termination step to 17  

---

## Decisions

- **FGA `can_manage` resolution**:  
  - Chose to resolve `can_manage` via direct `manager` or `admin` on parent organization (via `tupleToUserset`) to centralize access control in FGA, avoiding application logic duplication.  
  - *Alternative considered*: Implementing `can_manage` in code with branch-specific checks, but this would require redundant logic across routes.  
- **Database table creation timing**:  
  - Created `attendance` and `deputations` tables in `db.ts` to ensure they exist when the demo script runs, avoiding TRUNCATE errors.  
  - *Alternative considered*: Lazy table creation, but immediate creation simplifies demo script handling.  

---

## Insights

- **FGA as central access control**:  
  - The `branch` type's `can_manage` resolution demonstrates how FGA can enforce complex, dynamic permissions without application-level checks. This reduces code duplication and improves maintainability.  
- **Graceful handling of missing tables**:  
  - The demo script's TRUNCATE now ignores missing tables, preventing failures during initial setup. This avoids confusion for developers testing edge cases.  
- **Deputation logic clarity**:  
  - The `getEffectiveBranch` function explicitly prioritizes active deputations over home branches, ensuring predictable behavior for users.  

---

## Context

- **Prior state**:  
  - Existing FGA model supported basic organization-level access control.  
  - No deputation or attendance tracking features were implemented.  
- **Constraints**:  
  - Required FGA to enforce branch-specific permissions (e.g., branch managers could only manage their assigned branch).  
  - Demo script needed to handle missing tables during initial setup.  
- **Gotchas**:  
  - OpenFGA health checks
