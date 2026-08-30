# Spec: scheduled loan installment pricing

Status: implemented on `claude/issue-1253-6e3rel`.
Governs: issue #1253 -- scheduled loan payment interest drifts from the
amortization report -- including the two residual findings from the audit of
the first proposed fix (PR #1254): a split resolved too early goes stale, and
a report anchored on today disagrees with a bill anchored on its due date.
Registered as INV-LOAN-006 in `docs/system-invariants.md`.

Read `docs/financial-calculation-contract.md` sections 1, 7 and 8, and
`docs/specs/account-balances-as-of.md`, before changing anything here.

## 1. The invariant

For a scheduled loan installment due on date `d`:

```text
debt(d)   = max(0, -(opening_balance + SUM(amount)
              over transactions WHERE account_id = loan
                AND (status IS NULL OR status <> 'VOID')
                AND parent_transaction_id IS NULL
                AND transaction_date <= d))
rate(d)   = latest loan_rate_changes row with effective_date <= d,
              else accounts.interest_rate
interest  = roundMoney(debt(d) * periodicRate(rate(d)))
principal = payment - interest, through allocateLoanPayment's waterfall
```

The ledger expression is the canonical as-of balance
(`docs/specs/account-balances-as-of.md` section 3, INV-BALANCE-001's source),
with the installment's due date in place of today. The periodic-rate rules are
unchanged: nominal annual rate over periods per year for loans and
non-Canadian mortgages, the semi-annual-compounding effective rate for a
Canadian fixed-rate mortgage, `periodsPerYearForStoredFrequency` for the
count in both spellings of the frequency column.

Both inputs are dated at `d`, for the same reason: a payment or a rate change
recorded for next month belongs to next month's installment.

Three sources are explicitly **not** inputs:

- **The previously stored split.** `next = prev_interest - prev_principal *
  rate` is algebraically equivalent to pricing from balance only at full
  precision; stored splits are money already rounded to 4dp, so the recurrence
  carries the discarded fraction into every later bill (the issue's 98.0101
  versus 98.0000).
- **`accounts.current_balance`.** It is a through-today read model and
  deliberately excludes future-dated rows, so after a future-dated payment
  posts it repeats the old balance and the old interest.
- **`accounts.interest_rate` alone.** Recording a rate change deliberately does
  not write that column -- it stays user-owned, settable only from the account
  edit form -- so it holds the OLD terms after any change entered through the
  rate-history UI. It is the *fallback* when no timeline row applies, never the
  first answer. `effectiveAnnualRateOn` is the rule, and its truth table
  (`backend/src/accounts/loan-rate-timeline-cases.json`) is asserted by both
  layers because they cannot import each other.

## 2. Where it is priced

`ScheduledTransactionLoanService.resolveInstallment` is the one pricing path.
Three consumers resolve through it, and they must, because each one answered
differently is a reported drift:

| Consumer | Boundary `d` | When |
| --- | --- | --- |
| `recalculateLoanPaymentSplits` | the schedule's `next_due_date` (already advanced) | after each posting; writes the template for the next occurrence |
| `resolvePostingAllocation` | the occurrence's own due date | inside the posting transaction, under the parent lock, immediately before the financial write |
| `getLoanProjectionAnchor` | the schedule's `next_due_date` | on demand, for the amortization report's projection (`buildLoanProjectionInput`'s `anchor`) |

Which schedule is "the loan's payment" is the account's own statement --
`accounts.scheduled_transaction_id`, written by the two paths that set a loan
payment up. Reaching instead for "any active schedule with a transfer split
into this loan" answers a different question: a standalone extra-principal
transfer is an ordinary configuration and, due sooner, would anchor the report
on an installment no bill will post. The fallback for a loan whose pointer was
never written accepts both spellings of the linkage (the top-level
`transfer_account_id` column and a split), because a plain scheduled transfer
into a loan carries no split.

The posting boundary is the date the occurrence's money actually moves --
`postDate`, which an override can move off the recurrence slot -- because that
is the date interest accrues to.

The debt is read under the lock that authorizes the write, not merely inside
the same transaction (`CONC-001`). The scheduled-transaction row lock does not
serialize this: no ledger writer takes it, so a principal payment could commit
between the debt `SELECT` and the posting's own write and the split would be
priced from a balance already stale when it was written. The posting therefore
takes `lockAccountsForBalanceWrite` on the source and loan accounts before it
prices and holds it to commit -- the primitive every balance writer already
takes, which is what makes a concurrent ledger write queue behind it.
`scheduled-loan-pricing-concurrency.integration.spec.ts` proves the protocol
with two real connections; `pricing-lock.guard.spec.ts` proves the posting
takes it, because the integration harness stubs the scheduled module and cannot
construct the real `post()`.

The posting-boundary resolution is what makes the stored split safely a
**template**: a principal-only payment, void, delete or import committed
between occurrences changes what the next posting writes without any of those
mutation paths having to know about loan templates. When nothing moved, the
resolution reproduces the persisted amounts exactly (same balance, same rate,
same waterfall), so the common case is byte-identical.

## 3. What does not re-resolve

- **An inline amount or a stored override amount** is the user's explicit
  statement for that one occurrence and is posted as given. So is a figure the
  user typed in the Post dialog -- but "typed" has to be decided, not assumed:
  that dialog echoes the stored template back as *inline* splits AND sends the
  parent `amount` on every non-foreign post, so treating the presence of an
  amount as a user instruction made this whole path unreachable from the only
  surface that produces inline splits. An echo is recognised by value (each
  line against its `sourceSplitId`, the parent against the template's own
  amount); anything that differs is the user's statement. Without that, the
  dialog -- the path users actually take -- posts the stale allocation the
  auto-post path avoids, the same occurrence posting two different amounts
  depending on which button was pressed.

- **A posting never grows the total.** The parent an occurrence posts is the
  bill the user was shown; re-pricing re-divides it between interest and
  principal. Only a template advancement may grow the parent back toward the
  account's configured payment (review #1131) -- doing that at posting time
  would move more money than any surface displayed. It may still *shrink*: the
  waterfall clamps principal to the debt that is actually left, so an
  occurrence retires the loan rather than overpaying it into credit.
- **A template shape the resolver cannot account for** (an escrow line, no
  identifiable interest line) declines -- the posting proceeds on the
  persisted amounts and the recalculation writes nothing, exactly as the
  recalculation has always declined, because repricing only the managed lines
  leaves the parent unequal to the sum of its children and the split
  validator then refuses every occurrence.
- **A ledger that cannot be read refuses.** It is not "this is not a loan
  template": returning null there would post the stale stored split, the exact
  defect this exists to prevent, so the posting rolls back and the anchor
  endpoint answers an error rather than the `{null, null}` the report reads as
  "no scheduled payment, project from today".

- **A debt already retired through the boundary posts NO money** -- for a
  template whose every line the payoff settles. The occurrence is still claimed
  and the schedule still advances, so nothing retries it; the recalculation
  then deactivates the schedule. Withholding the write is the point: the stale
  template still says 1,500, and charging it would record interest against a
  debt that no longer exists and push the loan into credit.

  Two carve-outs, and both matter:

  - **A template carrying a line the payoff does not settle still posts.** The
    debt check therefore runs *after* the shape is resolved, so it can say
    whether this is a bill this service accounts for end to end. Read the other
    way round, a mortgage template with an escrow, tax or insurance line
    reports the same "paid off" as a plain principal + interest one, and
    withholding its money silently stops paying the escrow.
  - **A LINE OF CREDIT stays active.** It is revolving: a facility at a zero or
    credit balance is not a finished loan, the user can draw on it again
    tomorrow, and deactivating its schedule is not recoverable from the UI.
    This matters since the debt became `max(0, -balance)`: an overpaid account
    in credit now reads as owing nothing, where the old `Math.abs` read a
    credit balance as fresh debt and kept amortizing it.

  `LoanPostingDecision` is what keeps this straight. "There is nothing to price
  here" and "the price is zero" are different instructions, and collapsing both
  into `null` is precisely how the retired case went on charging its whole
  stale installment.
- **FX schedules, transfers and investments** do not carry the loan template
  shape and never reach the resolver.

## 4. Report parity

`GET /scheduled-transactions/loan-anchor/:accountId` answers
`{ nextDueDate, debt }` -- the due date of the schedule the loan account names
as its payment (section 2), and `debt(nextDueDate)`. The Loan Amortization
Report fetches it inside the same request key as the loan's history (a failed
fetch reaches the report's error state; "no anchor" is not a fallback for an
outage) and hands it to `buildLoanProjectionInput`, so the first projected
row and the next bill are measured at the same date against the same balance.

Both the balance and the rate are now shared, so the first projected row and
the next bill agree on both inputs. Which surface passes the anchor is
enumerated by `frontend/src/lib/loan-projection-anchor.guard.test.ts` rather
than left to an optional argument nobody has to think about.

The **payment** is deliberately outside this: a rate change reaches the
schedule's installment through `LoanRateChangesService.syncScheduledTransaction`,
which asks the user first, so a declined sync leaves the bill at the old
payment by their decision. Interest is unaffected -- it is debt x rate.

Both fields null means the loan has no active scheduled payment; there is no
bill to be in parity with, and the projection keeps its today-anchored
fallback (`advanceDate(today)` against `history.currentBalance`).

**An OVERDUE anchor is refused, and falls back the same way.** "Behind us" is
a question about the **user's** calendar day, and the projection is passed one:
`todayYmd`, from `financialTodayYmd` (`frontend/src/lib/financial-today.ts`,
reached through the `useFinancialToday` hook), which prefers the stored
timezone preference and falls back to the browser zone -- term for term the
order `RequestContextInterceptor` uses to answer `todayYMD()` for the request
that priced the bill. `new Date().toISOString().slice(0, 10)` is a third
calendar belonging to neither layer: east of Greenwich it still reads yesterday
for the first hours after local midnight (fourteen at UTC+14) and west of it it
already reads tomorrow through the evening, so inside that window the report
accepted an anchor the bill had already marked overdue -- or refused one due
today. `frontend/src/lib/loan-projection-today.guard.test.ts` fails a projection
call that does not state its day, one that derives it any other way, and any
`toISOString()` day-slice in the module or its call sites.

The anchor's
debt is measured through the installment's own date, which is right while that
date is ahead and wrong the moment it is behind: everything the ledger did
after it -- a repayment, a draw, a rate change -- is real, is already on screen
in the history, and is invisible to a projection seeded from the older balance.
The generated rows would also be dated *before* history rows they are appended
after, so the schedule reads out of order. Reconciling an overdue schedule
properly means replaying each missed occurrence against the events that
followed it, which is a product decision about what an overdue bill means; the
honest interim answer is the one that predates the anchor, and the first row
then no longer matches the overdue bill -- a visible imprecision rather than a
confidently wrong balance path.

Which surfaces are anchored is enumerated by
`frontend/src/lib/loan-projection-anchor.guard.test.ts`, and the guard is the
authority: the **amortization report** and the **loan detail schedule table**
are bill-anchored, because both print per-installment interest and would
otherwise show two different figures for one payment. The Debt Payoff
Timeline and `useLoanProjection` stay today-anchored -- they project an
aggregate from where the borrower stands today and make no per-installment
parity claim.

## 5. Numerical examples

6% nominal, monthly (periodic rate 0.005), configured payment 1,500:

| Ledger through `d` | debt(d) | interest | principal |
| --- | --- | --- | --- |
| opening -200,000, nothing else | 200,000 | 1,000.00 | 500.00 |
| + principal-only +1,500 dated before `d` | 198,500 | 992.50 | 507.50 |
| + another +500 dated exactly on `d` | 198,000 | 990.00 | 510.00 |
| + 1,500 dated after `d` | unchanged | unchanged | unchanged |
| + a VOID row, any date | unchanged | unchanged | unchanged |
| + a split child dated before `d` | unchanged (its parent already counts) | | |

The issue's own rounding case: debt 19,600, stored splits -399.99 / -100.01.
The recurrence gives `100.01 - 399.99 * 0.005 = 98.0101`; the invariant gives
`19,600 * 0.005 = 98.0000`.

## 6. Test matrix

- Unit (`scheduled-transaction-loan.service.spec.ts`): prior rounded splits
  deliberately inconsistent with the balance; the dated query bounded by
  `next_due_date` with its parameters asserted; posting-boundary resolution
  (stale template repriced, idempotence, decline on unmanaged shape, a
  `retired` decision on retired debt -- `LoanPostingDecision` keeps it apart
  from `not-applicable`, which posts the persisted amounts, so the two are
  asserted separately -- extra-principal line); Canadian and non-Canadian mortgage
  rates unchanged; LINE_OF_CREDIT still supported; final-payment and
  extra-principal clamps unchanged; anchor endpoint shapes.
- Unit (`scheduled-transactions.service.spec.ts`): `post()` writes the
  ledger-derived allocation with the parent re-summed; posts the persisted
  amounts byte-identically when the ledger did not move; honours an override
  amount.
- PG integration (`scheduled-loan-dated-balance.integration.spec.ts`): the
  as-of SQL against a real database -- boundary inclusive, later rows
  excluded, VOID excluded, split children excluded -- through all three
  consumers.
- Frontend (`loan-history.test.ts`, `LoanAmortizationReport.test.tsx`): the
  anchored projection starts at the anchor's debt on the anchor's date and
  its first row's interest equals the bill's; `{null, null}` keeps the
  fallback; a retired anchored debt refuses the projection; the report calls
  the anchor endpoint inside the history request key; an anchor overdue in the
  user's zone is refused while UTC still reads yesterday, and one due today is
  kept while UTC already reads tomorrow.
- Frontend (`financial-today.test.ts`): the calendar day at pinned instants in
  named zones -- positive offset, negative offset, both extremes, and the
  browser fallback -- so a boundary case discriminates on any runner rather
  than only on one whose `TZ` happens to sit on the wrong side of it.
