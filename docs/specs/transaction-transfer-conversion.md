# Spec: Converting a transaction to a transfer, and a transfer to a transaction

Issue #1937 (approved in Discussion #1929). The edit form offers every mode a new
entry offers (Transaction, Split, Transfer) on an existing row, and two routes
convert the row in place. A row keeps its id across a conversion, so its
attachments, warranties, tags and history stay attached to it.

## 1. Invariants

- **One transaction, nothing written before a refusal.** Every check that can
  refuse a conversion (ownership, the strict reconciled lock, the row's shape,
  the counterpart's state) runs under the row locks, inside the same
  `withScopedDb` as the writes. `docs/financial-calculation-contract.md`
  section 7.
- **The row keeps its id.** The converted row is the leg (or the transaction)
  the user asked for; the counterpart is the only row created or deleted.
- **Balances move by what the rows contribute (INV-BALANCE-001).** The old
  shape is reversed through `deletionBalanceEffect` and
  `deleteSplitSideEffects`, exactly as a deletion reverses it; the new shape is
  posted exactly as a create posts it (`transferLegColumns` is the create's own
  column set). A VOID row moves nothing in either direction
  (INV-TRANSFER-001); a future-dated row on either side is folded in by a
  recomputation, not a delta.
- **Derived state is invalidated after the commit (INV-CACHE-001):** every
  account the conversion touched, including a removed split child's
  counterpart account, is reported to the net-worth recompute once the
  transaction has committed.
- **A reconciled counterpart warns, and blocks under the lock.** Converting a
  transfer away deletes its other leg. The client warns when that leg is
  CLEARED or RECONCILED; the server refuses when it is RECONCILED and the user
  has "Lock reconciled transactions" on (`assertReconciledRowsMutable` over
  both legs), with nothing written.
- **A pair is converted from the pair, not from a child.** A split-transfer leg
  (its link names a split parent) and a cross-owner pair (its counterpart is
  another owner's row) are refused: the first is changed on its parent, the
  second is deleted and recreated.
- **History records the conversion and refuses to undo it.** The entry's
  `beforeData.isTransfer` differs from `afterData.isTransfer`; the undo path
  refuses such an entry because the counterpart it would need cannot be
  replayed from the snapshot.

## 2. Truth table: transaction -> transfer

Input: the row `R` in account `A`, and the transfer body `{fromAccountId,
toAccountId, amount, ...}` the Transfer tab sends.

| R today | from/to | Result |
|---|---|---|
| income or expense in A | A -> B | R becomes the source leg (`-amount`), counterpart `+toAmount` created in B |
| income or expense in A | B -> A | R becomes the destination leg (`+toAmount`), counterpart `-amount` created in B |
| income or expense in A | B -> C | R becomes the source leg and moves to B; A is reversed by what R contributed |
| split parent in A | any | its split lines and their counterparts and embedded rows are removed first, then as above |
| transfer leg | any | refused: `errors.transactions.alreadyATransfer` |
| RECONCILED and lock on | any | refused: `reconciledLockedError` |
| either account another owner's | any | refused: `errors.transactions.convertTransferCrossOwner` |

The row's foreign-currency entry (`originalAmount`, `originalCurrencyCode`) is
cleared: a leg's currency is its account's. Its `externalId` stays while the
row stays in its account, so a retry of the create that wrote it still finds
it; a row that moves to another account drops the key, which is unique per
account and would otherwise collide at commit. A body naming no `status`
keeps the locked row's own status on both legs. Tags: the body's `tagIds`
replace both legs' set when present; otherwise the row's tags are mirrored
onto the counterpart, as a plain transfer shares one set.

## 3. Truth table: transfer -> transaction

Input: the leg `R`, and the transaction body (`UpdateTransactionDto`, splits
included) the Transaction or Split tab sends.

| R today | counterpart | Result |
|---|---|---|
| plain transfer leg | UNRECONCILED | counterpart deleted and its balance reversed; R detached and updated with the body |
| plain transfer leg | CLEARED or RECONCILED, lock off | client warns; then as above |
| plain transfer leg | RECONCILED, lock on | refused with nothing written |
| plain transfer leg | missing (one-sided after a frozen delete) | R detached and updated; nothing to delete |
| split-transfer leg | split parent | refused: `errors.transactions.splitTransferLegConvertLocked` |
| plain transfer leg | another owner's row | refused: `errors.transactions.convertTransferCrossOwner` |
| not a transfer | | refused: `errors.transactions.notATransfer` |

The detached row's `exchangeRate` goes back to 1 (the destination leg held the
pair's rate). The body is then applied by `TransactionsService.update` inside
the conversion's transaction (nested `withScopedDb` joins it), so category,
amount, account, splits, status and tags follow the generic update's rules and
balance arithmetic on the detached row; the update collects the accounts and
securities it moved (`deferDerivedRecompute`) and the conversion dispatches
them after its commit.

## 4. Numerical examples

Chequing 1,000.00 CAD holds `R = -50.00` (Groceries). Savings 2,000.00 CAD.

- Convert R to a transfer Chequing -> Savings of 50.00: Chequing reversal
  `+50.00`, source leg `-50.00`, so Chequing stays 1,000.00; Savings gains
  `+50.00` to 2,050.00. R: `amount -50.00, isTransfer true, categoryId null`.
- Convert R to a transfer Savings -> Chequing of 50.00: Chequing `+50.00`
  (reversal) `+50.00` (destination leg) = 1,100.00; Savings `-50.00` = 1,950.00.
  R: `amount 50.00`.
- Convert R (a VOID expense) to a transfer with status VOID: no balance moves;
  both legs are VOID.
- Convert the Chequing leg of a 100.00 CAD -> 135.00 CAD transfer back to a
  Groceries expense of `-100.00`: Savings `-135.00` (counterpart removed);
  Chequing unchanged.
- Euro 500.00 EUR -> Chequing 100.00 EUR at 1.25 posts `+125.00 USD` with
  `exchangeRate 1.25` on the Chequing leg. Converting that leg to an expense
  keeps `125.00 USD`, resets its rate to 1, and returns Euro to 500.00.
- Convert the `-50.00 USD` expense to Chequing -> Euro with `toAmount 40`:
  the row stays `-50.00 USD` at rate 1, the Euro leg is `+40.00 EUR` at 0.8.

## 5. Missing-data policy

A cross-currency conversion to a transfer resolves its rate exactly as the
create does (`prepareTransfer` -> `resolveTransferFx`): a supplied rate or
destination amount is used, otherwise the stored market rate for the date;
with neither the request is refused (`errors.transactions.transferRateUnavailable`).
Nothing posts at 1:1 by default.

## 6. Test matrix

| Claim | Test |
|---|---|
| balances after each conversion equal the ledger; the counterpart is created or removed; the row keeps its id | `backend/test/integration/transaction-conversion.integration.spec.ts` |
| a reconciled counterpart under the lock refuses with nothing written | same |
| cross-currency in each direction: the destination leg's rate is stored on the way in and reset to 1 on the way back | same |
| a body without `status` keeps the row's; a moved row drops its `externalId`, a staying row keeps it | same, and `transaction-conversion.service.spec.ts` |
| the nested update's recomputes are dispatched after the conversion's commit | `transaction-conversion.service.spec.ts` |
| a split-transfer leg and a cross-owner pair are refused | same, and `backend/src/transactions/transaction-conversion.service.spec.ts` |
| the write path's column set is the create's | `transaction-conversion.service.spec.ts` |
| the undo of a conversion is refused | `backend/src/action-history/action-history.service.spec.ts` |
| the edit form offers the three modes, calls the conversion routes, warns on a cleared or reconciled counterpart, and keeps a split-transfer leg locked | `frontend/src/components/transactions/TransactionForm.test.tsx` |
