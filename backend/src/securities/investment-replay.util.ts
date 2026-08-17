import { InvestmentAction } from "./entities/investment-transaction.entity";

/**
 * The base action each Money-vocabulary refinement behaves as (issue #1149).
 *
 * A refinement moves shares and cash exactly like its base -- REINVEST_INTEREST
 * buys shares with money that never lands as cash, REDEEM is a disposal with
 * proceeds -- and differs only in the kind of income it records, which is what
 * tax reporting needs. Every financial fold (share replay, cash impact, cost
 * basis, balance effects) normalizes through `baseInvestmentAction` first, so a
 * refinement cannot drift from its base one switch at a time; only surfaces
 * that classify income read the raw action.
 */
const BASE_ACTION_BY_REFINEMENT: ReadonlyMap<
  InvestmentAction | string,
  InvestmentAction
> = new Map([
  [InvestmentAction.REINVEST_INTEREST, InvestmentAction.REINVEST],
  [InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT, InvestmentAction.REINVEST],
  [InvestmentAction.REINVEST_CAPITAL_GAIN_LONG, InvestmentAction.REINVEST],
  [InvestmentAction.CAPITAL_GAIN_SHORT, InvestmentAction.CAPITAL_GAIN],
  [InvestmentAction.CAPITAL_GAIN_LONG, InvestmentAction.CAPITAL_GAIN],
  [InvestmentAction.REDEEM, InvestmentAction.SELL],
]);

/**
 * The action whose financial behaviour governs `action` -- itself, unless it is
 * one of the Money-vocabulary refinements above.
 */
export function baseInvestmentAction(
  action: InvestmentAction | string,
): InvestmentAction | string {
  return BASE_ACTION_BY_REFINEMENT.get(action) ?? action;
}

/**
 * The canonical share-count effect of one investment action.
 *
 * Every surface that reconstructs a position from its transaction history --
 * the live holdings rebuild, the historical net-worth replay, the cost-basis
 * and capital-gains replays -- folds the same list of actions in the same
 * direction. Written out per call site the list drifts, and the drift is
 * invisible because each copy is internally consistent: three net-worth
 * reducers added a SPLIT's ratio to the share count (10 shares + a 2-for-1
 * ratio = 12) while the holdings service multiplied by it (= 20), so the same
 * position was worth 600 on the history chart and 1,000 on the holdings page.
 * The same three copies omitted ADD_SHARES and REMOVE_SHARES entirely, so
 * shares booked without a purchase never appeared in any historical chart.
 *
 * `quantity` means different things per action and that is the point of
 * centralizing it:
 * - BUY / REINVEST / TRANSFER_IN / ADD_SHARES -- shares acquired, added.
 * - SELL / TRANSFER_OUT / REMOVE_SHARES -- shares disposed of, subtracted.
 * - SPLIT -- a **ratio**, not a share count. The position is multiplied by it,
 *   which is what preserves total cost basis across a split. A 2-for-1 split
 *   carries `quantity = 2`; a 1-for-2 reverse split carries `0.5`.
 * - DIVIDEND / INTEREST / CAPITAL_GAIN -- cash only, no share movement.
 *
 * A non-positive SPLIT ratio is not applied: it would zero or invert a real
 * position, and a row that cannot say what the split was is not evidence that
 * the shares went away.
 */
export function applyActionToQuantity(
  currentQuantity: number,
  action: InvestmentAction | string,
  quantity: number,
): number {
  switch (baseInvestmentAction(action)) {
    case InvestmentAction.BUY:
    case InvestmentAction.REINVEST:
    case InvestmentAction.TRANSFER_IN:
    case InvestmentAction.ADD_SHARES:
      return currentQuantity + quantity;
    case InvestmentAction.SELL:
    case InvestmentAction.TRANSFER_OUT:
    case InvestmentAction.REMOVE_SHARES:
      return currentQuantity - quantity;
    case InvestmentAction.SPLIT:
      return quantity > 0 ? currentQuantity * quantity : currentQuantity;
    default:
      // DIVIDEND / INTEREST / CAPITAL_GAIN move cash, not shares.
      return currentQuantity;
  }
}

/**
 * Actions that move shares, and therefore the ones a quantity replay must read.
 * A replay that filters its input by action list uses this rather than spelling
 * the list out, so a new action cannot be silently dropped from one surface.
 */
export const SHARE_MOVING_ACTIONS: readonly InvestmentAction[] = [
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REINVEST,
  InvestmentAction.TRANSFER_IN,
  InvestmentAction.TRANSFER_OUT,
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
  InvestmentAction.SPLIT,
  // Money-vocabulary refinements that move shares, exactly as their base does.
  InvestmentAction.REINVEST_INTEREST,
  InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
  InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
  InvestmentAction.REDEEM,
];

/**
 * Trades executed at a market price: the actions whose stored `price` can
 * stand in for a quote on a day the catalogue has none, and whose value moves
 * a portfolio's cash-flow series. TRANSFER_IN/OUT legs carry a carried cost
 * basis rather than the market price on the transfer date, so they are
 * deliberately absent. Raw-SQL readers pass this through `= ANY($n)` instead
 * of restating the list as string literals -- the restated copies are how the
 * Money refinements would silently fall out of the price-derivation and
 * net-worth queries.
 */
