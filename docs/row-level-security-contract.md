# Row-Level Security contract

What row-level security guarantees in Monize, which tables are exempt from it and
why, and which direct-`DataSource` access paths are sanctioned. This is the
canonical document: migration comments, the schema, the runbook and the source
point here rather than restating a rationale of their own.

Read this before adding a table, exempting one, or reaching the database by any
route other than `withScopedDb`.

Operational material -- rollout stages, mode flips, monitoring, emergency
rollback -- stays in `docs/future-plans/row-level-security-runbook.md`. The
original design and the task record are
`docs/future-plans/row-level-security.md` and
`docs/future-plans/row-level-security-tasks.md`; both describe work that has
since shipped, and where they disagree with this document, this document wins.

## 1. What RLS is here

Defence in depth, behind application-level ownership predicates -- not a
replacement for them. Every user-owned table carries a policy comparing the
row's owner against transaction-local identity GUCs that `withScopedDb`
(`backend/src/common/db/scoped-db.ts`) emits. Application code still filters by
`userId`; RLS is what contains the query that forgets to.

`RLS_MODE` selects how much of that is live:

| Mode | Identity GUCs | Runtime role | Effective RLS |
|---|---|---|---|
| `off` (default) | no | owner | disabled |
| `shadow` | yes | owner | policies bypassed |
| `enforce` | yes | unprivileged app role | enabled where policies exist |

