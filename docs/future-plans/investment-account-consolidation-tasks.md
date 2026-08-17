# Investment Account Consolidation: Agent Task List

> Companion to [`investment-account-consolidation.md`](./investment-account-consolidation.md)
> (the design). Same conventions as `joint-accounts-tasks.md` and
> `cross-owner-transfers-tasks.md`: one task per session/PR, dependency order, mark a task done
> by checking its box and noting the branch/PR.

## How to use this list (read first, every session)

- One task per session/PR. Touching files outside the task's scope is a scope violation -- stop
  and leave a note here instead.
- The design doc's invariants govern every task. Invariant 7 is the tripwire: if your change
  alters how a non-investment account lists, labels, closes or filters, the task is wrong.
- **Definition of done, every task:** `npm run build && npm run lint` clean in each touched app;
  `TZ=UTC npm run test:unit` (backend) / `npm run test` (frontend) green with coverage
  thresholds held; new user-facing strings land in the **English catalogs only**
  (`frontend/src/i18n/messages/en/`, `backend/src/i18n/locales/en/`) followed by
  `npm run i18n:pseudo`; the full-locale pass is task Q1 and nothing before it. Parity-test
  failures for non-English locales are expected on this branch until Q1.
- **Line numbers and code excerpts in these docs are snapshots.** Re-locate by symbol name
  (`buildAccountActions`, `close()`, `holdingsByAccount`), not by line.
- No migrations exist in this plan. If a task appears to need one, the task is wrong -- stop.

## Deployment safety

Same meaning as in `row-level-security-tasks.md`:

| Class | Meaning |
|---|---|
| none | Docs or tests only; no runtime change. |
| inert | Ships dark: new code/fields nothing consumes yet. Deployable any time. |
| neutral | Behavior changes are the intended feature and the app is consistent after the task alone. Deployable any time. |

Nothing in this plan is DO NOT DEPLOY; the graph is ordered so `main` is shippable after every
merged task.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Design doc + this task list | -- | none | [x] |
| A1 | `logical-accounts.ts` fold + `useLogicalAccounts.ts` + `useAccountOptionLabel` | S1 | inert | [x] |
| A2 | Backend `unpricedHoldingsCount` on `AccountHoldings` | S1 | inert | [x] |
| B1 | Symmetric close/reopen + holdings close guard | S1 | neutral | [x] |
| B2 | Pair rename propagation in `update()` | S1 | neutral | [x] |
| L1 | Account list: one row per pair (render only) | A1, A2 | neutral | [x] |
| L2 | Account list actions: reconcile/close/reopen/delete pair-aware | L1, B1 | neutral | [x] |
| D1 | Extract `InvestmentViewToggle.tsx`; swap `/investments` onto it | S1 | neutral | [x] |
| D2 | `InvestmentRegisterPanel.tsx` + mount in `InvestmentDetailView.tsx` | D1, A1 | neutral | [x] |
| D3 | Detail canonical URL + shell title + switcher fold | A1 | neutral | [x] |
| E1 | AccountForm investment-pair mode | A1, B2 | neutral | [x] |
| P1 | Picker + register labels through `useAccountOptionLabel` + guard scan | A1 | neutral | [x] |
| R1 | `ReportAccountMultiSelect` mode unification | A1 | neutral | [x] |
| R2 | `AccountBalancesReport` logical rows | A1, A2 | neutral | [x] |
| R3 | `FavouriteAccounts` card dedupe + dashboard count | A1, A2 | neutral | [x] |
| V1 | Playwright e2e journey | L2, D2, D3, E1, P1 | none | [x] |
| Q1 | Full-locale i18n pass (final acceptance commit) | all above | none | [x] |
| S2 | Docs as-built pass + contract note | all above | none | [x] |

**Why A1/A2 precede every UI task:** every surface consumes the fold and the unpriced-holdings
signal; landing them first (dark) means each UI task is a consumer-only diff. **Why B1 precedes
L2:** the list's single Close action calls the API once with the primary id and needs the server
cascade to exist -- a frontend-only cascade would race and violate "a rejected command must not
already have written". **Why B2 precedes E1:** the form's single name field submits one rename
and relies on the server converging both halves. **Why D1 precedes D2:** the toggle is extracted
from `/investments` first so the panel and the page provably share one component rather than a
copy.

