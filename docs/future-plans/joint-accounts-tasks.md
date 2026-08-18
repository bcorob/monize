# Joint Accounts: Agent Task List

> Companion to [`joint-accounts.md`](./joint-accounts.md) (the design). Same conventions as
> `cross-owner-transfers-tasks.md`: one task per session/PR where practical, dependency order,
> deploy-impact classes (`none` / `inert` / `neutral`), definition of done includes
> `npm run build && npm run lint`, `TZ=UTC npm run test:unit`, migrations mirrored into
> `database/schema.sql` with `npm run migration:lint` + `scripts/verify-schema.sh` clean, and
> English-only catalogs until the final localization pass.

The governing invariants in the design doc apply to every task. If a change alters plain
(non-joint) delegation behavior or non-delegate behavior, the task is wrong -- stop.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Spec + task docs (this file) | -- | none | [x] |
| D1 | Migration: `is_joint` flag + `delegate_net_worth_exclusions` table + RLS | S1 | inert | [x] |
| D2 | Migration: delegate-read RLS arms for native reads | D1 | inert* | [x] |
| B1 | `JointAccountsService` | D1 | inert | [x] |
| B2 | `is_joint` through `setGrants` / `listDelegates` | B1 | inert | [x] |
| B3 | Union account list + account-level endpoints | B1, B2 | neutral | [x] |
| B4 | Native register read scoping | B1, D2 | neutral | [x] |
| B5 | Grantee reference-data endpoint | B1 | inert | [x] |
| W1 | `JointRegisterService`: grantee create/update/delete | B1, B4, B5 | inert | [x] |
| W2 | Transfers on joint accounts: verify freeze/reconnect (tests only) | B3, B4 | none | [x] |
| N1 | Grantee net worth includes joint accounts | B1, D1, D2 | neutral | [x] |
| N2 | Report-surface scope statement + AI/MCP exclusion assertion | N1 | none | [x] |
| F1 | Frontend types + API client | B3 | inert | [x] |
| F2 | Account list badges, attribution, filter, gated actions | F1 | inert | [x] |
| F3 | Detail page + register UX (owner pickers, permission gating) | F1, B4, B5, W1 | neutral | [x] |
| F4 | Owner management UI (Joint column, shared-with summary) | F1, B2 | inert | [x] |
| F5 | Frontend permission-gating unit coverage | F2, F3 | none | [x] |
| V1 | Backend integration suite (`joint-accounts.integration.spec.ts`) | W1, W2, N1 | none | [x] |
| V2 | Playwright e2e journey (`e2e/tests/joint-accounts.spec.ts`) | F2-F4, V1 | none | [x] |
| Q1 | Full-locale i18n pass (final acceptance commit) | all above | none | [x] |

*D2 is behavior-neutral at `RLS_MODE=off`/`shadow`; on an enforcing deployment its read arms are
live on deploy -- read-only widening gated on an active `can_read` grant, matching the app-layer
access the delegation feature already grants (the same argument task D1 of the cross-owner plan
made for `transactions`).

## Task details

### D1 -- Migration 133

`database/migrations/133_joint_account_grants.sql` + `schema.sql` mirror + entity edits.
`ALTER TABLE account_delegate_grants ADD COLUMN IF NOT EXISTS is_joint BOOLEAN NOT NULL DEFAULT
false;` and `CREATE TABLE IF NOT EXISTS delegate_net_worth_exclusions` (UUID PK, delegate FK,
account FK, `UNIQUE (delegate_user_id, account_id)`), with a bespoke RLS policy keyed on
`delegate_user_id = app_real_user_id()` (the `delegate_account_favourites` pattern) and its own
`ENABLE ROW LEVEL SECURITY` (post-123 convention). Enforcement spec learns the new table.

### D2 -- Migration 134

