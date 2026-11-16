# Column sorting on the Transactions register

Specification of click-to-sort column headers on the Transactions page
register (issue #521): any data column sorts, the date column sorts in either
direction, and the running Balance column is shown only while the register
is in date order. The code shipped in commits a3fcf73ce (`feat(transactions):
let the register be sorted by any of its columns`) and d594603d1
(`feat(transactions): make the register's column headers sort it`); the task
list's boxes were never ticked, but the work is on `main`. The plan is
retired and this document is kept as the specification the code is held to.

This document is the specification `docs/financial-calculation-contract.md`
section 9 asks for: it changes how a money figure (the running balance) is
seeded and walked, so it carries the invariants, truth tables, numerical
examples, missing-data policy and test matrix, and it is committed before any
implementation. The approach was agreed on the issue: the reporter asked for
sorting by any column with the date order toggleable; a second user proposed
the KMyMoney rule (no running balance under a non-date order); the maintainer
accepted it.

## 1. Goal

- **Every data column header on the Transactions register is a sort control**:
  Date, Account (when the column is drawn), Payee, Category, Description,
  Ref #, Amount, Status. Tags, Attachments, Balance, the foreign-currency
  trio and Actions are not sortable.
- **Clicking a header sorts by it; clicking it again reverses.** Date starts
  newest first (today's default); every other column starts ascending. The
  choice is remembered in the browser like the row density is.
- **The running balance is correct in both date directions, on every page.**
  A row shows the same balance whether the register runs newest-first or
  oldest-first; under the oldest-first order the first row's balance is the
  opening balance plus that row.
- **Under any other order the Balance column is not drawn**, and the register
  says why in one line ("Sort by date to see the running balance"), because a
  balance beside a row sorted by payee is not a figure anyone can read.
- **Nothing else changes.** The default state (date, newest first) is
  byte-identical on the page and on the wire; the six other surfaces that
  mount `TransactionList` keep their plain headers.

## 2. What exists, and what this composes

The feature adds no write path and no new financial arithmetic. It exposes a
sort the backend already applies, makes the running-balance seed
direction-aware, and reuses the sortable-header kit every report table uses.

| Need | Existing piece | Notes |
|---|---|---|
| Sorted, paged register rows | `TransactionsService.findAll` (`backend/src/transactions/transactions.service.ts`) already takes `sortBy` and `sortDirection` | Before this work, reached only by the AI assistant and MCP tools, always on page 1: the HTTP controller passed `undefined, undefined`. |
| One register order | `applyRegisterOrder` (`backend/src/transactions/register-order.ts`): primary column, `createdAt`, `amount` (credits before debits, opposite to the list), `id` | The ASC order is the exact reverse of the DESC order, a total order, so "the rows newer than a page" is well defined either way. |
| The running-balance seed | `startingBalance` on the list response: the balance after the newest row on the page, computed by `calculateUnfilteredBalance`, `calculateDateFilteredBalance`, `calculateContentFilteredBalance` / `calculateMultiAccountContentFilteredBalance` (through `computeNewerRowsSum`) | Each sums "the rows on previous pages" with `applyRegisterOrder(q, "t", "DESC")` **hardcoded** and `.limit(skip)`, and each has a `safePage === 1` shortcut. Both are descending-only truths; this is why a non-default sort corrupts every page-2+ balance today. |
| Which rows move a balance | `onlyBalanceAffecting` (`backend/src/transactions/balance-affecting.util.ts`): not VOID, not a split child | Unchanged. INV-TRANSFER-001. |
| The balance the newest row leaves | `AccountsService.getProjectedBalance` (`backend/src/accounts/accounts.service.ts`): opening balance plus every ledger-movement row, future-dated included | Unchanged. INV-BALANCE-001. |
| The client walk | `TransactionList.tsx`'s `runningBalances` memo: newest-first, `balance = seed - cumulative`, VOID and split children contribute 0, filtered split parents use `displayAmounts` | Moves to `lib/running-balance.ts` and gains a direction. |
| Sortable header kit | `useSortableTable` (`frontend/src/hooks/useSortableTable.ts`), `SortableHeader` (`frontend/src/components/ui/SortableHeader.tsx`), `SortColumn` / `SortColumnsByField` / `PHONE_HEADER_CLASS` (`frontend/src/components/ui/Table.tsx`) | The two-header-rows-from-one-record pattern is `frontend/src/components/reports/UncategorizedTransactionsReport.tsx`; the nearest register analogue is `frontend/src/components/reconcile/ReconcileTable.tsx`. |
| Deep link to one row | `targetTransactionId` -> `calculateTargetPage`, a hand-written newest-first comparison on (date, `createdAt`, `id`) | Gains the direction; refuses a non-date sort. |
| Query-parameter parsing | `parseTransactionStatuses`, `parseIds`, `assertStringParam` in `backend/src/transactions/transactions.controller.ts` | A sort parser joins them. |

## 3. Product decisions

1. **The sort is page state, remembered in the browser.** It lives on the
   Transactions page in `useSortableTable` under one key
   (`transactions.register.sort`), the way every report table remembers its
   sort. It is not a `user_preferences` column, not a URL parameter and not a
   filter: a laptop and a desktop need not agree, and a bookmarked filter URL
   should not carry a sort. `useSortableTable` persists through
   `useLocalStorage`, not a zustand store, so
   `frontend/src/store/persisted-storage.guard.test.ts` has nothing new to
   classify; the key is written only after a click on an authenticated page,
   so the pre-login footprint the guard pins is unchanged.
2. **The sort is part of the request key** (`docs/frontend/api-and-cache.md`).
   Changing it returns the register to page 1 through the same
   `isFilterChange` path a filter change takes, and the payload is adopted with
   the sort that produced it. It does **not** reach the calendar view's
   `getAllPages`, the CSV export or the chart requests: those are unsorted
   reads of the same filters.
3. **One field list, two layers.** `TRANSACTION_SORT_FIELDS` is declared once
   in `register-order.ts`, mirrored verbatim in
   `frontend/src/lib/transaction-sort.ts`, and a backend contract spec fails
   when the two differ (the pattern
   `backend/src/common/calendar-day-note.contract.spec.ts` uses for the note
   length). The AI assistant's and the MCP tool's `sortBy` enums derive from
   the same constant, so the model can ask for what the page can show.
4. **Date sorts newest-first on its first click; everything else ascending.**
   A register is read newest-first; a payee, category or status list is read
   A to Z. The same column toggles. `nextTransactionSort(prev, field)` is the
   one function that decides this, table-tested.
5. **Under a non-date order the balance is withheld, not zeroed, and the
   response says why.** `findAll` skips every balance query when
   `sortBy !== "date"` and sets `startingBalanceWithheld: "sort"` exactly when
   it *would* have computed a seed (a single account with rows, or content
   filters with rows). The client draws the Balance column only under a date
   sort, and draws the hint only when the flag says a balance was withheld,
   so an all-accounts unfiltered register, which never had a balance, is not
   promised one.
6. **In both date directions the seed means the same thing: the balance after
   the newest row on the page, and the client walks newest-first.** What
   changes is only *which rows are newer than the page*: under DESC they are
   the previous pages (`LIMIT skip` in DESC order, as today); under ASC they
   are the following pages (`OFFSET skip + limit` in ASC order). One helper,
   `restrictToRowsNewerThanPage`, is the only place that window is written.
   The client reverses its walk under ASC; the result is a map by id, so the
   rows render in the order they arrived and the filtered-split
   `displayAmounts` are read per row exactly as now. This keeps the existing
   DESC arithmetic byte-identical and makes the ASC case a mirror the
   integration suite can prove row by row (I1).
7. **The newest page is not always page 1.** The four `safePage === 1`
   shortcuts become `isNewestPage(window)`: `skip === 0` under DESC,
   `skip + limit >= total` under ASC. `findAll` already has `total` from
   `getManyAndCount` before it computes the seed.
8. **A non-date primary still reads chronologically within a group.**
   `applyRegisterOrder` inserts `transactionDate` (list direction) as the
   second leg whenever the primary is not the date, so one payee's rows come
   out in date order rather than insertion order. The date-sorted register and
   the three balance windows are untouched by this leg.
9. **Text columns sort in the database collation with `NULLS LAST` in both
   directions.** No `LOWER()`: `categories.service.ts` and
   `payees.service.ts` already order by the raw name, and a computed order key
   cannot be used on TypeORM's paginated-join path (section 6.3). A blank
   payee, category, description or reference sinks to the end whichever way
   the list runs, matching `compareValues` in `useSortableTable`.
10. **Status sorts by the stored value** (CLEARED, RECONCILED, UNRECONCILED,
    VOID alphabetically). A status sort is for grouping, and the raw column
    groups deterministically. A lifecycle rank (`ReconcileTable`'s
    `STATUS_RANK`) would need an `addSelect` alias on the paginated-join path
    and is recorded as a follow-up, not built here.
11. **A deep link is resolved under the date order only.** The page already
    drops every filter when a `targetTransactionId` arrives so the target is
    not hidden; a persisted non-date sort is reset the same way (to
    `{ field: 'date', direction }`, keeping the direction). The service
    refuses `targetTransactionId` with a non-date `sortBy` (400), so the AI
    and MCP entry points are covered by the same rule. Computing the page
    under an arbitrary sort would need a raw-SQL rendering of the register
    order with its own agreement guard; it is the right fix for the reported
    defect R1 and out of scope here.
12. **The Date header keeps the year toggle, and the toggle does not sort.**
    `SortableHeader` gains a `controls` slot rendered in a span that stops
    click and keydown propagation. No interactive element sits inside a
    button; the header stays one `<th role="columnheader">` with `aria-sort`.
13. **The phone layout keeps its slim header and gains the chip strip.** On a
    phone at Normal density the column header is replaced by a control row
    (select-all, the date toggle); when the list is sortable a second row of
    `PHONE_HEADER_CLASS` chips follows it, rendered from the same exhaustive
    record as the desktop headers, so a persisted field always has a control
    (`docs/frontend/tables-and-registers.md`, "A header that holds controls
    is replaced, never hidden").
14. **The `account` field on a single-account view resolves to the default
    sort** for both the request and the headers (`resolveRegisterSort`),
    without rewriting storage: the column is not in the DOM there, and
    widening the filter back brings the account sort back.
15. **The "today" divider follows the order.** A row is future by its own
    date, not by its index; the divider sits before the first non-future row
    under DESC, before the first future row under ASC, and is not drawn under
    a non-date order. Its source of "today" is unchanged (see R4).

## 4. Definitions

- **Sort field**: one of `TRANSACTION_SORT_FIELDS`:
  `date | account | payee | category | description | refNumber | amount | status`.
- **Direction**: `ASC | DESC` on the wire and in the service
  (`RegisterSortDirection`); `'asc' | 'desc'` in the browser
  (`SortDirection` from `useSortableTable`). The client sends lower case; the
  parser accepts either case.
- **Register order for field `f`, direction `d`**: `primary(f) d`, then
  `transactionDate d` (only when `f !== date`), then `createdAt d`, then
  `amount` in `creditsBeforeDebitsDirection(d)`, then `id d`. Written once,
  in `applyRegisterOrder`.
- **Page window**: `{ skip, limit, total, direction }` for the page being
  listed. `skip = (page - 1) * limit`.
- **Rows newer than the page**: under DESC, the first `skip` rows of the
  DESC order; under ASC, every row from position `skip + limit` of the ASC
  order. In both cases these are exactly the rows the register lists on
  pages nearer the newest end.
- **Seed** (`startingBalance`): the balance after the newest row on the page.
  Per regime: unfiltered, the projected balance minus the sum of the rows
  newer than the page; date-filtered with `endDate`, the balance at `endDate`
  minus that sum; content-filtered, the matched total minus that sum
  (zero-based). Sums go through `onlyBalanceAffecting` and, where a category
  or tag filter narrows split lines, `computeSplitAwareSum`.
- **Walk**: rows in newest-first order; `balance(row) = seed - cumulative`,
  then `cumulative += amount` when the row affects the balance. Under ASC the
  page is reversed before walking.
- **Newest page**: the page holding the newest row of the whole listing.
  `skip === 0` under DESC; `skip + limit >= total` under ASC.

## 5. Invariants

| # | Invariant | Mechanism |
|---|---|---|
| I1 | **A row's running balance is the same figure whichever way the date register runs**, and the oldest row's balance minus its amount is the opening balance (unfiltered) or zero (content-filtered). | `restrictToRowsNewerThanPage` is the one window; `walkRunningBalances` is the one walk; `register-sort.integration.spec.ts` asserts `balance(ASC)[id] === balance(DESC)[id]` for every row across page boundaries with a VOID row, a split parent, a same-`created_at` pair and a future row. INV-REGISTER-001 (new). |
| I2 | **No balance is shown under a non-date order**, and the register says why. | `findAll` skips the seed and sets `startingBalanceWithheld: "sort"`; `showRunningBalance` carries the date-sort term and `ui-conventions.test.ts` pins the expression; the hint renders iff the flag is `'sort'`. |
| I3 | **The register order and its page window are written once.** | `register-order.spec.ts` asserts exactly one `applyRegisterOrder(` and three `restrictToRowsNewerThanPage(` in the service, no `addOrderBy(...createdAt` and no `.limit(` / `.offset(` beside a `select("t.id")` there. |
| I4 | **One field list in both layers**, and the AI/MCP enums derive from it. | `register-sort.contract.spec.ts` reads `frontend/src/lib/transaction-sort.ts` and compares; the zod schemas use `z.enum(TRANSACTION_SORT_FIELDS)`. |
| I5 | **A persisted sort field always has a control.** | Both header rows render `Object.values(columns)` from one `SortColumnsByField` record (a field missing from it is a compile error); `resolveRegisterSort` handles `account` on a single-account view. |
| I6 | **The sort is part of the request key and resets the page.** | `loadTransactions` lists the effective sort in its dependencies and sends it; `handleSort` sets `isFilterChange`; `page.test.tsx` asserts page 1 after a header click while on page 3. |
| I7 | **The sort never leaks into the calendar, the export or the charts.** | `transactionsApi.getAll` sends `sortBy` / `sortDirection` only when given; `page.test.tsx` asserts `getAllPages` is never called with `sortBy`. |
| I8 | **A deep link resolves under the date order only.** | Service refusal (`errors.transactions.targetRequiresDateSort`) before any query; the page resets a non-date sort where it sets `targetTransactionIdRef`. |
| I9 | **A request without sort parameters is byte-identical to today's**, on the wire and in SQL. | Defaults `date` / `DESC`; the DESC branch of the window is `applyRegisterOrder(..., "DESC").limit(skip)` as today; the "unfiltered starting balance (preserved behavior)" and sibling describe blocks in `transactions.service.spec.ts` pass untouched. |

## 6. Data contracts

### 6.1 `GET /transactions` (changed, additive)

Two optional query parameters:

- `sortBy`: one of `TRANSACTION_SORT_FIELDS`; default `date`.
- `sortDirection`: `asc` or `desc`, case-insensitive; default `desc`.

Parsed by `parseTransactionSort(sortBy, sortDirection)` in
`backend/src/transactions/register-sort-param.ts`: `assertStringParam` first
(a repeated key arrives as an array), then the allowlist. An unknown value is
400 with `errors.transactions.invalidSortBy` / `invalidSortDirection`, naming
the accepted values. Both are documented with `@ApiQuery`.

`targetTransactionId` together with a `sortBy` other than `date` is 400 with
`errors.transactions.targetRequiresDateSort`, raised in the service so every
caller meets it.

Response (`PaginatedTransactions`) gains one optional field:

```typescript
interface PaginatedTransactions extends PaginatedResult<TransactionWithInvestmentLink> {
  startingBalance?: number;            // unchanged: the balance after the newest row on the page
  startingBalanceWithheld?: "sort";    // present iff a seed would have been computed but sortBy !== "date"
}
```

### 6.2 `register-order.ts` (changed)

```typescript
export const TRANSACTION_SORT_FIELDS = [
  "date", "account", "payee", "category", "description", "refNumber", "amount", "status",
] as const;
export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];
export function isTransactionSortField(value: unknown): value is TransactionSortField;

export interface RegisterSortAliases { account?: string; category?: string }
/** The primary ORDER BY term for a field. Throws for a joined field whose alias was not supplied. */
export function registerPrimaryOrder(
  field: TransactionSortField, transactionAlias: string, aliases?: RegisterSortAliases,
): { expression: string; nulls?: "NULLS LAST" };

export function applyRegisterOrder<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>, alias: string, direction: RegisterSortDirection,
  field: TransactionSortField = "date", aliases?: RegisterSortAliases,
): SelectQueryBuilder<T>;

export interface RegisterPageWindow { skip: number; limit: number; total: number; direction: RegisterSortDirection }
export function isNewestPage(window: RegisterPageWindow): boolean;
/** DESC: the first `skip` rows; ASC: every row from `skip + limit`. Date order only. */
export function restrictToRowsNewerThanPage<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>, alias: string, window: RegisterPageWindow,
): SelectQueryBuilder<T>;
```

Primary terms: date -> `t.transactionDate`; account -> `account.name` NULLS
LAST; payee -> `t.payeeName` NULLS LAST; category -> `category.name` NULLS
LAST; description -> `t.description` NULLS LAST; refNumber ->
`t.referenceNumber` NULLS LAST; amount -> `t.amount`; status -> `t.status`.
The balance windows call `applyRegisterOrder(q, "t", direction)` with the
default field and no aliases, so they can never be asked for a joined order.
`restrictToRowsNewerThanPage`'s ASC branch passes `skip + limit`, which is at
least 1, so TypeORM never drops a falsy offset.

### 6.3 What TypeORM's paginated-join path allows

`findAll` pages with `.skip().take().getManyAndCount()` over
`leftJoinAndSelect` joins, so TypeORM 0.3 runs its two-query path: a
`SELECT DISTINCT` of the transaction ids plus the order columns, ordered and
limited, then the rows for those ids. Three consequences the implementation
respects and the integration suite proves:

- An order key must be `alias.property` of a **selected** alias. `account`,
  `payee` and `category` are `leftJoinAndSelect` in `findAll`, so
  `account.name` and `category.name` resolve. A raw expression (`CASE`,
  `LOWER`) cannot be an order key there (decisions 9 and 10).
- An order key on a one-to-many alias (`tags`, `splits`) would make the
  DISTINCT emit duplicate ids and a page repeat rows. `TRANSACTION_SORT_FIELDS`
  never names one; the register-order spec's "throws without an alias" case
  and the field list itself hold this.
- `NULLS LAST` is carried through both queries.

### 6.4 Frontend contracts

`frontend/src/lib/transaction-sort.ts` (pure):

```typescript
export const TRANSACTION_SORT_FIELDS = [/* the mirror */] as const;
export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];
export type TransactionSort = SortState<TransactionSortField>;
export const TRANSACTION_SORT_STORAGE_KEY = 'transactions.register.sort';
export const DEFAULT_TRANSACTION_SORT: TransactionSort = { field: 'date', direction: 'desc' };
export function nextTransactionSort(prev: TransactionSort, field: TransactionSortField): TransactionSort;
export function resolveRegisterSort(sort: TransactionSort, isSingleAccountView: boolean): TransactionSort;
export function isSortedByDate(sort: TransactionSort | undefined): boolean;   // undefined is the unsorted register: true
```

`frontend/src/lib/running-balance.ts` (pure):

```typescript
export function rowAffectsBalance(row: Pick<Transaction, 'status' | 'parentTransactionId'>): boolean;
export function walkRunningBalances(
  rows: readonly Transaction[], startingBalance: number | undefined,
  direction: SortDirection, displayAmounts: ReadonlyMap<string, number>,
): Map<string, number>;   // empty when the seed is absent or NaN; ASC walks [...rows].reverse()
```

`TransactionList` props gain `sort?: TransactionSort`,
`onSortChange?: (field: TransactionSortField) => void` and
`startingBalanceWithheld?: 'sort'`. `TransactionsGetAllParams` gains
`sortBy?: TransactionSortField` and `sortDirection?: 'asc' | 'desc'`, sent
only when set. The frontend `PaginatedTransactions` type gains
`startingBalanceWithheld?: 'sort'`.

## 7. Truth tables

### A. Balance column and hint, by sort field and regime

| Sort field | Regime | `startingBalance` | `startingBalanceWithheld` | Balance column | Hint |
|---|---|---|---|---|---|
| date (either direction) | single account, rows | seed | absent | drawn | none |
| date | several accounts, content filters, rows | zero-based seed | absent | drawn | none |
| date | all accounts, content filters, rows | zero-based seed | absent | drawn | none |
| date | several / all accounts, no content filters | absent | absent | not drawn | none |
| date | any regime, no rows | absent | absent | empty state | none |
| not date | single account, rows | absent | `"sort"` | not drawn | shown |
| not date | several / all accounts, content filters, rows | absent | `"sort"` | not drawn | shown |
| not date | several / all accounts, no content filters | absent | absent | not drawn | none |
| not date | no rows | absent | absent | empty state | none |

The client reads the flag as `=== 'sort'`; absent means nothing to say.

### B. Rows newer than the page, by direction

| Direction | `skip` | `limit` | `total` | Window | `isNewestPage` |
|---|---|---|---|---|---|
| DESC | 0 | 2 | 5 | none (no query) | yes |
| DESC | 2 | 2 | 5 | first 2 rows of DESC order (`LIMIT 2`) | no |
| DESC | 4 | 2 | 5 | first 4 rows of DESC order | no |
| ASC | 0 | 2 | 5 | rows from position 2 of ASC order (`OFFSET 2`, the three newest) | no |
| ASC | 2 | 2 | 5 | rows from position 4 (`OFFSET 4`, the newest) | no |
| ASC | 4 | 2 | 5 | none (no query) | yes (`4 + 2 >= 5`) |
| ASC | 0 | 50 | 5 | none | yes (one page is the newest page) |

### C. "Today" divider

| Order | Page composition (listed order) | Divider |
|---|---|---|
| date DESC | future, future, past, past | before the first past row |
| date DESC | past only | none |
| date DESC | future only | none |
| date ASC | past, past, future, future | before the first future row |
| date ASC | past only / future only | none |
| any other | any | none; rows are still dimmed individually by their own date |

### D. Header click

| Current sort | Clicked | Next sort |
|---|---|---|
| date desc | date | date asc |
| date asc | date | date desc |
| payee asc | date | date desc |
| date desc | payee | payee asc |
| payee asc | payee | payee desc |
| payee desc | category | category asc |
| account asc, single-account view | (rendered as date desc; the Account chip is absent) | unchanged in storage; effective sort date desc |

### E. Deep link and persisted sort

| Persisted sort | Arrives with `targetTransactionId` | Request sent | Sort shown |
|---|---|---|---|
| date desc | yes | `sortBy=date&sortDirection=desc&targetTransactionId=...` | date desc |
| date asc | yes | `sortBy=date&sortDirection=asc&targetTransactionId=...` | date asc; the page containing the target under ASC |
| payee asc | yes | `sortBy=date&sortDirection=asc&targetTransactionId=...` | date asc (storage updated to date asc) |
| any | AI or MCP caller passes `targetTransactionId` with a non-date `sortBy` | 400 `targetRequiresDateSort` | n/a |

## 8. Numerical examples

All money at 4dp internally, printed at 2dp. Every example is reproduced by
`register-order.spec.ts` or `transactions.service.spec.ts`, by
`running-balance.test.ts`, and end to end by
`register-sort.integration.spec.ts`.

1. **Four debits, page size 2, the newest VOID.** Opening 1000; A -10 on
   2026-01-01, B -10 on 01-02, C -10 on 01-03, D -10 on 01-04 (D is VOID).
   Projected balance = 1000 - 30 = 970.
   - DESC page 1 (newest page): seed 970; D 970 (VOID moves nothing), C 970.
   - DESC page 2: rows newer = {D, C}, balance-affecting sum -10; seed 980;
     B 980, A 990.
   - ASC page 1 (A, B): rows newer = `OFFSET 2` of ASC = {C, D}, sum -10;
     seed 980; the reversed walk (B, A) gives B 980, A 990.
   - ASC page 2 (C, D): newest page, seed 970; reversed walk (D, C) gives
     D 970, C 970.
   Every id agrees; A's balance minus A's amount is 1000.
2. **A same-`created_at` credit and debit, page size 1.** Opening 0;
   TRANSFER_IN +2400 and PURCHASE -2400 on one day, written by one import.
   The order puts the credit chronologically first in both directions
   (`creditsBeforeDebitsDirection`). DESC page 1 = PURCHASE, seed 0 -> 0;
   page 2 = TRANSFER_IN, rows newer = {PURCHASE}, seed 0 - (-2400) = 2400.
   ASC page 1 = TRANSFER_IN, rows newer = `OFFSET 1` = {PURCHASE}, seed 2400;
   page 2 = PURCHASE, newest page, seed 0. Never negative, either way.
3. **Payee-filtered, zero-based, page size 2.** Matched rows oldest to
   newest: P1 -50, P2 -30, P3 +100. Matched total = 20.
   - DESC page 1 (P3, P2): seed 20; P3 20, P2 -80. Page 2 (P1): rows newer
     sum +70; seed -50; P1 -50.
   - ASC page 1 (P1, P2): rows newer = {P3}, sum +100; seed 20 - 100 = -80;
     reversed walk (P2, P1): P2 -80, P1 -50. Page 2 (P3): newest page; seed
     20; P3 20.
4. **A filtered split parent.** A category filter matches one of a split
   parent's two lines (-40 of a -100 parent). Its `displayAmount` is -40 on
   the client and `computeSplitAwareSum` counts -40 in the window on the
   server, in both directions; the parity property holds because both sides
   read the same predicate.

## 9. Missing-data policy

- Under a non-date order the balance is **withheld**, never zeroed and never
  computed against a meaningless neighbour; the response carries
  `startingBalanceWithheld: "sort"` and the register prints the hint. A
  reader learns what is missing and how to get it back (sort by date).
- `startingBalanceWithheld` absent means nothing to say, not "a balance is
  coming": the all-accounts unfiltered register shows neither a column nor a
  hint, as today.
- A `startingBalance` that is absent or `NaN` still renders `-` in every
  balance cell, as today; the walk returns an empty map.
- A failed reload keeps the rows, the seed, the flag and the sort together
  (`docs/frontend/api-and-cache.md`); the sort a payload was fetched under is
  the sort it is walked under.
- `NULL` text values sort last in both directions; they are not rendered as
  empty strings anywhere new.

## 10. Frontend structure

- `lib/transaction-sort.ts` (pure): the mirror constant and the four helpers
  in section 6.4; `transaction-sort.test.ts` tables D and E's client rows.
- `lib/running-balance.ts` (pure): `walkRunningBalances`, `rowAffectsBalance`;
  `running-balance.test.ts` reproduces examples 1 to 4 in both directions.
- `components/ui/SortableHeader.tsx`: an optional `controls` slot whose span
  stops `click` and `keydown` propagation; its test proves activating the
  control leaves `aria-sort` unchanged.
- `components/transactions/TransactionList.tsx`:
  - a `columns: SortColumnsByField<TransactionSortField, RegisterSortColumn>`
    record holding `field`, `label` (`list.header.*`) and `align`, with
    `account` dropped from `Object.values` output on a single-account view;
  - each sortable `<th>` becomes `<SortableHeader ... className={...}>` when
    `sort` is supplied and stays the plain `<th>` otherwise, through one small
    render helper in the file. The `registerColumnClass('...')` and
    `REGISTER_PAYEE_CELL_FLOOR` literals stay inline on each header cell in
    today's order: `register-columns.guard.test.ts` compares their source
    order against `REGISTER_COLUMN_ORDER` without deduplication, so the record
    must not carry them;
  - `showRunningBalance = (isSingleAccountView || startingBalance !== undefined) && isSortedByDate(sort)`;
  - `runningBalances = walkRunningBalances(transactions, startingBalance, sort?.direction ?? 'desc', displayAmounts)`;
  - per-row `isFuture` by date; the divider per table C;
  - the hint (`list.sort.hint`) in `ListTopToolbar`'s `actions` slot when
    `startingBalanceWithheld === 'sort'`;
  - in the wrapped phone layout, a second `<tr>` of `PHONE_HEADER_CLASS`
    chips (`aria-label` `list.sort.stripLabel`) after the slim control row,
    only when `sort` is supplied.
- `app/transactions/page.tsx`: `useSortableTable` with the storage key and
  default; `handleSort` sets `isFilterChange` and `setSort(prev => nextTransactionSort(prev, field))`;
  `effectiveSort = resolveRegisterSort(sort, isSingleAccountView)` sent by
  `loadTransactions` and listed in its dependencies; `startingBalanceWithheld`
  adopted in the same block as `data`, `pagination` and `startingBalance`; the
  deep-link reset beside the two places that set `targetTransactionIdRef`.
- `lib/transactions.ts`: `TransactionsGetAllParams` and `getAll` send
  `sortBy` / `sortDirection` only when set.
- i18n: `transactions.list.sort.hint` ("Sort by date to see the running
  balance") and `transactions.list.sort.stripLabel` ("Sort by"); the backend's
  three `errors.transactions.*` keys. English first, pseudo-locale
  regenerated, every locale in the final task.
- `page.test.tsx` stubs `useLocalStorage` statelessly today; the sort tests
  override it with a `useState`-backed implementation in their own describe.

## 11. Test matrix

| Layer | Test | Proves |
|---|---|---|
| backend unit | `register-order.spec.ts` | the order per field and direction, the date second leg under a non-date primary, `NULLS LAST` on the text fields, a joined field without its alias throws, table B (window and `isNewestPage`), examples 1 and 2 through the recorded builder, I3's three counts and two bans |
| backend unit | `register-sort-param.spec.ts` | defaults; both cases of the direction; an array or unknown value is 400 naming the accepted values |
| backend unit | `transactions.service.spec.ts` | in each starting-balance describe block an ASC twin expecting `offset(skip + limit)` and no `limit(...)`; an ASC newest-page case that issues no window query; a non-date case with `startingBalance` absent, `startingBalanceWithheld: "sort"` and no balance query; target + non-date rejects; `calculateTargetPage` flips under ASC; every existing DESC case untouched (I9) |
| backend unit | `transactions.controller.spec.ts` | the parsed pair reaches `findAll` where `undefined, undefined` sat; `?sortBy=tags` is 400 |
| backend unit | `register-sort.contract.spec.ts` | the two field lists are equal (I4) |
| backend integration | `register-sort.integration.spec.ts` | I1 on examples 1 to 4 plus an `endDate` filter and a two-account category filter; for all 8 fields x 2 directions at page size 2: pages disjoint, union complete, `total` right, NULLs last, ties in date order; the withheld flag per table A; the same target on mirrored pages under DESC and ASC; target + payee refused |
| frontend unit | `running-balance.test.ts` | examples 1 to 4 both ways; VOID and split children contribute 0; absent seed gives an empty map |
| frontend unit | `transaction-sort.test.ts` | tables D and E (client rows); `resolveRegisterSort`; `isSortedByDate(undefined)` is true |
| frontend unit | `SortableHeader.test.tsx` | a control in the slot does not sort on click or Enter |
| frontend unit | `TransactionList.test.tsx` | with `sort`, a `columnheader` with `aria-sort` per field (one fewer on a single-account view); `sort.field === 'amount'` hides the Balance header even with `isSingleAccountView`; the hint iff the flag; without `sort` the header markup is unchanged; table C |
| frontend unit | `TransactionList.mobileWrapped.test.tsx` | with `sort` every field has a chip and the slim row keeps the toggle and select-all; without `sort` the existing one-cell assertion holds; a chip click calls `onSortChange` |
| frontend unit | `page.test.tsx` | I6 (page 1 after a click on page 3), table D through real clicks, I7 (`getAllPages` never sees `sortBy`), table E's client rows, `resolveRegisterSort` on a single account |
| frontend guard | `ui-conventions.test.ts` | the balance expression carries the date term; `startingBalance` beside every `isSingleAccountView` (unchanged) |
| frontend guard | `register-columns.guard.test.ts`, `interactive-row.guard.test.ts`, `density-preference.guard.test.ts`, `persisted-storage.guard.test.ts`, `balance-cache.guard.test.ts` | green with no baseline change |
| e2e | `e2e/tests/transactions.spec.ts`, `e2e/tests/mobile.spec.ts` | click Amount: rows in amount order, no Balance header, the hint; click Date: the Balance is back with per-row figures; click Date again: `aria-sort="ascending"` and the same figure beside the same row; reload keeps the sort; page 2 under ascending continues page 1; on a phone the chip strip is present and the year toggle still works |

A green suite after a behaviour change is a finding: each task's acceptance
names the test that turned red first.

## 12. Explicit v1 scope cuts

- Sorting on the six other `TransactionList` surfaces (category and payee
  detail tabs, the investments page's cash register, the foreign-currency
  fee sections and report). The props make it a small follow-up each.
- Sorting by tags or attachment count (one-to-many; would duplicate rows on
  the paginated-join path).
- A lifecycle order for Status (decision 10).
- A deep link resolved under a non-date order (decision 11, R1).
- Carrying the sort into the CSV export or the calendar.
- A server-side `user_preferences` sort, or a URL parameter.

## 13. Critical files

Backend: `backend/src/transactions/register-order.ts`,
`backend/src/transactions/register-order.spec.ts`,
`backend/src/transactions/transactions.service.ts` (`findAll`,
`calculateStartingBalance`, `calculateUnfilteredBalance`,
`calculateDateFilteredBalance`, `calculateContentFilteredBalance`,
`calculateMultiAccountContentFilteredBalance`, `computeNewerRowsSum`,
`calculateTargetPage`, `getLlmTransactionRows`),
`backend/src/transactions/transactions.service.spec.ts`,
`backend/src/transactions/transactions.controller.ts`,
`backend/src/transactions/transactions.controller.spec.ts`,
`backend/src/transactions/balance-affecting.util.ts`,
`backend/src/accounts/accounts.service.ts` (`getProjectedBalance`),
`backend/src/ai/query/tool-input-schemas.ts`,
`backend/src/ai/query/tool-definitions.ts`,
`backend/src/ai/query/tool-executor.service.ts`,
`backend/src/mcp/tools/transactions.tool.ts`,
`backend/src/i18n/locales/en/errors.json`,
`backend/test/integration/transactions.integration.spec.ts` (the fixture
pattern), `backend/src/common/calendar-day-note.contract.spec.ts` (the
mirror-spec pattern).

Frontend: `frontend/src/app/transactions/page.tsx`,
`frontend/src/app/transactions/page.test.tsx`,
`frontend/src/hooks/useTransactionFilters.ts`,
`frontend/src/hooks/useSortableTable.ts`,
`frontend/src/hooks/useLocalStorage.ts`,
`frontend/src/components/transactions/TransactionList.tsx`,
`frontend/src/components/transactions/TransactionList.test.tsx`,
`frontend/src/components/transactions/TransactionList.mobileWrapped.test.tsx`,
`frontend/src/components/transactions/TransactionRow.tsx`,
`frontend/src/components/transactions/register-columns.ts`,
`frontend/src/components/transactions/register-columns.guard.test.ts`,
`frontend/src/components/ui/SortableHeader.tsx`,
`frontend/src/components/ui/SortableHeader.test.tsx`,
`frontend/src/components/ui/Table.tsx`,
`frontend/src/components/ui/ListTopToolbar.tsx`,
`frontend/src/components/reports/UncategorizedTransactionsReport.tsx` (the
two-header-rows pattern), `frontend/src/components/reconcile/ReconcileTable.tsx`
and `frontend/src/components/reconcile/reconcile-rows.ts` (the register
analogue), `frontend/src/lib/transactions.ts`,
`frontend/src/types/transaction.ts`,
`frontend/src/test/ui-conventions.test.ts`,
`frontend/src/i18n/messages/en/transactions.json`,
`e2e/tests/transactions.spec.ts`, `e2e/tests/mobile.spec.ts`.

Docs to touch with the tasks: `docs/system-invariants.md` (new
INV-REGISTER-001 and its index row), `docs/verification-contract.md` (a
matrix row), `docs/backend/transactions-and-money.md` (the register order and
its page window), `docs/backend/entities-and-dtos.md` (the `applyRegisterOrder`
sentence gains the sort field), `docs/frontend/tables-and-registers.md` (the
Balance-column paragraph and the phone-strip sentence), `backend/CLAUDE.md`
(the register-order row names the window helper), `frontend/CLAUDE.md` (one
row: a register's running balance is `walkRunningBalances`).

## 14. Reported, not fixed

Pre-existing, found while designing; each is its own proposal.

- **R1 (fixed).** `calculateTargetPage` compared on three of the four
  ordering keys and rebuilt a subset of the filters, so a deep link could land
  on a page that does not hold the row it was following. It counts over
  `buildFilteredIdsSubquery` now -- the same row set the balance sums -- and
  compares on all four keys, with the amount leg running opposite to the list.
  It also read the target's `created_at` through the entity, which truncates
  microseconds to milliseconds, so the row came out newer than its own
  timestamp and counted itself; the keys are read out as text now. A deep link
  under a non-date sort is still refused rather than placed (decision 11):
  placing one needs `ROW_NUMBER()` over a raw rendering of the register order,
  which is a second spelling of the order this plan exists to keep single.
- **R2 (fixed).** `backend/src/accounts/account-export.service.ts` walked its
  exported running balance over a hand-written order without the amount leg,
  so an export could show the account overdrawn on a day a transfer had funded
  the purchase. It calls `applyRegisterOrder` now, and the guard widened from
  one file to a scan of the layer: a file carrying a `runningBalance` takes its
  order from there.
- **R3 (fixed).** Those four filters, and the brokerage exclusion, narrowed
  the listing without reaching the balance, which fell through to the
  unfiltered regime -- the account's whole projected balance, walked down past
  rows that are not on screen. `RegisterRowFilters` names the set once now and
  `buildFilteredIdsSubquery` applies all of it; an integration test asserts the
  seed equals the sum of the rows the listing returns, per filter.
- **R4 (fixed).** The register's "today" divider read the browser's clock; it
  reads `useFinancialToday()` now, so a traveller's laptop no longer decides
  which rows are still to come.
- **R5 (assessed, no change).** `getLlmTransactionRows` reads page 1 only and
  discards `startingBalance`. That is the design rather than a defect: the
  bound is what keeps a tool result inside its token budget, and a seed is
  meaningless without the walk that turns it into a column. The model gets the
  sort it asked for and no balance, which is the honest answer.

## 15. Follow-ups

None.