## Task details

### A1 -- Logical-account fold

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/lib/logical-accounts.ts` (new), `frontend/src/lib/logical-accounts.test.ts`
(new), `frontend/src/hooks/useLogicalAccounts.ts` (new), `frontend/src/lib/account-utils.ts`
(delegate `countLogicalAccounts`), `frontend/src/hooks/useMainAccountName.ts` (add
`useAccountOptionLabel`).

**Do:**
1. Implement `buildLogicalAccounts` / `LogicalAccount` exactly per the design's shape: fold rule
   (cash half absorbed only when its partner is in the input), canonical id = brokerage half,
   `cashRegisterId` per the truth table, `combinedValue` = market value + cash `currentBalance`
   + cash `futureTransactionsSum`, null when `unpricedCounts` reports > 0 for the holdings
   account or market value is missing for an account with holdings. No FX -- the halves share a
   currency by construction.
2. `useLogicalAccounts` memoizes over accounts + portfolio summary and injects
   `useMainAccountName()` as the strip function. `useAccountOptionLabel` returns the standard
   picker label builder (stripped name + currency + closed marker).
3. `countLogicalAccounts` delegates to the fold. Nothing else consumes it yet.

**Accept:** unit tests: pair folds to one entry (primary = brokerage, `cashRegisterId` = cash
id, both member ids present); standalone -> `cash` null, `cashRegisterId` = self; orphan
brokerage -> `cashRegisterId` = self; orphan cash -> its own entry with stripped name;
**regression: `combinedValue` is null, not the cash subtotal, when any holding is unpriced**;
existing `countLogicalAccounts` tests unchanged and green.

### A2 -- Backend unpriced-holdings count

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `backend/src/securities/portfolio-calculation.service.ts` (both `holdingsByAccount`
build loops -- pair path and standalone path), `backend/src/securities/portfolio-calculation.service.spec.ts`,
`frontend/src/types/investment.ts` (`AccountHoldings.unpricedHoldingsCount: number`).

**Do:** count holdings whose `marketValue` is null per account and emit
`unpricedHoldingsCount` on each `AccountHoldings` entry. Do **not** change `totalMarketValue`
semantics -- existing consumers (sorting, summary) stay valid; this is an additive field only.

**Accept:** spec: an account with one null-priced holding reports `unpricedHoldingsCount: 1`
and an unchanged `totalMarketValue` -- a test that fails against the pre-change payload; an
all-priced account reports 0. Inert: nothing reads the field yet.

### B1 -- Symmetric close/reopen + holdings close guard

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `backend/src/accounts/accounts.service.ts` (`close()`, `reopen()`),
`backend/src/accounts/accounts.service.spec.ts`, `backend/src/i18n/locales/en/errors.json`
(new key, English only).

**Do:**
1. Mirror the existing cash -> brokerage close cascade for brokerage -> cash, in both `close()`
   and `reopen()`, inside the same transaction under the same `pessimistic_write` lock.
2. Add the holdings guard: refuse close when the account's own holdings -- or, when closing
   from the cash side, the linked brokerage's -- include any nonzero quantity. Message via
   `tr(...)` with the new key. The check runs inside the mutation's transaction (financial
   contract section 7).

**Accept:** specs: closing the brokerage closes the cash half (**regression -- fails on the
current asymmetric code**); closing either half of a pair whose brokerage holds positions is
refused with no write (**regression -- fails on the `currentBalance`-only guard**); reopen
mirrors close; standalone and orphan accounts unaffected. Neutral: the cascade widens behavior
the UI already implies, and the guard only refuses closes that were silently wrong.

### B2 -- Pair rename propagation

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `backend/src/accounts/accounts.service.ts` (`update()`; reuse the suffix helpers in
`backend/src/accounts/account-name.util.ts`), `backend/src/accounts/accounts.service.spec.ts`.

**Do:** when `update()` changes `name` on either half of a linked pair: derive the base name by
stripping the server's known suffixes (request locale + English), re-suffix **both** halves for
the request locale, save both inside the one transaction -- joining the existing
`currencyCode`/`institutionId` propagation. Non-pair accounts unchanged; no `UpdateAccountDto`
change.

**Accept:** specs: renaming the brokerage renames the cash half to the matching base + localized
suffix, and vice versa (**regression -- fails when only the addressed row is renamed**); a name
stored under a different locale's suffix still re-bases correctly; the existing
currency/institution propagation specs stay green.

### L1 -- Account list: one row per pair (render only)

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/accounts/AccountList.tsx`,
`frontend/src/components/accounts/AccountRow.tsx`, their tests
(`frontend/src/components/accounts/AccountList.test.tsx`,
`frontend/src/components/accounts/AccountRow.test.tsx`), `frontend/src/app/accounts/page.tsx`
(pass unpriced counts alongside `brokerageMarketValues`),
`frontend/src/i18n/messages/en/accounts.json` (caption + unknown-value tooltip strings).

