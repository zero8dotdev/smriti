Observability & Telemetry

Principles

Observability exists to help the user and the system understand behavior, never to surveil.

Rules:
	•	Telemetry is opt-in only. Default is off.
	•	No user content (messages, memory text, embeddings) is ever logged.
	•	No network calls for analytics unless explicitly enabled.
	•	Observability must never change command semantics or performance guarantees.

Local Observability (Always On)

These are local-only and require no consent:
	•	--verbose : additional execution detail (phases, timings)
	•	--debug : stack traces, SQL, internal state
	•	meta.duration_ms : execution timing included in JSON output

Telemetry (Opt-In)

If enabled by the user (smriti telemetry enable or SMRITI_TELEMETRY=1):

Collected signals (aggregated, anonymous):
	•	Command name
	•	Exit code
	•	Execution duration bucket
	•	Smriti version

Explicitly NOT collected:
	•	Arguments values
	•	Query text
	•	Memory content
	•	File paths
	•	User identifiers

Telemetry must be:
	•	Documented (smriti telemetry status)
	•	Inspectable (smriti telemetry sample)
	•	Disable-able at any time (smriti telemetry disable)

Audit Logs (Optional)

For enterprise / shared usage:
	•	Optional local audit log (~/.smriti/audit.log)
	•	Records: timestamp, command, exit code, actor (human / agent id)
	•	Never enabled by default

⸻

Dry Run & Simulation

Dry Run Contract

Any command that mutates state must support --dry-run.

--dry-run guarantees:
	•	No database writes
	•	No file writes
	•	No network side effects
	•	Full validation and planning still run

Dry-run answers the question:

“What would happen if I ran this?”

Dry Run Output Rules

In --dry-run mode:
	•	stdout shows the planned changes
	•	stderr shows what was skipped due to dry-run
	•	Exit code follows normal rules (0 / 3 / 4)

Example:

Would ingest 12 new sessions
Would skip 38 existing sessions
No changes were made (--dry-run)

In JSON mode:

{
  "ok": true,
  "data": {
    "would_ingest": 12,
    "would_skip": 38
  },
  "meta": {
    "dry_run": true
  }
}

Required Coverage

Commands that MUST support --dry-run:
	•	ingest
	•	embed
	•	categorize
	•	tag
	•	share
	•	sync
	•	context

Read-only commands MUST reject --dry-run with usage error.

⸻

Versioning & Backward Compatibility

Semantic Versioning

Smriti follows SemVer:
	•	MAJOR: Breaking CLI or JSON contract changes
	•	MINOR: New commands, flags, fields (additive only)
	•	PATCH: Bug fixes, performance improvements

CLI Interface Stability

Once released:
	•	Command names never change
	•	Flags are never removed
	•	Flags may gain aliases but not be renamed
	•	Positional argument order is frozen

Deprecated behavior:
	•	Continues to work
	•	Emits a warning on stderr
	•	Removed only in next MAJOR version

JSON Schema Stability

JSON output is a hard contract:

Rules:
	•	Fields are only added, never removed
	•	Existing field meaning never changes
	•	Types never change
	•	New fields must be optional

If a field must be replaced:
	•	Add the new field
	•	Mark the old field as deprecated in docs
	•	Keep both for one MAJOR cycle

Manifest Versioning

smriti manifest includes:
	•	CLI version
	•	Manifest schema version

Example:

{
  "manifest_version": "1.0",
  "cli_version": "0.4.0"
}

Agents may branch behavior based on manifest_version.

Data Migration Rules
	•	Stored data schemas may evolve internally
	•	CLI behavior must remain stable across migrations
	•	Migrations must be automatic and idempotent
	•	Migration failures exit with DB_ERROR
