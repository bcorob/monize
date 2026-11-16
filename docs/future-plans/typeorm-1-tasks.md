# TypeORM 1: Agent Task List

The task graph for `docs/future-plans/typeorm-1.md`. Read the plan's "Approach"
first: every task after T1 removes reliance on the compatibility setting in one
area, and T6 removes the setting.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task names the area it may touch. A file
  outside it is a separate task.
- Tasks T2 to T5 are independent of each other and can land in any order after
  T1.
- Name the invariant IDs a task touches in its PR. Most are on the read paths
  (balances, holdings, reports), so `docs/financial-semantics.md` and
  `docs/system-invariants.md` apply.

## Definition of done for every task

- Backend gate from `AGENTS.md`: lint, `tsc --noEmit`, unit suite with coverage
  at or above the thresholds, `npm run build && npm run test:integration`.
- Every `where` changed in the task has a unit case for an `undefined` (and,
  where the column is nullable, a `null`) input asserting the decided
  behaviour. No `?? undefined`, spread or cast whose only purpose is silencing
  the new error.
- A semantic change to what a query returns is called out in the PR body, with
  the old and new result for the same input.

## T1: version switch with 0.3 semantics

- Bump `typeorm` to the latest 1.x outside the Dependabot cooldown.
- Run `npx @typeorm/codemod v1 src/` and review its diff by hand: `relations`
  and `select` arrays to objects (nested strings to nested objects),
  `findByIds` to `findBy({ id: In(ids) })` with the empty-list case keeping
  its no-query early return.
- Update the unit specs that assert on find options.
- Set `invalidWhereValuesBehavior: { null: "ignore", undefined: "ignore" }` on
  every DataSource the plan lists, with a comment pointing at this file.
- Delete the `typeorm-compat` test stand-in and its `moduleNameMapper` entries
  if #1567 has not already.
- Audit the 21 finds with a `lock` option: any that also passes `relations`
  moves to the query builder.
- Proof: unchanged query results. Full integration suite and E2E green.

## T2: accounts, transactions, splits, transfers

Make every `where` under `backend/src/accounts/`, `backend/src/transactions/`
and their helpers safe without the compatibility setting. These are the
balance-moving paths: a widened `where` here changes a balance.

## T3: investments and pricing

`backend/src/securities/`, `backend/src/net-worth/`, investment reports and the
price and exchange-rate services. A dropped predicate here mixes securities or
currencies; check every `FxAggregate` caller's inputs.

## T4: sharing, delegation, joint accounts, auth

`backend/src/delegation/`, `backend/src/auth/`, `backend/src/users/` and the
OAuth and MCP modules. A dropped owner or delegate predicate here is an
authorization defect, not just a wrong total; each site gets a negative test
with a second user's data present.

## T5: everything else

The remaining modules (budgets, payees, categories, scheduled transactions,
reports, notifications, AI, backup and import). Start from a run of the
integration suite with the setting temporarily off and work through what
throws.

## T6: remove the compatibility setting

Delete `invalidWhereValuesBehavior` from every DataSource. Run the full
integration suite and E2E; anything still passing `undefined` now throws.
Remove the typeorm entry from the Dependabot `ignore` list in the same PR.
