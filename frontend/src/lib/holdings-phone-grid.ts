import type { HideableColumn } from '@/lib/hidden-columns';

/** A figure column of the holdings table; Symbol is structural and fixed. */
export type HoldingsColumn = HideableColumn<'investmentHoldings'>;

/** The figures the account-total row carries (it has no per-share ones). */
export type HoldingsTotalColumn = 'costBasis' | 'mktValue' | 'gainLoss' | 'portfolioPercent';

/**
 * Where each visible figure sits in a holdings row's phone card (a four-column
 * grid below `sm`; inert from `sm` up, where the row is a table row). A hidden
 * column has no entry: its cell is absent from the DOM, never placed.
 */
export interface HoldingsPhonePlacement {
  /** The holding row and the cash row, which share one layout. */
  row: Partial<Record<HoldingsColumn, string>>;
  /** The account-total row. */
  total: Partial<Record<HoldingsTotalColumn, string>>;
}

// Every class this module can return is spelled out whole below, so Tailwind's
// source scan sees it; a class assembled from parts would never be generated.
// The strings for the all-visible layout are the literals the rows carried
// before columns could be hidden, byte for byte.

/** A one-column cell on the second row, by its column. */
const ONE_COLUMN_ROW_TWO = [
  'col-start-1 row-start-2',
  'col-start-2 row-start-2',
  'col-start-3 row-start-2',
  'col-start-4 row-start-2',
] as const;

/** A two-column cell, by its row, in the left or the right half of the card. */
const TWO_COLUMNS: Record<1 | 2 | 3, readonly [string, string]> = {
  1: ['col-start-1 col-span-2 row-start-1', 'col-start-3 col-span-2 row-start-1'],
  2: ['col-start-1 col-span-2 row-start-2', 'col-start-3 col-span-2 row-start-2'],
  3: ['col-start-1 col-span-2 row-start-3', 'col-start-3 col-span-2 row-start-3'],
};

/** Row 1's right half, beside the fixed Symbol (or account-total label). */
const MARKET_VALUE = TWO_COLUMNS[1][1];

/** The holding row's second line: one column each, packed from column 1. */
const ROW_TWO: readonly HoldingsColumn[] = ['shares', 'avgCost', 'price', 'portfolioPercent'];

/** The holding row's third line: half the card each, packed from the left. */
const ROW_THREE: readonly HoldingsColumn[] = ['costBasis', 'gainLoss'];

/** The account-total row's figures below row 1: half the card each, two to a line. */
const TOTAL_BELOW: readonly HoldingsTotalColumn[] = ['costBasis', 'gainLoss', 'portfolioPercent'];

/**
 * The phone-card placement of every visible figure for a hidden set.
 *
 * Holding and cash rows: row 1 is Symbol (fixed) and Mkt Value; row 2 packs the
 * visible of Shares, Avg Cost, Price and % Port from column 1; row 3 packs the
 * visible of Cost Basis and Gain/Loss, half the card each. Account-total row:
 * row 1 is the label and Mkt Value; the visible of Cost Basis, Gain/Loss and
 * % Port follow two to a line from row 2. A line left empty does not exist:
 * the one below it moves up, so the card never shows a blank row.
 */
export function holdingsPhonePlacement(hidden: ReadonlySet<string>): HoldingsPhonePlacement {
  const visible = <C extends string>(columns: readonly C[]) =>
    columns.filter((id) => !hidden.has(id));

  const row: Partial<Record<HoldingsColumn, string>> = {};
  if (!hidden.has('mktValue')) row.mktValue = MARKET_VALUE;
  const second = visible(ROW_TWO);
  second.forEach((id, i) => {
    row[id] = ONE_COLUMN_ROW_TWO[i];
  });
  const thirdLine = second.length > 0 ? 3 : 2;
  visible(ROW_THREE).forEach((id, i) => {
    row[id] = TWO_COLUMNS[thirdLine][i];
  });

  const total: Partial<Record<HoldingsTotalColumn, string>> = {};
  if (!hidden.has('mktValue')) total.mktValue = MARKET_VALUE;
  visible(TOTAL_BELOW).forEach((id, i) => {
    total[id] = TWO_COLUMNS[i < 2 ? 2 : 3][i % 2];
  });

  return { row, total };
}