export const MARKET_PRICED_TRADE_ACTIONS: readonly InvestmentAction[] = [
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REINVEST,
  InvestmentAction.REINVEST_INTEREST,
  InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
  InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
  InvestmentAction.REDEEM,
];

/**
 * Actions whose `totalAmount` is cash income paid into the sleeve. The raw
 * value keeps the income kind (interest versus short- versus long-term gain);
 * the base collapses the kinds for surfaces that only need "income".
 */
export const CASH_INCOME_ACTIONS: readonly InvestmentAction[] = [
  InvestmentAction.DIVIDEND,
  InvestmentAction.INTEREST,
  InvestmentAction.CAPITAL_GAIN,
  InvestmentAction.CAPITAL_GAIN_SHORT,
  InvestmentAction.CAPITAL_GAIN_LONG,
];

/**
 * The only actions allowed to use an explicit funding account: a BUY draws the
 * purchase cost from it, a SELL deposits the proceeds into it. Cash-bearing
 * DIVIDEND / INTEREST / CAPITAL_GAIN settle against the brokerage's linked cash
 * account; REINVEST and the share-only actions have no external cash leg at all.
 * So a funding account stored on any non-BUY/SELL action is stale and must never
 * route the money (issue #1154).
 *
 * Centralized so the scheduled-transaction service (which clears the column on
 * write and ignores it on post) and the MNY import writer (which must not
 * persist one on a non-funding action) share one authority rather than each
 * spelling out `{BUY, SELL}` and drifting apart.
 *
 * REDEEM is a sale in behaviour (`baseInvestmentAction`), so its proceeds
 * route to a funding account exactly as a SELL's do -- the transaction form
 * offers the field for it, and a set without it would silently clear what the
 * form stored.
 */
export const FUNDING_ACCOUNT_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REDEEM,
]);

/**
 * Whether an action adds shares to a position without supplying a cost for
 * them. Basis-carrying replays must record that the basis they computed is
 * incomplete rather than treating the shares as free.
 */
export function isQuantityOnlyAction(
  action: InvestmentAction | string,
): boolean {
  return (
    action === InvestmentAction.ADD_SHARES ||
    action === InvestmentAction.REMOVE_SHARES
  );
}

/**
 * What an acquisition cost, in the currency the trade settled in.
 *
 * The commission belongs in the basis: it is part of what was paid to acquire
 * the position, and the linked cash debit already includes it. Leaving it out
 * understates the basis and so overstates every gain and every tax derived
 * from one -- 10 of commission on a 1,000 purchase is 10 of phantom gain.
 *
 * Returns `null` when the row cannot say what the acquisition cost: a missing
 * price is unknown, not free. A stored `0` is *no price* too, not a free
 * acquisition -- before the acquisition guard shipped, `create()` stored
 * `price ?? 0` and the form accepted a blank field, so real databases hold
 * zero-price BUY and REINVEST rows that mean "unknown". Replaying one as a
 * known zero-cost lot understates the basis and overstates every gain and tax
 * drawn from it, the same defect the null case closes arriving by a different
 * route. No legitimate zero can be stored from here on:
 * `assertAcquisitionPriced` refuses it, because a zero-cost purchase is not a
 * concept this application has.
 */
export function acquisitionCost(tx: {
  quantity?: number | string | null;
  price?: number | string | null;
  commission?: number | string | null;
  exchangeRate?: number | string | null;
}): number | null {
  const quantity = Number(tx.quantity) || 0;
  const commission = Number(tx.commission) || 0;
  const hasPrice =
    tx.price !== null &&
    Number.isFinite(Number(tx.price)) &&
    Number(tx.price) > 0;

  if (!hasPrice && (quantity !== 0 || commission !== 0)) {
    return null;
  }

  const price = Number(tx.price) || 0;
  // An absent rate means the trade settled in its own currency (the entity
  // default is 1). A stored zero or negative rate is absent-not-applicable
  // (root CLAUDE.md: "Rate 1 means same currency, never no rate found"), so
  // the basis is unknown rather than converted at par -- `|| 1` here would
  // bake the silent 1:1 fallback into the one door every basis goes through.
  const rate = tx.exchangeRate == null ? 1 : Number(tx.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return (quantity * price + commission) * rate;
}

/**
 * The per-share cost of an acquisition, commission included.
 *
 * `Holding.averageCost` is maintained incrementally on every acquisition, and it
 * was fed the raw market price -- so the live holding said 100.00 per share while
 * a rebuild, which goes through `acquisitionCost`, said 101.00 for the same buy.
 * The two disagreed until something unrelated triggered a rebuild, and the
 * holdings screen showed whichever had run last (review finding FR-008).
 *
 * Falls back to the price when there are no shares to divide by, and when the
 * row cannot say what it cost -- an unpriced acquisition has no per-share cost to
 * derive, and the caller's existing price guard decides what to do about that.
 */
export function acquisitionUnitCost(tx: {
  quantity?: number | string | null;
  price?: number | string | null;
  commission?: number | string | null;
}): number {
  const quantity = Number(tx.quantity) || 0;
  const price = Number(tx.price) || 0;
  if (quantity === 0) return price;

  const cost = acquisitionCost({
    quantity,
    price: tx.price,
    commission: tx.commission,
  });
  if (cost === null) return price;

  return cost / quantity;
}
