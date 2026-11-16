# Split transactions in bulk update and `manage_transactions`

Shipped and kept as the specification: split transactions can be updated
through the Transactions page bulk update tool and through the
`manage_transactions` AI tool (AI Assistant and MCP, which share
`backend/src/transactions/transaction-tool-prep.service.ts`). The invariants
and truth tables below are the ones the code cites by name.

## Product decisions

1. **Bulk category = recategorize matching lines.** When a bulk update sets a
   category and the selection includes split parents: in filter mode with real
   category UUIDs in `filters.categoryIds`, only split lines whose category is
   in that (descendant-expanded) set change; otherwise (ids mode, or no category
   filter) all category-kind lines change. Transfer-kind and investment-kind
   lines are never touched. The parent stays a split; its amount is unchanged,
   so no balance is affected. Split parents are no longer dropped from the
   batch: parent-level fields (payee, description, status, tags) apply to them
   in the same run.
2. **AI category or amount changes on an existing split require the full
   `splits` array.** Providing `splits` replaces the whole set, validated
   against the effective post-edit amount. Non-category parent fields (payee,
   date, description) update without `splits`. A `categoryName` or `amount`
   change without `splits` on an existing split is refused at preview time with
   an actionable message telling the model to read the current lines and resend
   the complete set.
3. **Clearing the category in bulk (`categoryId: null`) treats split lines
   uniformly**: matching category-kind lines get a NULL category (the schema
   permits it; `ON DELETE SET NULL` already produces such rows).

## Invariants

| # | Invariant |
|---|---|
| I1 | A split parent always has `is_split = true`, `category_id IS NULL`, and `amount = SUM(splits.amount)` at 4dp (`backend/src/common/split-amount.util.ts`). No bulk or AI path changes the parent's amount or category without a full split-set replacement validated against the effective amount. |
| I2 | Bulk recategorization writes only `transaction_splits` rows with `kind = 'category'`. Transfer and investment lines are never written. |
| I3 | Every write to `transaction_splits` is scoped via a join back to `transactions` with `t.user_id = :userId` (the table has no `user_id`; RLS is indirect). |
| I4 | Recategorization changes no amounts, therefore no account balance, no transfer counterpart, and no net-worth snapshot. |
| I5 | `updated` counts only parents that received at least one write; a parent that received nothing is `skipped` with a translated reason. Split lines changed is a sibling count (`splitLinesUpdated`), never folded into `updated`. |
| I6 | Split-line writers serialize on the parent row lock (`lockTransactionRows` in `backend/src/common/db/locks.ts`), the same lock `updateSplits` and `addSplit` take. |
| I7 | An AI/MCP update that would break I1 is refused at preview time, before a descriptor is signed; confirm-time still re-validates under the lock. |

## Truth table A — bulk update, selection includes split parent P

`F` = the category filter ACTIVE in the UI when the update was issued, after
stripping the `"uncategorized"` / `"transfer"` pseudo-ids and expanding
descendants (same expansion the selection uses). The client carries it on the
command as `categoryFilterIds` in BOTH selection modes — the restriction keys
off the filter itself, never off the selection mode, because hand-picked rows
arrive as mode `ids` and must still honor the filter the user was looking
through. Filter-mode `filters.categoryIds` remains a fallback source for
payloads without the field.

| dto sets | Active filter | Lines changed | Result for P |
|---|---|---|---|
| `categoryId=X` only | F empty (no category filter) | all category-kind lines → X | updated; lines counted in `splitLinesUpdated` |
| `categoryId=X` only | F non-empty (either selection mode) | lines with category in F → X | updated if at least one line changed, else skipped with reason |
| `categoryId=X` only, P has only transfer/investment lines | any | none | skipped with reason |
| `categoryId=X` plus any parent field | any | as above | always updated (parent fields applied); no skip reason |
| parent fields only, no `categoryId` | any | none | unchanged from previous behavior |
| `categoryId=null` | any | matching lines → NULL | uniform treatment (decision 3) |

Numerical example: parent −100.00 with lines Groceries −60.00 (category),
Household −25.00 (category), transfer −15.00. Bulk set category = Dining:

- ids mode: both category lines become Dining; the transfer line is untouched;
  the parent amount stays −100.00; `updated += 1`, `splitLinesUpdated += 2`.
- filter mode with `categoryIds = [Groceries]`: only the −60.00 line changes;
  `splitLinesUpdated += 1`.
- filter mode with `categoryIds = [Utilities]`, P selected via search: no line
  matches, so P is skipped with a reason — unless the same run also sets a
  parent field such as `status`, in which case P is updated.

## Truth table B — `TransactionsService.previewUpdate` on target T

| T | Input | Outcome |
|---|---|---|
| non-split, non-transfer | any valid | unchanged |
| transfer | any | unchanged: `errors.transactions.cannotEditTransfer` |
| split | `splits` provided (with or without other fields, including `amount`) | OK; splits validated against the effective amount by `resolveSplits` |
| split | payee / date / description only | OK — parent-field edit; lines untouched |
| split | `categoryId` set, no `splits` | BadRequest `errors.transactions.splitCategoryNeedsSplits` |
| split | `amount` set, no `splits` | BadRequest `errors.transactions.splitAmountNeedsSplits` |
| split | no fields | unchanged: `errors.transactions.noUpdateFields` |

## Known limitations

- Bulk parent-field edits (and AI parent-only edits) do not re-sync a
  split-transfer counterpart leg's payee or date; counterpart rows are rebuilt
  only when a full split set is resent. This predates this feature and is
  deliberately unchanged here.
- Bulk delete does not restore `transaction_splits` rows on undo (pre-existing
  gap in `backend/src/action-history/action-history.service.ts`); this feature
  does not change bulk-delete undo.

## Future work

- `splitId`-targeted AI line edits: read rows from
  `TransactionsService.getLlmTransactionRows` already expose one row per split
  line carrying the parent `id` plus `splitId`, but the write tools deliberately
  accept only a full `splits` replacement. A targeted single-line edit would
  need its own schema and preview shape.
