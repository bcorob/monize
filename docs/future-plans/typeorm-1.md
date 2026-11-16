# Plan: move the backend from TypeORM 0.3 to 1.x

Staged plan for upgrading `typeorm` from 0.3.31 to the 1.x line. The task graph
is `docs/future-plans/typeorm-1-tasks.md`. Triggered by Dependabot PR #1572
(typeorm 1.1.1), closed because the upgrade is a migration, not a version bump;
Dependabot ignores typeorm majors in `.github/dependabot.yml` until the last
task here merges.

## Why this is not a bump

TypeORM's own guide is the reference: <https://typeorm.io/docs/releases/1.0/upgrading-from-0.3/>.
Three of its changes reach this codebase; the rest (removed global helpers,
`printSql`, `onConflict`, `loadedTables`, `readonly`/`unsigned` column options,
`TYPEORM_*` environment loading) were checked against `main` and have no call
site. `TYPEORM_OPTIONS` in the codebase is a Nest injection token, not an
environment variable.

1. **A `null` or `undefined` value in a find `where` now throws.** 0.3 silently
   dropped the property, so `{ userId, accountId: undefined }` matched every
   account of the user. This is the change that matters: `tsc` cannot see it,
   it fails at runtime, and in 0.3 the dropped predicate could widen a query
   past what the caller meant. There are about 770 `where: {` sites in
   `backend/src`.
2. **`relations` and `select` take objects, not string arrays.** CI on #1572
   reported 178 type errors in 61 files: 155 `relations: string[]`, one
   `select` array (`backend/src/ai/ai-usage.service.ts`), and the
   `findByIds` removals below. Nested relation strings (`"splits.category"`)
   become nested objects. Unit specs that assert on the find options
   (`toHaveBeenCalledWith({ relations: [...] })`) change with them.
3. **`findByIds` is removed.** Five call sites, all on the pricing and
   reporting paths: `backend/src/net-worth/net-worth.service.ts` (three),
   `backend/src/securities/daily-movement.service.ts`,
   `backend/src/built-in-reports/spending-reports.service.ts`. The
   replacement is `findBy({ id: In(ids) })`. An empty `ids` must keep
   returning an empty result without a query.

Also in scope:

- `relations` now always LEFT JOINs. A find that combines `relations` with
  `lock` must move to the query builder. There are 21 finds with a `lock`
  option; each is checked.
- The test stand-in for `@nestjs/typeorm`'s `typeorm-compat` module (added for
  #1568) re-exports `Connection` and `AbstractRepository`, which 1.x removed.
  If #1567 (NestJS 12) has merged, the stand-in is already gone; otherwise it
  is deleted in task T1.
- `@nestjs/typeorm` 12 already supports TypeORM 1 (it resolves the removed
  exports lazily), so no Nest change is needed.

## Approach

**Keep 0.3 semantics first, tighten second.** T1 sets

```ts
invalidWhereValuesBehavior: { null: "ignore", undefined: "ignore" }
```

on every DataSource the backend builds: `backend/src/app.module.ts`, the two
one-off scripts in `backend/src/database/`, `backend/test/helpers/integration-setup.ts`
(both of its DataSources), `backend/test/helpers/test-database.ts` and the two
`backend/test/*.e2e-spec.ts` files that call `TypeOrmModule.forRoot`. Then the
version change alone does not change any query's result.
Every later task removes reliance on that setting in one area, and the last
task deletes it. That splits a large, risky diff into reviewable pieces, each
with its own tests, and never ships a release where a query's meaning changed
silently.

**Codemod for syntax, review for semantics.** `npx @typeorm/codemod v1 src/`
rewrites the `relations`/`select` arrays and `findByIds`. Run it once in T1 and
review the diff by hand; it does not touch `where` values.

**Where a dropped predicate was the intent, say so.** For each `where` that can
receive `null` or `undefined`, the fix is one of: the value is required (validate
before the query and fail closed), absence means "no filter" (build the `where`
object conditionally), or `null` means "is null" (`IsNull()`). Choosing among
them is a semantic decision per site; a blanket `?? undefined` or spread is not
a fix.

## Verification

- Backend gate per task: lint, `tsc --noEmit`, unit suite with coverage, and
  `npm run build && npm run test:integration`.
- T1 is the version switch: its proof is the full integration suite green
  with the compatibility setting on, plus the module-graph spec.
- Each semantic task adds a unit case for an `undefined` input on every site it
  changes, asserting the decided behaviour (rejected, unfiltered or `IS NULL`),
  so a regression to the 0.3 "silently widen" reading fails a test.
- The final task flips the setting off and runs the integration suite and E2E;
  anything still passing `undefined` throws there instead of in production.

## Assumptions

- PostgreSQL only; the driver changes in the guide for MySQL and others do not
  apply.
- Database migrations are raw SQL under `database/migrations/`, not TypeORM
  migrations, so the migration API changes do not apply.
- The upgrade lands after #1567 (NestJS 12) or alongside it; it does not depend
  on it.
