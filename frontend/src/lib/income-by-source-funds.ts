import { taggedFunds } from './tagged-balance';
import type { FundingWindow } from './tagged-funding';
import type { ConvertedTotal } from './currency-total';

export interface IncomeFundsEntry {
  /** The window's net tagged inflow under the chosen value; always > 0 here. */
  netTagged: number;
  /** Total income plus `netTagged`. */
  availableFunds: number;
  /** The bucket's gaps: the entry and the total are subtotals when it has any. */
  entryTotal: ConvertedTotal;
  availableTotal: ConvertedTotal;
}

/**
 * The extra entry and the Available funds total of Income by Source
 * (`docs/specs/report-tag-key-breakdown.md` section 11.3). Only a net tagged
 * INFLOW is shown: when the value brought nothing in (or took as much out) there
 * is no entry and no Available funds, and the caller says so. The income total
 * the caller passes is Income by Source's own and is never changed here.
 */
export function incomeFundsEntry(
  totalIncome: number,
  window: FundingWindow,
): IncomeFundsEntry | null {
  const { netTagged, availableFunds } = taggedFunds({
    income: totalIncome,
    taggedInflows: window.taggedInflows,
    taggedOutflows: window.taggedOutflows,
  });
  if (netTagged === null || availableFunds === null || netTagged <= 0) return null;
  return {
    netTagged,
    availableFunds,
    entryTotal: { value: netTagged, ...window.bucket },
    availableTotal: { value: availableFunds, ...window.bucket },
  };
}
