/**
 * The currency each money field on an investment transaction is denominated in.
 *
 * `price`, `commission` and `total_amount` are stored in the **security's**
 * currency (`docs/financial-semantics.md` section 6: `total_amount` is
 * `quantity * price +/- commission`, and `computeInvestmentCashImpact` derives
 * the cash side from the same three before any conversion). The row's
 * `exchangeRate` then converts that amount into the *settlement* account's
 * currency -- the funding account when one is named, otherwise the brokerage
 * account the row is filed under.
 *
 * Deriving a *trade's* currency from the account it is filed under is what made
 * a EUR trade and a USD trade both print with the reader's own symbol
 * (issue #1394): a security's price is struck in the security's currency
 * whatever account holds it, so the account is never the answer there.
 *
 * A row that names **no security** is the other case, and it is not unknown.
 * `resolveSettlementCurrencyPair` defines such a row's amount in the investment
 * account's currency when it writes it, so that is what these codes say; anything
 * else contradicts the figure the write path stored. `null` remains for a row
 * whose account was not loaded -- unknown, rendered as unknown, never the
 * reader's currency.
 */
export interface InvestmentRowCurrencies {
  /**
   * Currency of `totalAmount`: the security's, or -- for a row that names no
   * security -- the investment account's, which is what the write path
   * denominated it in. `null` only when neither is loaded.
   */
  amountCurrencyCode: string | null;
  /** Currency of `price`; the same source as the amount. */
  priceCurrencyCode: string | null;
  /** Currency of `commission`, being part of `totalAmount`; same source. */
  commissionCurrencyCode: string | null;
  /** Currency the row's cash leg settles in, or `null` when neither is loaded. */
  settlementCurrencyCode: string | null;
}

/** The relations `investmentRowCurrencies` reads, as much of them as it needs. */
export interface InvestmentRowCurrencySource {
  security?: { currencyCode?: string | null } | null;
  account?: { currencyCode?: string | null } | null;
  fundingAccount?: { currencyCode?: string | null } | null;
}

/**
 * Derive the four currency codes for one row. Every consumer reads these
 * instead of guessing from an account, so the unit travels with the figure.
 */
export function investmentRowCurrencies(
  row: InvestmentRowCurrencySource,
): InvestmentRowCurrencies {
  const securityCurrency = row.security?.currencyCode || null;
  // The investment account the row is filed under, never the funding account:
  // a security-less amount is denominated where `resolveSettlementCurrencyPair`
  // put it, which is the `from` side of the pair, and the funding account is
  // the `to` side.
  const amountCurrency = securityCurrency || row.account?.currencyCode || null;
  const settlement =
    row.fundingAccount?.currencyCode || row.account?.currencyCode || null;
  return {
    amountCurrencyCode: amountCurrency,
    priceCurrencyCode: amountCurrency,
    commissionCurrencyCode: amountCurrency,
    settlementCurrencyCode: settlement,
  };
}

/**
 * Stamp the codes onto every row of a page before it leaves the service.
 *
 * Mutates in place, as `attachAccruedInterest` does beside it: these are the
 * loaded entity instances the controller serialises, and rebuilding them would
 * drop the relations the same response carries.
 */
export function attachInvestmentRowCurrencies<
  T extends InvestmentRowCurrencySource & Partial<InvestmentRowCurrencies>,
>(rows: readonly T[]): void {
  for (const row of rows) {
    Object.assign(row, investmentRowCurrencies(row));
  }
}
