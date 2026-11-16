"use client";

import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS, TABLE_BODY_CLASS, TABLE_CLASS } from "@/components/ui/Table";
import type {
  SortColumn as TableSortColumn,
  SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { useTranslations } from 'next-intl';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { PartialTotal } from "@/components/ui/PartialTotal";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import type { IncomeExpenseTagBucket } from "@/types/built-in-reports";
import type { TaggedBalanceWindow } from "@/lib/tagged-balance";

export type IncomeVsExpensesSortField =
  | 'name'
  | 'income'
  | 'expenses'
  | 'savings'
  | 'savingsRate'
  | 'taggedInflows'
  | 'taggedOutflows'
  | 'balance'
  | 'balancePercent';

/** Which optional columns the table carries (spec sections 10.5 and 10.9). */
export interface ColumnMode {
  /** A tagged-flow series is shown: the two flow columns exist. */
  showFlows: boolean;
  /** The Balance view: Balance and Balance % replace Savings and Savings Rate. */
  balanceView: boolean;
  /** Balance view only: the window has tagged outflows, so that column is worth a place. */
  showOutflows: boolean;
}

/** Whether a field is on the screen; a stored sort on one that is not falls back to the month. */
export function isFieldVisible(field: IncomeVsExpensesSortField, mode: ColumnMode): boolean {
  switch (field) {
    case 'savings':
    case 'savingsRate':
      return !mode.balanceView;
    case 'balance':
    case 'balancePercent':
      return mode.balanceView;
    case 'taggedInflows':
      return mode.showFlows;
    case 'taggedOutflows':
      return mode.showFlows && (!mode.balanceView || mode.showOutflows);
    default:
      return true;
  }
}

/** Column order per mode; the Balance view reads Income, Tagged inflows, Expenses, Tagged outflows, Balance, Balance %. */
const DEFAULT_ORDER: readonly IncomeVsExpensesSortField[] = [
  'name', 'income', 'expenses', 'savings', 'savingsRate', 'taggedInflows', 'taggedOutflows',
];
const BALANCE_ORDER: readonly IncomeVsExpensesSortField[] = [
  'name', 'income', 'taggedInflows', 'expenses', 'taggedOutflows', 'balance', 'balancePercent',
];

/**
 * One sortable column of the table view. The five are declared once and
 * rendered by BOTH header rows -- the column header row (from `sm` up) and the
 * phone sort strip -- so the two can never list different fields.
 */
type SortColumn = TableSortColumn<IncomeVsExpensesSortField, 'right'>;

const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// A money cell inside a wrapped card: no padding of its own below `sm` (the row
// supplies it and the grid does the spacing), the table cell's own padding from
// `sm` up. Smaller type on phones so a six-figure amount still fits a
// half-width column, and `whitespace-nowrap` so a locale that groups thousands
// with a space cannot break in the middle of a number.
//
// The tracks are sized so a compact six-figure amount fits at 320px and a
// seven-figure one at 390px (measured on a hand-CSS replica in Chromium).
// Right alignment is not a containment device: a nowrap amount longer than its
// track overflows past the END edge whatever `text-align` says, and in the
// right-hand track that does reopen the wrapper's sideways scroll (measured:
// a sixteen-character amount at 320px). That is the deliberate choice --
// `overflow-hidden` here would silently truncate a figure, and a scroll that
// appears only for an amount that large is honest.
const MONEY_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

export interface ChartDataItem {
  name: string;
  fullName: string;
  Income: number;
  Expenses: number;
  Savings: number;
  SavingsRate: number;
  /** Balance view only: `taggedBalance` of the period (spec section 10.9). */
  Balance?: number;
  BalancePercent?: number | null;
  /** Tagged transfer flows of the active bucket; absent when no flow series is shown. */
  TaggedInflows?: number;
  TaggedOutflows?: number;
  monthStart: string;
  monthEnd: string;
}

export interface IncomeVsExpensesTableProps {
  /** Rows already sorted by the caller. */
  rows: ChartDataItem[];
  sortField: IncomeVsExpensesSortField;
  sortDirection: 'asc' | 'desc';
  onSort: (field: IncomeVsExpensesSortField) => void;
  totals: { totalIncome: number; totalExpenses: number; totalSavings: number; savingsRate: number };
  completeness: { missingCurrencies: string[]; excludedCount: number };
  reportingCurrency: string;
  /** The active non-untagged tag bucket; its flows add two columns. */
  flowBucket?: IncomeExpenseTagBucket;
  /** The Balance view's window figure; present exactly when the Balance columns are. */
  balanceWindow?: TaggedBalanceWindow;
  onOpenMonth: (row: ChartDataItem) => void;
}

export function IncomeVsExpensesTable({
  rows: sortedTableData,
  sortField,
  sortDirection,
  onSort: handleSort,
  totals,
  completeness,
  reportingCurrency,
  flowBucket,
  balanceWindow,
  onOpenMonth: openMonth,
}: IncomeVsExpensesTableProps) {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercent, formatPercentTrimmed } =
    useNumberFormat();
  const showFlows = flowBucket !== undefined;
  const balanceView = showFlows && balanceWindow !== undefined;
  const mode: ColumnMode = {
    showFlows,
    balanceView,
    showOutflows: flowBucket !== undefined && balanceWindow !== undefined && flowBucket.taggedOutflows !== 0,
  };

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header. The list both
  // header rows render is DERIVED from the record, never re-listed beside it:
  // a hand-written list next to an exhaustive record is not exhaustive. The
  // record's declaration order is the column order.
  // The key is tied to the entry's own `field`, which a plain
  // `Record<IncomeVsExpensesSortField, SortColumn>` does not do: that forces an
  // entry to EXIST for every member of the union but lets it name a different
  // one, so `savingsRate: { field: 'savings', ... }` would type-check. Both
  // header rows would then render two controls keyed `savings` (a duplicate
  // React key), tapping "Savings Rate" would sort by Savings, and "Savings
  // Rate" would be unsortable -- none of which a test comparing header LABELS
  // can see, because the labels stay right. Here it is a compile error.
  const columns: TableSortColumnsByField<IncomeVsExpensesSortField, SortColumn> = {
    name: { field: 'name', label: t('incomeVsExpenses.colMonth') },
    income: { field: 'income', label: t('incomeVsExpenses.colIncome'), align: 'right' },
    expenses: { field: 'expenses', label: t('incomeVsExpenses.colExpenses'), align: 'right' },
    savings: { field: 'savings', label: t('incomeVsExpenses.colSavings'), align: 'right' },
    savingsRate: { field: 'savingsRate', label: t('incomeVsExpenses.colSavingsRate'), align: 'right' },
    taggedInflows: { field: 'taggedInflows', label: t('tagBreakdown.inflows'), align: 'right' },
    taggedOutflows: { field: 'taggedOutflows', label: t('tagBreakdown.outflows'), align: 'right' },
    balance: { field: 'balance', label: t('tagBreakdown.balance'), align: 'right' },
    balancePercent: { field: 'balancePercent', label: t('tagBreakdown.balancePercent'), align: 'right' },
  };
  const sortColumns: readonly SortColumn[] = (balanceView ? BALANCE_ORDER : DEFAULT_ORDER)
    .filter((field) => isFieldVisible(field, mode))
    .map((field) => columns[field]);

  return (
    <>
            {/* Below `sm` the table becomes a block and each row wraps into a
                three-column grid so all five columns fit a phone without a
                horizontal scroll, on two lines: the month, its savings and its
                income share line 1; the savings rate (spanning the first two
                tracks) and the expenses share line 2. Each derived figure
                sits under the figure it derives from -- rate under savings,
                expenses under income -- and the month is the one cell allowed
                to wrap, since a compact amount never may. From `sm` up it is
                the ordinary table. The sort controls survive as their own
                phone-only header row, because the column header row that
                carries them on desktop is hidden there.

                Two costs of restyling one tree, both deliberate. Changing the
                display roles drops the table semantics below `sm`, which is
                why every value carries a `CellLabel` naming its column -- a
                phone reader gets labelled values rather than a header
                association. And the phone reading order differs from the DOM
                order, which is the desktop column order the grid placement
                overrides visually. Both are properties of the mechanism, not
                of this table. */}
            <div className="overflow-x-auto">
              {/* Explicit roles: restyling `display` below `sm` strips the implicit
                  table semantics, and these put them back (inert from `sm` up). */}
              <table role="table" className={`block ${TABLE_CLASS} sm:table`}>
                <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                  {/* Phone sort strip: the same five controls, as a wrapped
                      row of compact chips. Column alignment means nothing here
                      -- the column header row is hidden and each data row is a
                      grid -- so every control is left-aligned and self-naming.
                      The border and card background are what say "tappable":
                      there is no hover on a touch screen, and without them the
                      strip reads as another row of the captions the cells below
                      carry. */}
                  <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                    {sortColumns.map((col) => (
                      <SortableHeader<IncomeVsExpensesSortField>
                        key={col.field}
                        field={col.field}
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        className={PHONE_HEADER_CLASS}
                      >
                        {col.label}
                      </SortableHeader>
                    ))}
                  </tr>
                  <tr role="row" className="hidden sm:table-row">
                    {sortColumns.map((col) => (
                      <SortableHeader<IncomeVsExpensesSortField>
                        key={col.field}
                        field={col.field}
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        align={col.align}
                        className={HEADER_CLASS}
                      >
                        {col.label}
                      </SortableHeader>
                    ))}
                  </tr>
                </thead>
                <tbody role="rowgroup" className={`block ${TABLE_BODY_CLASS} sm:table-row-group`}>
                  {sortedTableData.map((row) => (
                    <tr
                      key={row.name}
                      role="row"
                      tabIndex={0}
                      className={`grid grid-cols-3 items-start gap-x-3 gap-y-1.5 px-4 py-3 cursor-pointer ${HOVER_ROW_ON_CARD} ${INTERACTIVE_ROW_FOCUS_CLASS} sm:table-row sm:p-0`}
                      onClick={() => openMonth(row)}
                      onKeyDown={activateOnKey(() => openMonth(row))}
                    >
                      <td role="cell" className="col-start-1 row-start-1 p-0 text-sm font-medium text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                        {row.fullName}
                      </td>
                      {balanceView ? (
                        <>
                          <td role="cell" className={`col-start-3 row-start-1 text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colIncome')}</CellLabel>
                            {formatCurrency(row.Income)}
                          </td>
                          {row.TaggedInflows !== undefined && (
                            <td role="cell" className={`col-start-1 col-span-2 row-start-3 text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.inflows')}</CellLabel>
                              {formatCurrency(row.TaggedInflows)}
                            </td>
                          )}
                          <td role="cell" className={`col-start-3 row-start-2 text-red-600 dark:text-red-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colExpenses')}</CellLabel>
                            {formatCurrency(row.Expenses)}
                          </td>
                          {mode.showOutflows && row.TaggedOutflows !== undefined && (
                            <td role="cell" className={`col-start-3 row-start-3 text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.outflows')}</CellLabel>
                              {formatCurrency(row.TaggedOutflows)}
                            </td>
                          )}
                          <td role="cell"
                            className={`col-start-2 row-start-1 font-medium ${(row.Balance ?? 0) >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                          >
                            <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.balance')}</CellLabel>
                            {row.Balance === undefined ? '\u2014' : formatCurrency(row.Balance)}
                          </td>
                          <td role="cell"
                            className={`col-start-1 col-span-2 row-start-2 font-medium ${(row.BalancePercent ?? 0) >= 0 ? 'text-purple-600 dark:text-purple-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                          >
                            <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.balancePercent')}</CellLabel>
                            {row.BalancePercent == null ? '\u2014' : formatPercentTrimmed(row.BalancePercent)}
                          </td>
                        </>
                      ) : (
                        <>
                        <td role="cell" className={`col-start-3 row-start-1 text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colIncome')}</CellLabel>
                          {formatCurrency(row.Income)}
                        </td>
                        <td role="cell" className={`col-start-3 row-start-2 text-red-600 dark:text-red-400 ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colExpenses')}</CellLabel>
                          {formatCurrency(row.Expenses)}
                        </td>
                        {/* Savings takes the middle of line 1 beside the month:
                            it is the figure the row is read for. */}
                        <td role="cell"
                          className={`col-start-2 row-start-1 font-medium ${row.Savings >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                        >
                          <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colSavings')}</CellLabel>
                          {formatCurrency(row.Savings)}
                        </td>
                        {/* The rate spans the first two tracks so its caption --
                            the longest in the table in every locale -- has room
                            on one line; right-aligned, it ends under Savings. */}
                        <td role="cell"
                          className={`col-start-1 col-span-2 row-start-2 font-medium ${row.SavingsRate >= 0 ? 'text-purple-600 dark:text-purple-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                        >
                          <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colSavingsRate')}</CellLabel>
                          {formatPercentTrimmed(row.SavingsRate)}
                        </td>
                        {/* Tagged transfer flows: indigo, never the green/red of
                            income and expenses, and third in the phone grid so
                            the five figures above keep their places. */}
                        {flowBucket && row.TaggedInflows !== undefined && row.TaggedOutflows !== undefined && (
                          <>
                            <td role="cell" className={`col-start-1 col-span-2 row-start-3 text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.inflows')}</CellLabel>
                              {formatCurrency(row.TaggedInflows)}
                            </td>
                            <td role="cell" className={`col-start-3 row-start-3 text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.outflows')}</CellLabel>
                              {formatCurrency(row.TaggedOutflows)}
                            </td>
                          </>
                        )}
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                  {/* The totals are the largest figures on the table, so this
                      row wraps the same way a data row does -- the same three
                      tracks and placement, each money cell captioned. */}
                  <tr role="row" className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                    <td role="cell" className="col-start-1 row-start-1 p-0 text-sm font-bold text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">{t('incomeVsExpenses.total')}</td>
                    {balanceWindow && flowBucket ? (
                      <>
                        <td role="cell" className={`col-start-3 row-start-1 font-bold text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colIncome')}</CellLabel>
                          <PartialTotal total={{ value: totals.totalIncome, ...completeness }} displayCurrency={reportingCurrency}>
                            {formatCurrency(totals.totalIncome)}
                          </PartialTotal>
                        </td>
                        <td role="cell" className={`col-start-1 col-span-2 row-start-3 font-bold text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.inflows')}</CellLabel>
                          <PartialTotal total={{ value: flowBucket.taggedInflows, missingCurrencies: flowBucket.missingCurrencies, excludedCount: flowBucket.excludedCount }} displayCurrency={reportingCurrency}>
                            {formatCurrency(flowBucket.taggedInflows)}
                          </PartialTotal>
                        </td>
                        <td role="cell" className={`col-start-3 row-start-2 font-bold text-red-600 dark:text-red-400 ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colExpenses')}</CellLabel>
                          <PartialTotal total={{ value: totals.totalExpenses, ...completeness }} displayCurrency={reportingCurrency}>
                            {formatCurrency(totals.totalExpenses)}
                          </PartialTotal>
                        </td>
                        {mode.showOutflows && (
                          <td role="cell" className={`col-start-3 row-start-3 font-bold text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.outflows')}</CellLabel>
                            <PartialTotal total={{ value: flowBucket.taggedOutflows, missingCurrencies: flowBucket.missingCurrencies, excludedCount: flowBucket.excludedCount }} displayCurrency={reportingCurrency}>
                              {formatCurrency(flowBucket.taggedOutflows)}
                            </PartialTotal>
                          </td>
                        )}
                        <td role="cell"
                          className={`col-start-2 row-start-1 font-bold ${(balanceWindow.balance ?? 0) >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                        >
                          <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.balance')}</CellLabel>
                          <PartialTotal total={{ value: balanceWindow.balance ?? 0, missingCurrencies: balanceWindow.missingCurrencies, excludedCount: balanceWindow.excludedCount }} displayCurrency={reportingCurrency}>
                            {formatCurrency(balanceWindow.balance ?? 0)}
                          </PartialTotal>
                        </td>
                        <td role="cell"
                          className={`col-start-1 col-span-2 row-start-2 font-bold ${(balanceWindow.balancePercent ?? 0) >= 0 ? 'text-purple-600 dark:text-purple-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                        >
                          <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.balancePercent')}</CellLabel>
                          {balanceWindow.balancePercent === null ? '\u2014' : formatPercent(balanceWindow.balancePercent, 2)}
                        </td>
                      </>
                    ) : (
                      <>
                      <td role="cell" className={`col-start-3 row-start-1 font-bold text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colIncome')}</CellLabel>
                        <PartialTotal total={{ value: totals.totalIncome, ...completeness }} displayCurrency={reportingCurrency}>
                          {formatCurrency(totals.totalIncome)}
                        </PartialTotal>
                      </td>
                      <td role="cell" className={`col-start-3 row-start-2 font-bold text-red-600 dark:text-red-400 ${MONEY_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colExpenses')}</CellLabel>
                        <PartialTotal total={{ value: totals.totalExpenses, ...completeness }} displayCurrency={reportingCurrency}>
                          {formatCurrency(totals.totalExpenses)}
                        </PartialTotal>
                      </td>
                      <td role="cell"
                        className={`col-start-2 row-start-1 font-bold ${totals.totalSavings >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                      >
                        <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colSavings')}</CellLabel>
                        <PartialTotal total={{ value: totals.totalSavings, ...completeness }} displayCurrency={reportingCurrency}>
                          {formatCurrency(totals.totalSavings)}
                        </PartialTotal>
                      </td>
                      <td role="cell"
                        className={`col-start-1 col-span-2 row-start-2 font-bold ${totals.savingsRate >= 0 ? 'text-purple-600 dark:text-purple-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                      >
                        <CellLabel className={CAPTION_CLASS}>{t('incomeVsExpenses.colSavingsRate')}</CellLabel>
                        {formatPercent(totals.savingsRate, 1)}
                      </td>
                      {flowBucket && (
                        <>
                          <td role="cell" className={`col-start-1 col-span-2 row-start-3 font-bold text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.inflows')}</CellLabel>
                            <PartialTotal total={{ value: flowBucket.taggedInflows, missingCurrencies: flowBucket.missingCurrencies, excludedCount: flowBucket.excludedCount }} displayCurrency={reportingCurrency}>
                              {formatCurrency(flowBucket.taggedInflows)}
                            </PartialTotal>
                          </td>
                          <td role="cell" className={`col-start-3 row-start-3 font-bold text-indigo-600 dark:text-indigo-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('tagBreakdown.outflows')}</CellLabel>
                            <PartialTotal total={{ value: flowBucket.taggedOutflows, missingCurrencies: flowBucket.missingCurrencies, excludedCount: flowBucket.excludedCount }} displayCurrency={reportingCurrency}>
                              {formatCurrency(flowBucket.taggedOutflows)}
                            </PartialTotal>
                          </td>
                        </>
                      )}
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
    </>
  );
}