Read-only delegate arms (USING only; WITH CHECK stays owner-only), gated on an active delegation
+ `can_read` grant keyed to `app_real_user_id()`, template `132_cross_owner_transfer_rls.sql`:
`accounts` and `monthly_account_balances` (account-scoped via grants); `transaction_splits` and
`transaction_tags` (via their parent transaction's account); `categories`, `payees`, `tags`
(delegation-scoped -- an acting delegate already sees the owner's whole reference lists, so this
widens nothing the app layer does not already grant; the migration comment records that).
Affected tables leave the direct-ownership DO loop in `schema.sql`. No arms for
`transaction_attachments`, `scheduled_transactions`, `holdings` (v1 scope cut).

### B1 -- JointAccountsService

`backend/src/delegation/joint-accounts.service.ts` (+ spec, module wiring, eslint
`WITH_CONTEXT_ALLOWLIST` entry). `jointGrantsFor`, `jointAccountIdSetFor`, `jointAccountsFor`
(enriched rows: `isJoint`, `ownerLabel`, `jointPermissions` = grant flags AND
`JOINT_WRITABLE_ACCOUNT_TYPES`, overlaid `excludeFromNetWorth`), `jointAccessFor` (wraps
`CrossOwnerAccessService.accountAccessFor`, additionally requires `is_joint` + type policy),
`jointShareCountsForOwner`, `getNetWorthExclusions` / `setNetWorthExclusion`.

### B2 -- Grant management

`AccountGrantDto.isJoint`; `setGrants` persists it, rejects joint-without-read and joint for
non-full-account delegates; `listDelegates` returns it (round-trip regression test -- the
delete-and-recreate save must not wipe the flag).

### B3 -- Union account list

Own-context `GET /accounts` returns own rows (owners' shared rows carry `jointGranteeCount`)
plus `jointAccountsFor(realUserId)` with the delegate-favourites overlay; `findOne` / balance /
daily-balances get a joint read fallback; own-context favourite writes for joint accounts use the
delegate overlay; new `PUT /accounts/:id/net-worth-exclusion`. Account-object writes stay
owner-scoped (grantee 404s, asserted).

### B4 -- Register reads

One scoping helper in `transactions.service.ts` -- own-context predicate
`(t.user_id = :me OR t.account_id IN (:...jointIds))` -- applied to findAll, the pagination
count, page-for-transaction and running/projected balances. Mask interceptor spec proves a joint
counterpart is not masked and the same payload is masked post-revoke.

The same predicate lives once more in `transaction-analytics.service.ts` (`analyticsScope`), and
`TransactionsController.resolveOwnContextJointScope` is the single decision that feeds both: a
query filtered to exactly one joint account runs as the OWNER, anything else keeps the caller's
scope and widens it by the authorized joint ids. Any new own-context endpoint that scopes reads by
`transaction.userId` calls that helper -- the register and its analytics have to see the same rows.

### B5 -- Reference data

`GET /delegation/joint-accounts/:accountId/reference-data`: owner's categories + payees (picker
fields only) + `payeesCanCreate` / `categoriesCanCreate`, after `jointAccessFor(..., "read")`.

Its write half is `POST /categories/joint/:accountId`
(`backend/src/categories/joint-categories.service.ts`), the one path that creates a category on
the owner's ledger from the native context -- without it `categoriesCanCreate` was reported to the
client and reachable by nothing.

### W1 -- JointRegisterService

`backend/src/transactions/joint-register.service.ts`: own-context create/update/delete whose
account is not owned by the caller; authorize via `jointAccessFor`, enforce the reference-data
policy, reject tags/splits/attachments/transfer rows/account moves, then run the existing
`TransactionsService` op with `userId = ownerUserId` under `withSystemContext`; action history on
the owner's ledger with grantee attribution.

### W2 -- Transfer freeze/reconnect (verify, don't build)

Integration cases proving native own<->joint transfers work through the existing `TransferActor`
path, freeze + mask on revoke, and reconnect statelessly on re-grant.

### N1 -- Net worth

`net-worth.service.ts` monthly + latest queries widen to
`(mab.user_id = $me OR mab.account_id = ANY($jointIds))` with the owner-side
`exclude_from_net_worth` predicate confined to the own-rows arm; grantee exclusions subtracted
from `$jointIds`; missing-FX -> `null` total fixture; stale joint months refreshed under
`withUserContext(owner)`.

### N2 -- Scope statement

The v1 joint-inclusive surfaces are: union list summary cards, net worth, daily balances,
register. One spec assertion pins that AI/MCP account listings exclude joint ids.

### F1-F5 -- Frontend

Types (`isJoint`, `ownerLabel`, `jointPermissions`, `jointGranteeCount`), badges and "shared
by/with" attribution in `AccountRow` / `AccountDetailShell`, "Shared with me" filter, permission-
gated actions, owner-list pickers in `TransactionForm` for joint context, transfer-candidate
dedupe, `DelegateAccessModal` Joint column with read-implies rule and full-account gating,
`AccountForm` "Shared with N" summary, Vitest permission matrix.

### V1 / V2 / Q1

Backend integration journey (grant -> union -> native write -> net worth -> revoke -> frozen/
masked -> re-grant -> reconnect; `revokeDelegate` never deletes a grantee who owns accounts);
Playwright journey over the real UI; single full-locale localization pass as the final commit.
