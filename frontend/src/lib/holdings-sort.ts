import type { AccountHoldings, HoldingWithMarketValue } from '@/types/investment';
import type { SortState } from '@/hooks/useSortableTable';
import type { HoldingsColumn } from '@/lib/holdings-phone-grid';

/** Every column of the holdings table sorts: Symbol plus the seven figure columns. */
export type HoldingsSortField = 'symbol' | HoldingsColumn;

/** The holdings table opens largest position first. */
export const DEFAULT_HOLDINGS_SORT: SortState<HoldingsSortField> = {
  field: 'mktValue',
  direction: 'desc',
};

const SYMBOL_SORT: SortState<HoldingsSortField> = { field: 'symbol', direction: 'asc' };

const FIELDS: ReadonlySet<string> = new Set<HoldingsSortField>([
  'symbol',
  'shares',
  'avgCost',
  'price',
  'costBasis',
  'mktValue',
  'gainLoss',
  'portfolioPercent',
]);

/**
 * The market value in the holding account's currency: the security's own value
 * when the currencies match, otherwise the server's converted figure from the
 * same snapshot as the account total. `null` when that pair had no rate --
 * unknown, never an implicit 1:1 and never a client-side re-conversion.
 */
export function holdingMarketValueInAccountCurrency(
  holding: HoldingWithMarketValue,
  accountCurrency: string,
): number | null {
  if (!holding.currencyCode || holding.currencyCode === accountCurrency) {
    return holding.marketValue;
  }
  return holding.marketValueAccountCurrency ?? null;
}

/**
 * The gain in the account's currency: unknown when either side is, never the
 * market value alone. Both sides are the server's, so they share one snapshot.
 */
export function holdingGainLossInAccountCurrency(
  holding: HoldingWithMarketValue,
  accountCurrency: string,
): number | null {
  const marketValue = holdingMarketValueInAccountCurrency(holding, accountCurrency);
  if (marketValue === null || holding.costBasisAccountCurrency === null) return null;
  return marketValue - holding.costBasisAccountCurrency;
}

/**
 * The market value in the reporting currency the portfolio total is in, the
 * numerator of the share of the portfolio. `null` when the pair is unresolved.
 */
export function holdingMarketValueInDefaultCurrency(
  holding: HoldingWithMarketValue,
  defaultCurrency: string,
): number | null {
  if (holding.currencyCode === defaultCurrency) return holding.marketValue;
  return holding.marketValueDefaultCurrency ?? null;
}

/**
 * The sort that is actually applied. A stored value that is not a holdings
 * sort (a hand-edited or stale key) is the default; a remembered sort on a
 * hidden column falls back to the default, or to Symbol when Market Value is
 * hidden too, because a hidden column has no header to sort back from. The
 * stored choice is untouched, so showing the column restores it.
 */
export function resolveHoldingsSort(
  sort: SortState<HoldingsSortField>,
  hidden: ReadonlySet<string>,
): SortState<HoldingsSortField> {
  const valid =
    FIELDS.has(sort?.field) && (sort.direction === 'asc' || sort.direction === 'desc');
  if (valid && !hidden.has(sort.field)) return sort;
  return hidden.has(DEFAULT_HOLDINGS_SORT.field) ? SYMBOL_SORT : DEFAULT_HOLDINGS_SORT;
}

/**
 * The value a column sorts by. The money columns compare in the account's
 * currency -- the one every row of the account table shares -- so a USD and a
 * CAD position are not ranked by their bare numbers. The per-share columns and
 * Shares compare the figure the row shows.
 */
function sortValue(
  holding: HoldingWithMarketValue,
  field: HoldingsSortField,
  accountCurrency: string,
  defaultCurrency: string,
): string | number | null {
  switch (field) {
    case 'symbol':
      return holding.symbol;
    case 'shares':
      return holding.quantity;
    case 'avgCost':
      return holding.averageCost;
    case 'price':
      return holding.currentPrice;
    case 'costBasis':
      return holding.costBasisAccountCurrency;
    case 'mktValue':
      return holdingMarketValueInAccountCurrency(holding, accountCurrency);
    case 'gainLoss':
      return holdingGainLossInAccountCurrency(holding, accountCurrency);
    case 'portfolioPercent':
      return holdingMarketValueInDefaultCurrency(holding, defaultCurrency);
  }
}

function compareKnown(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

/**
 * One account's holdings in the table's order, as a new array. An unknown
 * value sorts after every known one in either direction (it is not the
 * smallest), and ties fall back to the symbol so the order is stable.
 */
export function sortHoldings(
  holdings: readonly HoldingWithMarketValue[],
  sort: SortState<HoldingsSortField>,
  accountCurrency: string,
  defaultCurrency: string,
): HoldingWithMarketValue[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...holdings].sort((a, b) => {
    const av = sortValue(a, sort.field, accountCurrency, defaultCurrency);
    const bv = sortValue(b, sort.field, accountCurrency, defaultCurrency);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const primary = av === null || bv === null ? 0 : sign * compareKnown(av, bv);
    return primary !== 0 ? primary : compareKnown(a.symbol, b.symbol);
  });
}

/** The accounts in alphabetical order by name, as a new array. */
export function sortAccountsByName(accounts: readonly AccountHoldings[]): AccountHoldings[] {
  return [...accounts].sort((a, b) => compareKnown(a.accountName, b.accountName));
}
