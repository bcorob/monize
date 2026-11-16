# Database Directory

`schema.sql` is the full schema for a fresh install and the authoritative place to look up a table or column; `migrations/` holds the incremental SQL that `db-migrate` applies at container start, before the server, in prefix order (numeric on the prefix, then the full filename; each in its own transaction, recorded in `schema_migrations`). A fresh install runs `schema.sql` first, then every migration as a no-op. `docs/database-migrations.md` has the runner's details, the guard recipes and the recovery runbook.

A constraint here is usually the strongest available form of a system rule, so several entries in `docs/system-invariants.md` are enforced, or unenforced, by what is in `schema.sql`. A uniqueness constraint prevents duplicate rows and does nothing about a lost update to one; `docs/concurrency-and-idempotency.md` says when a constraint is the right mechanism.

## Creating a new migration

1. **Create the file** in `database/migrations/` as `YYYYMMDDHHMMSS_description.sql`, the prefix being the **UTC** second you authored it: `touch "database/migrations/$(date -u +%Y%m%d%H%M%S)_heal_something.sql"`. Never take the next sequential number: the `NNN_` prefixes are the retired scheme, and `scripts/check-migration-prefixes.mjs` refuses a new one in CI and locally (it needs the base ref, so it silently skips in a shallow clone).
   - **The three-digit files are historical and are never renumbered.** `schema_migrations` keys on the filename, so a renamed migration re-runs on every deployed database. Apply order is numeric on the prefix everywhere migrations are ordered (`backend/src/common/db/migration-filename.ts` is the one definition), so every timestamp sorts after every three-digit prefix.
   - **Apply order is authoring order, not merge order.** A migration must not depend on another migration that is still in flight; if yours needs an object another open PR creates, author yours after that PR merges.
   - Every statement is idempotent (`IF NOT EXISTS` / `IF EXISTS`); a comment at the top says what the migration does; one change per file.
   - **Expand now, contract in a later release.** A rolling deployment runs the previous release against the new schema for the length of the rollout, so a migration that renames or drops a column, tightens a type or adds a `NOT NULL` breaks the pods still serving. Widen, ship the writer, remove the old shape afterwards, and mark the contract `-- contract-after: X.Y.Z` (`contract-without-expand` refuses it otherwise); `docs/database-migrations.md` has the table of what this forbids.
2. **Update `schema.sql`** in the same commit, so a fresh install matches a migrated database.
3. **Update the TypeORM entity** if a mapped table changed: columns are `snake_case`, properties `camelCase`, mapped with `@Column({ name: 'snake_case_name' })`.
4. **Update the DTO** if the field is user-editable, and **the frontend type** in `frontend/src/types/`.
5. **Classify a new table in the backup**: `INTENTIONALLY_EXCLUDED_TABLES` in `backend/src/backup/export-table-queries.ts`, or an export query beside the others. The coverage guard in `backend/test/integration/backup-restore.integration.spec.ts` fails a table in neither, so the decision is explicit rather than a silent data loss on restore.
6. **Classify a new column in the support backup** if its table is exported: `backend/src/backup/support-backup/support-backup-rules.ts` is an allowlist (`keep` for structure, dates, enums, flags and foreign keys; `mask` for names; `drop` for free text, secrets and anything that re-identifies a masked value; `const` instead of `drop` when the column is NOT NULL). The golden test in `backend/test/integration/support-backup.integration.spec.ts` fails until the decision is made.
7. **Ship the table's RLS policy in the same migration** if the table is user-owned (below).
8. **Restart the backend**; migrations apply on startup.

## Row-level security (hard rules)

Every user-owned table carries a row-level-security policy; the app emits per-transaction identity GUCs through `withScopedDb` and the policies compare each row's owner against them. `docs/row-level-security-contract.md` is canonical for modes, exempt tables and rationale.

1. **A migration that creates a user-owned table ships its `CREATE POLICY` and its own `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` in the same file** (`117_mny_import_staging_and_jobs.sql`, `118_security_documents_rls.sql` are the worked examples). `123_rls_enable.sql` derived its targets once from `pg_policies` and never runs again, so a later policy without its own enable leaves that table unprotected under enforcement. Enabling is inert at `RLS_MODE=off`/`shadow`.

   Every table lands in exactly one of four buckets, and `backend/test/integration/rls-enforcement.integration.spec.ts` fails the moment a table is in none or several:
   - **Direct**: has a `user_id` column; the uniform policy (`user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())`). Tables keyed by the *authenticated* user additionally OR in `user_id = (SELECT app_real_user_id())`; `112_rls_policies_direct.sql` Group B.
   - **Owner-column**: a bespoke owner column (`owner_user_id`, `delegate_user_id`, `users.id`); a bespoke policy (`114_rls_policies_special.sql`) plus an entry in the spec's owner-column map.
   - **Indirect**: no owner column; an `EXISTS` back to the owning parent (`113_rls_policies_indirect.sql`) plus an entry in the spec's indirect map.
   - **Exempt**: nothing to policy on. The set is `RLS_EXEMPT_TABLES` in `backend/src/common/db/rls-exempt-tables.ts`, mirrored as `rls-exempt:` marker lines in `schema.sql` and checked both ways by `backend/src/common/db/rls-exempt-tables.spec.ts`. Never write the list anywhere else; exempting a table takes a rationale in the contract.

   Keep the `(SELECT app_current_user_id())` initplan form; a bare call relies on SQL-function inlining and evaluates per row on a sequential scan.

2. **No migration names a role.** `GRANT ... TO monize_app` or any `CREATE/ALTER/DROP ROLE` crash-loops every deployment where the role does not exist; the role and its grants are provisioned idempotently by db-init (`backend/src/common/db/app-role.ts`), and new tables get grants through `ALTER DEFAULT PRIVILEGES`. The `role-or-grant-statement` rule in `backend/scripts/migration-lint.mjs` enforces it. `PUBLIC` is permitted: a keyword that always resolves, needed because `CREATE FUNCTION` grants `EXECUTE` to `PUBLIC` implicitly and the revoke belongs in the creating transaction.

## Idempotency is a CI gate

Every statement is a no-op when re-applied to an up-to-date database; a half-applied migration crash-loops the backend at startup. `docs/database-migrations.md` holds the guard recipes (`ADD CONSTRAINT` after `DROP CONSTRAINT IF EXISTS`, `CREATE TRIGGER` after `DROP TRIGGER IF EXISTS`, `INSERT ... ON CONFLICT`) and the recovery runbook. Two checks enforce it:

- `cd backend && npm run migration:lint` (static, `backend/scripts/migration-lint.mjs`; the "Backend Lint & Type Check" job).
- `scripts/verify-schema.sh` applies every migration on top of `schema.sql` twice and diffs the result (the "Schema vs Migrations Drift" job; needs only Docker).
