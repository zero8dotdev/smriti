---
name: design-contracts
description: Enforces smriti's three design contracts (observability, dry-run, versioning) when writing or modifying CLI command handlers or JSON output.
---

# smriti Design Contract Guardrails

This skill activates whenever you are **adding or modifying a CLI command**,
**changing JSON output**, **touching telemetry/logging code**, or **altering
config defaults** in the smriti project.

---

## Contract 1 — Dry Run

### Mutating commands MUST support `--dry-run`

The following commands write to disk, the database, or the network. Every one of
them **must** honour `--dry-run`:

| Command      | Expected guard pattern                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| `ingest`     | `const dryRun = hasFlag(args, "--dry-run");` then no DB/file writes when true |
| `embed`      | same                                                                          |
| `categorize` | same                                                                          |
| `tag`        | same                                                                          |
| `share`      | same                                                                          |
| `sync`       | same                                                                          |
| `context`    | already implemented — keep it                                                 |

When `--dry-run` is active:

- `stdout` must describe **what would happen** (e.g. `Would ingest N sessions`).
- `stderr` must note what was skipped (`No changes were made (--dry-run)`).
- Exit code follows normal success/error rules — dry-run is NOT an error.
- If `--json` is also set, the output envelope must include
  `"meta": { "dry_run": true }`.

### Read-only commands MUST reject `--dry-run`

These commands never mutate state. If they receive `--dry-run`, they must print
a usage error and `process.exit(1)`:

`search`, `recall`, `list`, `status`, `show`, `compare`, `projects`, `team`,
`categories`

---

## Contract 2 — Observability / Telemetry

### Never log user content

The following are **forbidden** in any `console.log`, `console.error`, or
log/audit output:

- Message content (`.content`, `.text`, `.body`)
- Query strings passed by the user
- Memory text or embedding data
- File paths provided by the user (as opposed to system-derived paths)

✅ OK to log: command name, exit code, duration, session IDs, counts, smriti
version.

### Telemetry default must be OFF

- `SMRITI_TELEMETRY` must default to `0`/`false`/`"off"` — never `1`.
- Telemetry calls must be guarded: `if (telemetryEnabled) { ... }`.
- Any new telemetry signal must be added to `smriti telemetry sample` output.

---

## Contract 3 — JSON & CLI Versioning

### JSON output is a hard contract

The standard output envelope is:

```json
{ "ok": true, "data": { ... }, "meta": { ... } }
```

Rules:

- **Never remove a field** from `data` or `meta` — add `@deprecated` in a
  comment instead.
- **Never rename a field**.
- **Never change a field's type** (e.g. string → number).
- New fields in `data` or `meta` must be **optional**.
- If you must replace a field: add the new one AND keep the old one with a
  `_deprecated: true` sibling or comment.

### CLI interface stability

Once a command or flag has shipped:

- **Command names**: frozen.
- **Flag names**: frozen. You may add aliases (e.g. `--dry-run` → `-n`) but not
  rename.
- **Positional argument order**: frozen.
- **Deprecated flags**: must keep working, must emit a `stderr` warning.

---

## Pre-Submission Checklist

Before finishing any edit that touches `src/index.ts` or a command handler:

- [ ] If command is mutating → `--dry-run` is supported and guarded
- [ ] If command is read-only → `--dry-run` is rejected with a usage error
- [ ] No user-supplied content appears in `console.log`/`console.error`
- [ ] If JSON output changed → only fields were **added**, not
      removed/renamed/retyped
- [ ] If a new flag was added → it does not conflict with any existing flag name
- [ ] Telemetry default remains off in `config.ts`

If any item fails, fix it before proceeding.