Whether `enforce` should become the default is a separate, open decision
(issue #1065); it is deliberately not settled here.

Every table must land in exactly one of four buckets, and
`backend/test/integration/rls-enforcement.integration.spec.ts` fails when one
lands in none or several: **direct** (`user_id` column), **owner-column**,
**indirect** (`EXISTS` back to the owning parent), or **exempt**. The first
three are described in `database/CLAUDE.md`. This document owns the fourth.

## 2. The exempt tables

The set is `RLS_EXEMPT_TABLES` in
`backend/src/common/db/rls-exempt-tables.ts`, mirrored as `rls-exempt:` marker
lines in the block at the foot of `database/schema.sql`.
`backend/src/common/db/rls-exempt-tables.spec.ts` checks the two against each
other in both directions, with no database, and throws if the marker block goes
missing.

That checking exists because the list was previously written out in four places
-- migration 114, the schema block, and one array in each of the two RLS
integration specs -- plus a fifth summary in `database/CLAUDE.md`, and had
already drifted. The migration documented four tables while the schema and the
specs carried six; one spec asserted the count in its own name ("leaves the four
exempt tables untouched") for a list of six; and the migration asserted that
"the catalog-driven test in T2 asserts this exact list" when by then it asserted
a different one. Both integration specs need a live PostgreSQL, so none of it
ran in `npm run test:unit` and nothing failed.

| Table | Why exempt |
|---|---|
| `currencies` | Global reference data keyed by ISO 4217 code. It carries `created_by_user_id`, but that is attribution (`NULL` = system currency), not ownership: any user may reference a custom code via `accounts.currency_code`, and a `created_by_user_id` policy would hide every system currency and break those foreign keys. Per-user visibility is already expressed by `user_currency_preferences`, which **is** policied. |
| `exchange_rates` | Global reference data with no owner column; written by the scheduled refresh under system context. |
| `market_index_prices` | Global market reference data. A market index has no owner and nobody holds units of it, so one S&P 500 close serves every user. The alternative -- a per-user securities row per index -- would put a fake instrument in every holdings list and multiply provider traffic by the number of accounts. |
| `market_index_sync` | Sync bookkeeping for that refresh; same ownership story. |
| `oauth_payloads` | See section 3. |
| `provider_health` | Deployment-wide availability of an outbound market-data provider, plus the bookkeeping that keeps one outage to one alert. One Yahoo outage is every user's Yahoo outage: there is no owner column, and a per-user copy would multiply both the alert and the provider traffic by the number of accounts. Written under system context on transitions only, and read only by the alert sweep -- nothing user-identifiable is stored, and `last_failure_reason` is a network diagnostic, bounded on write. |
| `schema_migrations` | Migration infrastructure, written only by `db-migrate` running as the owner. `INSERT`/`UPDATE`/`DELETE` are revoked from the runtime role (DR-02). |

## 3. `oauth_payloads` and the OAuth adapter

### Context

`oidc-provider` needs durable storage for authorization codes, access and
refresh tokens, grants, sessions, interactions and device codes. Some of that
storage happens *before* Monize has an authenticated application user -- during
`authorize`, there is no session yet to derive an identity from.

`oauth_payloads` has no meaningful end-user ownership key. Rows are addressed by
opaque provider identifiers: `id`, `model`, `grantId`, `userCode`, `uid`. A
tenant policy would have no legitimate user predicate and would reduce to a
bypass-only arm -- a policy that reads as protection and provides none.

The provider is mounted as raw Express middleware in `backend/src/main.ts`,
outside Nest's request pipeline, so `RequestContextInterceptor` never sees these
calls.

### Decision

- `oauth_payloads` remains exempt from RLS.
- `PostgresAdapter` (`backend/src/oauth/postgres.adapter.ts`) may reach this one
  table directly through its injected `DataSource`.
- The runtime role keeps only the DML the adapter needs on this table.
- **This exception does not authorize direct `DataSource` access to any
  user-owned table**, and a new infrastructure table does not inherit it. A
  second such exception is a separate decision, documented here.

### What the safety argument actually is

Not identity context. The adapter runs with **no ambient context at all** --
neither a request scope nor `withSystemContext`.

This is worth stating plainly because the opposite was written down and believed
for a long time. Migration `114_rls_policies_special.sql`, its mirror at the
foot of `database/schema.sql`, the runbook's context table and the C1 task
record all asserted that access "runs under `withSystemContext` regardless".
None of it was true, and the claim mattered: it made the exemption look like a
consequence of an identity decision rather than what it is.

The safety argument is:

1. the table is RLS-exempt, so no policy is silently returning zero rows;
2. it has no owner column, so there is no tenant partition to cross;
3. rows are addressed by opaque, high-entropy provider identifiers;
4. the runtime role's grants on it are confined to the adapter's DML;
5. contents are short-lived and expire.

### The two permitted access paths

Exactly two, both in `backend/src/oauth/`:

1. **`PostgresAdapter`** -- `upsert`, `find`, `findByUserCode`, `findByUid`,
   `consume`, `destroy`, `revokeByGrantId`. Every one is keyed by an opaque
   provider identifier.

2. **`OAuthProviderService.revokeAllForUser`** -- a single parameterized
   `DELETE` keyed on `payload ->> 'accountId'`, used by admin flows (deactivate,
   password reset) so revocation takes effect immediately rather than at
   token-TTL expiry.

   This one **is** keyed by an application user identifier, which the original
   rationale explicitly claimed never happened ("never queried per end-user").
   It is a bounded exception, not a defect: its only caller is
   `backend/src/admin/admin.service.ts`, behind `@Roles("admin")`; the id is
   server-derived and never request-supplied; and it deletes only rows whose own
   payload already names that subject.

   It is deliberately **not** wrapped in `withSystemContext`. The table is
   exempt, so a bypass GUC would change nothing about what the query can reach
   -- it would buy the appearance of a control rather than a control, and widen
   the `WITH_CONTEXT_ALLOWLIST` fence for no gain. The real protection is the
   admin-only caller and the server-derived id, and saying so is more useful
   than dressing it up.

Anything else is a defect. Both guards in section 5 fail on a third path.

### Rejected alternatives

1. **A policy consisting only of the system-bypass arm.** With no owner column
   there is no predicate to write, so the policy would be
   `USING (app_bypass_rls())` -- indistinguishable from exempt at runtime, but
   it would appear in `pg_policies` and read to any future reviewer as a table
   with tenant protection. An honest exemption with a written rationale is
   strictly better than a policy that lies.

2. **A dedicated owner-role `DataSource` for the OAuth module.** Considered at
   task C1 and declined. It buys nothing here -- the table is exempt either way
   -- and costs a second connection identity to audit, plus a second way to
   reach the database that the lint bans would then have to carve out.

3. **An artificial ownership column on short-lived provider artifacts.** The
   adapter would have to populate it before an identity exists, which is exactly
   the case that has none. It would be `NULL` for the rows that matter most.

4. **Wrapping every adapter operation in `withSystemContext` +
   `withScopedDb`.** This is the tempting one, because it makes the code *look*
   uniform. It would emit `app.bypass_rls` on a table with no policy to bypass:
   no behaviour change, a per-call transaction on the hot authorization path,
   and a fence entry implying a tenant decision nobody made. Uniformity of
   appearance is not the goal; an accurate boundary is.

### Consequences

- A defect in the adapter can affect the whole provider artifact store rather
  than one tenant's partition.
- Grant scope and the adapter's query keys are security-sensitive; the opacity
  of `id`/`grantId`/`userCode`/`uid` is load-bearing.
- `oauth_payloads` must not become general-purpose application storage.
- A schema change to the table requires a fresh ownership and RLS review.
- Another direct-`DataSource` exception requires its own entry in this document.

### Review triggers

Reconsider this decision when any of these happens:

- `oauth_payloads` gains `user_id`, `owner_user_id` or an equivalent tenant key;
- a query begins selecting rows by **request-supplied** application user input
  (the admin-initiated, server-derived case in section 3 is the accepted bound,
  and is the reason this trigger is phrased that way);
- non-OAuth domain data is stored in the table;
- another module starts using `OAuthPayload`;
- the adapter receives an owner-role connection;
- another table requests the same exemption;
- the runtime role's grants on the table are widened.

## 4. Adding or exempting a table

Adding a **user-owned** table: ship its `CREATE POLICY` in the same migration,
and -- for any migration numbered after `123` -- its own `ALTER TABLE ... ENABLE
ROW LEVEL SECURITY`. `database/CLAUDE.md` has the rules and the worked examples.

Exempting a table is a deliberate decision, and takes four things in one change:

1. an entry in `RLS_EXEMPT_TABLES` with a one-line reason;
2. an `-- rls-exempt: <table>` marker in `database/schema.sql`;
3. a row in the section 2 table above, with the real rationale;
4. a reason it is not one of the other three buckets.

## 5. What is enforced, and where

| Guard | Fails when |
|---|---|
| `backend/src/common/db/rls-exempt-tables.spec.ts` | The constant and the schema marker block disagree in either direction, or the marker block is missing. No database needed. |
| `backend/src/oauth/oauth-payload-access.spec.ts` | A production file outside the allowlist names `OAuthPayload` or `oauth_payloads` -- including via a re-export or raw SQL, which the lint ban cannot see. Also fails when an allowlist entry goes stale, and when the adapter loses its pointer to this document. |
| `OAUTH_PAYLOAD_ALLOWLIST` in `backend/eslint.config.mjs` | A production file outside the allowlist imports the entity. |
| `WITH_CONTEXT_ALLOWLIST` in `backend/eslint.config.mjs` | A new file imports `withSystemContext` / `withUserContext` without being added as a reviewed decision. |
| `backend/test/integration/rls-enforcement.integration.spec.ts` | A table is in no bucket or several; a covered table lacks its policy; an exempt table has one. Live PostgreSQL. |
| `backend/test/integration/rls-enable.integration.spec.ts` | Migration `123` enables RLS on an unpolicied table, or misses a policied one. Live PostgreSQL. |
| `backend/src/common/db/lint-bans.spec.ts` | A banned database primitive is not documented where contributors read, or an instruction file recommends one. |

The two ESLint allowlists are deliberately *not* one list: they answer different
questions, and `backend/src/oauth/oauth-provider.service.ts` is legitimately on
both. Flat config replaces a rule's whole options object per block, so each
override restates the bans it does not mean to lift -- see `importRule` in
`backend/eslint.config.mjs`, and the block covering the intersection.

One ban that is deliberately absent: there is no `no-restricted-syntax` selector
on `getRepository`. `m.getRepository(X)` off a scoped `EntityManager` is the
correct pattern throughout this codebase, so such a selector would fire on
hundreds of correct call sites -- and `lint-bans.spec.ts` scrapes selector shapes
out of the config and requires the root `CLAUDE.md` and `CONTRIBUTING.md` to name
each banned call, which would put actively false guidance in the instruction
files. The restriction is on the import, where it can be stated truthfully.