**Do:** replace the pair-adjacent ordering block inside the INVESTMENT group with
`useLogicalAccounts`; add the optional `logical` prop to `AccountRow`; combined value with the
"Investments X / Cash Y" caption; em-dash + tooltip when `combinedValue` is null; drop the
chain-link/`pairedWith` presentation for folded rows; search matches member names; balance sort
keys on `combinedValue ?? 0`. Row click and all actions stay as they are (L2's job).

**Accept:** component tests: a pair renders exactly one row labeled with the stripped name; the
orphan-cash account renders its own row; **regression: null combined renders the em-dash, not
the cash balance**; group header count and page summary values are unchanged against the same
fixture (they already fold / already iterate raw accounts).

### L2 -- Pair-aware actions

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/accounts/AccountRow.tsx` (`buildAccountActions`),
`frontend/src/components/accounts/AccountList.tsx` (action handlers + delete/close dialogs),
their tests, `frontend/src/i18n/messages/en/accounts.json` (pair-delete confirm copy).

**Do:** Reconcile un-hidden for logical investment rows with a `cashRegisterId`, routing to
`/reconcile?accountId={cashRegisterId}`; Close/Reopen call the API once with the primary id (B1
cascades), Close disabled unless `combinedValue === 0` exactly (null disables, with the
unknown-value title); Delete shows one confirm naming both ledgers, then deletes brokerage
first, cash second, and calls `invalidateBalanceCaches()`.

**Accept:** tests: reconcile pushes the **cash** id (**regression -- fails if it targets the
brokerage**); close is disabled at nonzero and at unknown combined value; delete issues two
calls brokerage-first; an orphan brokerage row hides reconcile.

### D1 -- InvestmentViewToggle extraction

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/investments/InvestmentViewToggle.tsx` (new, + test),
`frontend/src/app/investments/page.tsx` (replace both inline copies).

**Do:** extract the segmented brokerage/cash toggle verbatim (props: `value`, `onChange`;
labels from the `investments` namespace); the page's behavior -- including localStorage
persistence -- is unchanged.

**Accept:** existing page tests green; the toggle's own test covers both states; the page
renders the same classes as before the extraction.

### D2 -- InvestmentRegisterPanel in the detail view

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/investments/InvestmentRegisterPanel.tsx` (new, + test),
`frontend/src/components/accounts/investment-detail/InvestmentDetailView.tsx` (+ its test),
`frontend/src/i18n/messages/en/accountDetail-investment.json` (tab/empty-state strings as
needed).

**Do:** the panel takes the resolved ids (`brokerageIds`, `cashIds`) and owns: the D1 toggle
(persisted under its own localStorage key), the brokerage tab (`InvestmentTransactionList.tsx`
with create/edit/delete via `InvestmentTransactionForm.tsx`), the cash tab
(`frontend/src/components/transactions/TransactionList.tsx` scoped to the cash ids, with
new-cash via the transaction form), and pagination. `InvestmentDetailView.tsx` mounts it in
place of the recent-transactions list -- pair passes both ids, standalone/orphan-brokerage pass
self as the cash id. Every write path calls `invalidateBalanceCaches()`.

**Accept:** tests (act-wrapped render helper per `frontend/CLAUDE.md`): the cash tab requests
exactly the cash id (**regression -- fails if brokerage rows leak into the cash register**);
standalone scopes both tabs to itself; a create in either tab invalidates the balance caches
(extend the `balance-cache.guard.test.ts` scan if it enumerates files).

### D3 -- Canonical URL + shell fold

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/app/accounts/[id]/page.tsx`,
`frontend/src/components/accounts/shared/AccountDetailShell.tsx`,
`frontend/src/components/accounts/shared/AccountSwitcher.tsx`, their tests.

**Do:** when the loaded account is a linked cash half, `router.replace` to
`/accounts/{linkedAccountId}`. The shell strips the title suffix for investment accounts; the
switcher receives the logical list (one entry per pair, primary ids, stripped names).

**Accept:** tests: a cash-id deep link replaces to the brokerage URL (**regression -- fails on
rendering under the cash URL**); the switcher lists one entry per pair; non-investment accounts
are untouched.

### E1 -- AccountForm pair mode

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/accounts/AccountForm.tsx` (+
`frontend/src/components/accounts/AccountForm.test.tsx`),
`frontend/src/i18n/messages/en/accounts.json` (section heading + labels).

**Do:** on edit of an account resolving to a pair (via `accountsApi.getInvestmentPair`): one
base-name field pre-filled with the stripped base (submits to the brokerage id; B2 propagates);
shared fields once; a collapsed "Cash account" section with the cash half's opening balance
(`CurrencyInput`), account number and description, saved by a second `update()` to the cash id
only when dirty. Busy flag is a counter (nested-saves rule). Standalone/orphans keep today's
form; the create-time `createInvestmentPair` checkbox is untouched.

**Accept:** tests: saving pair mode issues `update(brokerageId, { name })` and, when the cash
section is dirty, `update(cashId, { openingBalance, ... })`; an untouched cash section issues no
second call; **regression: the cash half's opening balance is reachable from the single row's
Edit action at all** (the community branch's gap).

### P1 -- Picker + register labels

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/transactions/TransferTransactionFields.tsx`,
`frontend/src/components/transactions/NormalTransactionFields.tsx`,
`frontend/src/components/transactions/SplitTransactionFields.tsx`,
`frontend/src/components/transactions/SplitEditor.tsx`,
`frontend/src/components/scheduled-transactions/ScheduledTransactionForm.tsx`,
`frontend/src/hooks/useTransactionFilters.ts`,
`frontend/src/components/transactions/TransactionRow.tsx` (transfer other-side labels),
`frontend/src/test/ui-conventions.test.ts` (guard scan), tests beside each touched surface.

**Do:** every listed surface labels account options through `useAccountOptionLabel` (option
**values unchanged** -- the cash id keeps flowing). Add the guard scan: a file under the
transaction/scheduled-transaction component trees that passes a label built from raw
`account.name` into `buildAccountDropdownOptions` fails with a message naming the hook.

**Accept:** per-picker tests: a linked cash half renders the stripped label with the cash id as
value (**regression -- fails on the " - Cash" label**); the guard scan fails when a picker
bypasses the hook (verify by breaking one temporarily); `useTransactionFilters` still excludes
the brokerage half.

### R1 -- Report picker unification

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/reports/ReportAccountMultiSelect.tsx` (+ its test), callers:
`frontend/src/components/reports/SectorWeightingsReport.tsx`,
`frontend/src/components/reports/GeographicAllocationReport.tsx`,
`frontend/src/components/reports/SecurityTypeAllocationReport.tsx`,
`frontend/src/components/reports/CurrencyExposureReport.tsx`,
`frontend/src/components/reports/DividendIncomeReport.tsx`,
`frontend/src/components/dashboard/PortfolioValueWidget.tsx`, and the transaction-based report
callers of the default filter.

**Do:** replace the free-form `filter`/`excludeCashAccounts` conventions with
`mode: 'transactions' | 'portfolio'`: both modes build the identical logical option list from
`buildLogicalAccounts`; transactions mode emits `cashRegisterId`, portfolio mode emits the
primary id; orphans appear only in their applicable mode. Migrate every caller and delete the
old plumbing.

**Accept:** tests: the same account set renders identical option labels in both modes; for the
same pair, transactions mode emits the cash id and portfolio mode the brokerage id
(**regression -- fails on the old two-convention filters**); orphan brokerage appears only in
portfolio mode, orphan cash only in transactions mode.

### R2 -- AccountBalancesReport logical rows

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/reports/AccountBalancesReport.tsx` (+ its test),
`frontend/src/i18n/messages/en/reports.json` (caption strings if the accounts namespace is not
imported there).

**Do:** fold to one row per logical account; combined value with the "Investments X / Cash Y"
caption; em-dash on null; totals derived from the folded rows.

**Accept:** tests: a pair renders one row; totals for fully priced fixtures are unchanged
against the pre-fold output; **regression: null combined renders the em-dash, not the cash
subtotal**.

### R3 -- Dashboard

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `frontend/src/components/dashboard/FavouriteAccounts.tsx` (+ its test),
`frontend/src/app/dashboard/page.tsx` (investment count).

**Do:** one card per logical account when either half is favourited (dedupe when both);
combined value + caption + em-dash rule; the dashboard investment count uses
`countLogicalAccounts` over active investment accounts.

**Accept:** tests: both halves favourited -> one card (**regression -- fails on two cards**);
one pair + one standalone counts as 2 investment accounts (**regression -- fails on 3**).

### V1 -- Playwright e2e journey

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `e2e/tests/investment-account-consolidation.spec.ts` (new; model on
`e2e/tests/joint-accounts.spec.ts`).

**Do:** seed a pair, a standalone and an orphan; walk: the list shows one row with the combined
value -> row click lands on `/accounts/{brokerageId}` (it landed on a filtered `/investments`
when this task was written) -> Details shows the merged view with a
working cash tab -> Edit changes the base name and the cash opening balance -> the transfer
picker offers the stripped name and the money lands in the cash ledger -> Close from the single
row closes both halves -> Reopen restores both.

**Accept:** suite green in CI's e2e lane (one worker; the `zz-` ordering rule applies locally).

### Q1 -- Full-locale i18n pass (final acceptance commit)

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** every locale of each namespace touched by earlier tasks
(`frontend/src/i18n/messages/{locale}/accounts.json`, `accountDetail-investment.json`,
`investments.json`, `reports.json`, `dashboard.json` as applicable) and
`backend/src/i18n/locales/{locale}/errors.json` for B1's key; regenerate pseudo-locales.

**Do:** one localization pass filling every supported locale for all strings added on this
branch; `npm run i18n:pseudo` + `npm run i18n:check` in both apps. Grep for each key before
adding -- a duplicate key in a catalog is invisible and ships the wrong copy (see the duplicate-
keys rule in the root `CLAUDE.md`).

**Accept:** `messages.parity.test.ts` (frontend) and `locales.parity.spec.ts` (backend) green;
pseudo-locales up to date.

### S2 -- Docs as-built pass

- [x] Status: done (`claude/investment-account-consolidation-8x3lvz`)

**Files:** `docs/future-plans/investment-account-consolidation.md` (truth tables to as-built),
this file (statuses), `docs/financial-calculation-contract.md` (record `unpricedHoldingsCount`
as the null-propagation carrier for per-account market values).

**Do:** update both docs to as-built, record any scope-cut deltas, and restate the two named
follow-ups: contract-complete group totals/summary cards, and migrating `/investments` onto
`InvestmentRegisterPanel.tsx`.

**Accept:** `backend/src/common/doc-paths.spec.ts` green; no stale identifier claims.

---

Every task here is an agent task; there are no operator-only steps in this plan (no migrations,
no deploy toggles). If a session discovers work that does not fit its task, add a row to the
graph rather than widening the session.
