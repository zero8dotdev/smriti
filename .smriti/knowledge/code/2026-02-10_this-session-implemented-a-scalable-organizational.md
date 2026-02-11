---
id: 2ecff2c6-8821-4d3f-8f87-66d4bd29a4e1
category: code
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T18:04:56.925Z
tags: ["code", "code/implementation"]
---

# This session implemented a scalable organizational structure for managing sho...

> This session implemented a scalable organizational structure for managing showrooms, departments, and members with fine-grained access control using FGA. It enables a business owner to manage hierarchical entities (showrooms, departments) and assign roles (e.g., manager, staff) with dynamic permission rules, ensuring secure resource access and role-based operations like attendance tracking.  

---

## Changes

- **`db.ts`** — Added `showrooms`, `departments`, `branch_offices`, and `showroom_members` tables  
- **`org-routes.ts`** — Created Hono router for:  
  - Showroom CRUD (`POST /`, `GET /:id`)  
  - Department CRUD (`/:showroomId/departments`)  
  - Branch office CRUD (`/:showroomId/branches`)  
  - Member management (`/:showroomId/members` with role-based filters)  
- **`index.ts`** — Mounted `orgRoutes` at `/api/showrooms`  
- **`fga.ts`** — Extended FGA model to include `showroom` and `branch_office` relations  
- **`middleware.ts`** — `requirePermission("manager", ...)` for admin routes  

---

## Decisions

- **FGA for access control**: Chose FGA over RBAC for dynamic, hierarchical permissions (e.g., a manager can access resources in their showroom but not others).  
- **Hono router**: Used Hono for modular, type-safe routing to separate showroom/department/member logic.  
- **Separation of concerns**: Kept `auth.ts` and `middleware.ts` unchanged to avoid duplicating permission checks.  
- **Batch operations**: Added `POST /:showroomId/members/batch` for efficient member onboarding.  

---

## Insights

- **FGA tuple lifecycle**: Role changes (e.g., staff → manager) require deleting old tuples and writing new ones in a single transaction to avoid permission gaps.  
- **Department-branch relationships**: Departments can be unassigned to showrooms (e.g., HR) or bound to specific showrooms (e.g., sales). This requires nullable foreign keys in the database.  
- **Attendance tracking**: A manager can view attendance for their showroom’s staff but not for other showrooms, enforced via FGA’s `showroom:<id>` scope.  
- **Error handling**: Deleted members are marked as `deleted: true` in the DB, and FGA tuples
