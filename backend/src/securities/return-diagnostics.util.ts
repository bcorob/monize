import type {
  IncompleteDataRange,
  IncompleteDataRanges,
} from "../net-worth/incomplete-data-ranges.util";

/**
 * What a withheld portfolio return is waiting for, named and dated.
 *
 * The summary card has no series on the client, so it cannot fold anything
 * itself; it used to render one generic marker ("no price") over a figure whose
 * real cause was one fund missing three months of closes, and the reader was
 * left to guess which holding (#1392). The period result now dates each cause
 * (`incomplete-data-ranges.util.ts`); this turns those runs into the rows a
 * reader can act on.
 *
 * NAMES, never ids: an id on the screen is a worse dead end than the sentence it
 * replaced. The caller resolves them from what it has loaded plus, for a
 * position sold out or an account no longer in the scope's holdings, a lookup by
 * id -- a gap is most likely on exactly the security nobody holds today.
 */
export interface ReturnDiagnosticPrice {
  securityId: string;
  symbol: string;
  name: string;
  start: string;
  end: string;
}

export interface ReturnDiagnosticRate {
  /** `"USD->PLN"`, as the valuation names the pair it could not convert. */
  pair: string;
  start: string;
  end: string;
}

export interface ReturnDiagnosticCash {
  accountId: string;
  name: string;
  start: string;
  end: string;
}

export interface ReturnDiagnostics {
  /** The baseline close the returns are measured from; `null` for no window. */
  since: string | null;
  prices: ReturnDiagnosticPrice[];
  rates: ReturnDiagnosticRate[];
  cash: ReturnDiagnosticCash[];
  /** Per cause: true when runs older than the ones listed were dropped. */
  truncated: { prices: boolean; rates: boolean; cash: boolean };
}

/** A security's identity, as a diagnostic row prints it. */
export interface SecurityLabel {
  symbol: string;
  name: string;
}

/** The diagnostics for a window with nothing to repair. */
export const EMPTY_RETURN_DIAGNOSTICS: ReturnDiagnostics = {
  since: null,
  prices: [],
  rates: [],
  cash: [],
  truncated: { prices: false, rates: false, cash: false },
};

/**
 * The dated runs of one window, labelled.
 *
 * A key with no label is DROPPED rather than printed as a UUID: the row exists
 * to send the reader somewhere, and an id sends them nowhere. The counts still
 * differ from the ranges only when a lookup failed, which is a defect in the
 * caller's loading rather than a state to caption.
 */
export function buildReturnDiagnostics(
  ranges: IncompleteDataRanges,
  since: string | null,
  securities: ReadonlyMap<string, SecurityLabel>,
  accounts: ReadonlyMap<string, string>,
): ReturnDiagnostics {
  const dates = (range: IncompleteDataRange) => ({
    start: range.start,
    end: range.end,
  });
  return {
    since,
    prices: ranges.prices.flatMap((range) => {
      const security = securities.get(range.key);
      if (!security) return [];
      return [
        {
          securityId: range.key,
          symbol: security.symbol,
          name: security.name,
          ...dates(range),
        },
      ];
    }),
    rates: ranges.rates.map((range) => ({
      pair: range.key,
      ...dates(range),
    })),
    cash: ranges.cash.flatMap((range) => {
      const name = accounts.get(range.key);
      if (!name) return [];
      return [{ accountId: range.key, name, ...dates(range) }];
    }),
    truncated: { ...ranges.truncated },
  };
}
