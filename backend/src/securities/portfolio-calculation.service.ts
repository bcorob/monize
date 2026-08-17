import { Injectable, Logger } from "@nestjs/common";
import { DataSource, FindOptionsWhere, In, LessThanOrEqual } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Holding } from "./entities/holding.entity";
import { NON_VOID_INVESTMENT_STATUS } from "./investment-row-effects.util";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  HoldingWithMarketValue,
  AccountHoldings,
  AllocationItem,
} from "./portfolio.service";
import { roundMoney } from "../common/round.util";
import { parseTag } from "../tags/tag-key-value.util";
import { formatDateYMD, formatDateYMDLocal } from "../common/date-utils";
import { mapWithConcurrency } from "../common/concurrency.util";
import { convertWithRateLookup } from "../common/currency-conversion.util";
import { FxAggregate } from "../common/fx-aggregate";
import {
  acquisitionCost,
  applyActionToQuantity,
  baseInvestmentAction,
  CASH_INCOME_ACTIONS,
} from "./investment-replay.util";
import { stripBrokerageSuffix } from "../accounts/account-name.util";

// "As of now" portfolio valuations fetch a live spot rate per foreign
// currency. Cap concurrent quote-provider fetches so a portfolio spanning
// many currencies does not burst the provider on an interactive request.
const LIVE_FX_FETCH_CONCURRENCY = 6;

/**
 * Date-indexed history of stored daily exchange rates, keyed by the raw
 * "{from}->{to}" pair as stored in the exchange_rates table. Each entry's
 * rates are sorted ascending by date so an "as of" lookup can walk to the
 * most recent rate at or before a target date. Used to value intraday chart
 * bars that fall outside the live intraday FX series (pre-market, weekend and
 * holiday gaps, or a failed FX fetch) at the rate that actually prevailed on
 * that bar's own date rather than a single near-current rate.
 */
/** Why a replayed lot's cost basis cannot be trusted against the live holding. */
export type ReplayedBasisGap =
  | "quantity_only_action"
  | "unpriced_acquisition"
  | "mixed_basis_currency"
  | "transferred_basis_unknown";

/** A position rebuilt from its transactions: what is held, and what it cost. */
export interface ReplayedLot {
  /** Units the transaction history accounts for. */
  quantity: number;
  /**
   * Their cost, commissions included, in `currencyCode`.
   *
   * Only meaningful when `basisKnown`; otherwise it is the cost of the part of
   * the position the history does price, which is a different position.
   */
  costBasis: number;
  /**
   * The currency `costBasis` is actually denominated in, or null when the
   * replay could not settle on one.
   *
   * **Not** the holding account's currency, which is what this used to be
   * assumed to be. `InvestmentTransaction.exchangeRate` converts the trade out
   * of the security's currency and into the *cash or funding* account's -- the
   * account the money came from -- and that is a different account, with its
   * own currency, whenever a brokerage settles through a linked cash account
   * or a purchase is funded from elsewhere. A PLN brokerage funded in EUR
   * produced a basis in EUR and a caller comparing it against a PLN market
   * value read the FX difference as gain, then taxed it.
   *
   * A caller that reports a gain or a tax must check this against the currency
   * it is reporting in, and treat a mismatch as unknown rather than converting
   * at today's rate: the acquisition happened at the historical rate, and
   * today's would answer a different question.
   */
  currencyCode: string | null;
  /** False when the replay met a row it could not price, or could not denominate. */
  basisKnown: boolean;
  /** Which gap made it unknown, for a caller that reports the reason. */
  basisGap: ReplayedBasisGap | null;
}

export type DailyRateIndex = Map<string, Array<{ date: string; rate: number }>>;

/**
 * Per-request spot-rate cache keyed `"FROM->TO"`. `null` is a cached *absence*:
 * the pair was looked up and has no usable rate, so later conversions in the
 * same request return unknown immediately instead of re-running the lookups
 * and re-logging the warning per holding.
 */
export type FxRateCache = Map<string, number | null>;

/**
 * Categorised investment accounts: brokerage, standalone, and cash accounts
 * with pre-computed holdings account IDs.
 */
export interface CategorisedAccounts {
  cashAccounts: Account[];
  brokerageAccounts: Account[];
  standaloneAccounts: Account[];
  holdingsAccountIds: string[];
}

/**
 * A single SELL transaction with the cost basis and realized gain derived
 * from replaying transaction history up to the sale. All monetary fields
 * are denominated in the holding account's currency.
 */
export interface RealizedGainEntry {
  transactionId: string;
  transactionDate: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  quantity: number;
  price: number;
  commission: number;
  proceeds: number;
  costBasis: number;
  realizedGain: number;
}

/**
 * Per-(account, security, month) capital-gain breakdown including both the
 * realized portion (from SELLs in the month) and the unrealized mark-to-market
 * change on the position. All monetary values are denominated in the holding
 * account's currency. The decomposition uses:
 *
 *   totalCapitalGain = (endValue - startValue) + sells - buys
 *   unrealizedGain   = totalCapitalGain - realizedGain
 *
 * which is equivalent to "change in market value plus net cash withdrawn from
 * the position". Months with zero quantity and zero activity are dropped.
 */
export interface CapitalGainEntry {
  month: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  startQuantity: number;
  endQuantity: number;
  /**
   * Period-boundary market values in the account's currency, and the gains
   * derived from them.
   *
   * `null` when the security's currency could not be converted into the
   * account's -- the position's value at each boundary is then unknown, so a
   * gain measured between them is too. `sells` stays known: it comes from the
   * amounts and exchange rates stored on each transaction.
   *
   * `realizedGain` and the gains derived from `buys` are additionally `null`
   * when the position's basis carries a lot whose cost the row cannot state
   * (an unpriced acquisition): a gain measured against an unknown basis is
   * unknown, never the proceeds measured against zero. `buys` itself remains
   * the known subtotal of the priced acquisitions, which is why the gain
   * fields carry the unknown rather than the cash-movement fields.
   */
  startValue: number | null;
  endValue: number | null;
  buys: number;
  sells: number;
  realizedGain: number | null;
  unrealizedGain: number | null;
  totalCapitalGain: number | null;
}

/**
 * Add `days` to a YYYY-MM-DD date string and return a new YYYY-MM-DD string.
 * Uses UTC to avoid local-timezone drift when crossing day boundaries.
 */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * How far a replayed quantity may sit from the held one and still be the same
 * position. The dust threshold the portfolio views already use for "no
 * position": below it the difference cannot move a per-share figure meaningfully.
 */
const COST_BASIS_QUANTITY_TOLERANCE = 0.0001;

/**
 * Where a trade's money landed, in the two roles an account can play. Both maps
 * are keyed by account id and agree for every account that is not a brokerage
 * with a linked cash account.
 */
interface SettlementCurrencies {
  /** The account's own currency -- what an explicitly named funding account settles in. */
  own: Map<string, string>;
  /** Where a brokerage's cash sits: its linked cash account's currency, or its own. */
  brokerage: Map<string, string>;
}

interface PeriodBucket {
  key: string; // YYYY-MM for months, YYYY-MM-DD for days
  periodStart: string; // YYYY-MM-DD first day of period
  periodEnd: string; // YYYY-MM-DD last day of period
  priceLookupStart: string; // day before periodStart, used to value the position at period start
}

/**
 * Enumerate calendar months covered by [startDate, endDate]. Each entry
 * carries the YYYY-MM key, the (clamped) start/end day-of-month, and the
 * day-before-start date used to look up the starting price for the month.
 */
function enumerateMonths(startDate: string, endDate: string): PeriodBucket[] {
  const [sy, sm] = startDate.split("-").map(Number);
  const [ey, em] = endDate.split("-").map(Number);
  const buckets: PeriodBucket[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const firstOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDayNum = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lastOfMonth = `${y}-${String(m).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;
    const periodStart = firstOfMonth < startDate ? startDate : firstOfMonth;
    const periodEnd = lastOfMonth > endDate ? endDate : lastOfMonth;
    buckets.push({
      key: `${y}-${String(m).padStart(2, "0")}`,
      periodStart,
      periodEnd,
      priceLookupStart: addDaysIso(periodStart, -1),
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return buckets;
}

/**
 * Enumerate calendar days covered by [startDate, endDate]. Each entry
 * carries the YYYY-MM-DD key and the day-before date for the start-of-day
 * price lookup.
 */
function enumerateDays(startDate: string, endDate: string): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  let current = startDate;
  while (current <= endDate) {
    buckets.push({
      key: current,
      periodStart: current,
      periodEnd: current,
      priceLookupStart: addDaysIso(current, -1),
    });
    current = addDaysIso(current, 1);
  }
  return buckets;
}

/**
 * Apply a single investment transaction to a running
 * { quantity, costBasis, basisKnown } state in account-currency terms. Used to
 * seed cost basis from history that predates the requested capital-gains
 * window. `basisKnown` goes false when a lot joins whose cost the row cannot
 * state -- the basis is then a subtotal, and every figure derived from it is
 * unknown rather than confidently wrong. It resets to true when the position
 * closes: an empty position holds a known zero basis.
 */
function applyTxToState(
  tx: InvestmentTransaction,
  state: { quantity: number; costBasis: number; basisKnown: boolean },
): void {
  const quantity = Number(tx.quantity) || 0;

  switch (baseInvestmentAction(tx.action)) {
    case InvestmentAction.BUY:
    case InvestmentAction.REINVEST:
    case InvestmentAction.TRANSFER_IN: {
      // Includes the commission, which is part of what the acquisition cost --
      // the linked cash debit already carries it. `null` means the row cannot
      // say what it cost, and shares whose cost is unknown must not join the
      // basis as free -- nor leave the basis pretending to be complete.
      const cost = acquisitionCost(tx);
      if (cost !== null) state.costBasis += cost;
      else state.basisKnown = false;
      state.quantity = applyActionToQuantity(
        state.quantity,
        tx.action,
        quantity,
      );
      break;
    }
    case InvestmentAction.SELL:
    case InvestmentAction.TRANSFER_OUT: {
      const sellQty = Math.min(quantity, state.quantity);
      const avgCostPerShare =
        state.quantity > 0 ? state.costBasis / state.quantity : 0;
      state.costBasis -= sellQty * avgCostPerShare;
      state.quantity -= sellQty;
      break;
    }
    default:
      state.quantity = applyActionToQuantity(
        state.quantity,
        tx.action,
        quantity,
      );
      break;
  }

  if (Math.abs(state.quantity) < 0.0001) {
    state.quantity = 0;
    state.costBasis = 0;
    // A closed position holds a known zero basis; the unknown lot is gone.
    state.basisKnown = true;
  }
}

/**
 * Service responsible for the core portfolio value calculations:
 * holdings valuation, account grouping, allocation, TWR, and CAGR.
 *
 * Extracted from PortfolioService to keep file sizes manageable.
 */
@Injectable()
export class PortfolioCalculationService {
  private readonly logger = new Logger(PortfolioCalculationService.name);

  constructor(
    private dataSource: DataSource,
    private exchangeRateService: ExchangeRateService,
  ) {}

  // ---------------------------------------------------------------------------
  // Currency conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert an amount from one currency to another using the latest exchange
   * rates. Returns `null` when no rate exists for the pair.
   *
   * `null`, not the amount unchanged: this used to fall back to `rate = 1`,
   * which reported 1,000 USD as 1,000 EUR and gave a consumer no way to tell
   * that from a genuine 1:1 pair (audit P5-009). Rate 1 is now reachable only
   * when the two currency codes are equal. Callers accumulate through
   * `FxAggregate` so a missing rate makes the total unknown rather than wrong;
   * see `docs/specs/fx-conversion-completeness.md`.
   */
  async convertToDefault(
    amount: number,
    fromCurrency: string,
    defaultCurrency: string,
    rateCache: FxRateCache,
  ): Promise<number | null> {
    if (fromCurrency === defaultCurrency) return amount;

    // Zero converts to zero at any rate, so it needs none. Without this an empty
    // foreign account -- no cash, no holdings, nothing invested -- reported its
    // own currency as an unresolvable pair and made the whole portfolio's totals
    // "unknown", which is the other half of the contract's missing-data rule: a
    // settled question must not be reported as one that could not be worked out.
    if (amount === 0) return 0;

    const cacheKey = `${fromCurrency}->${defaultCurrency}`;
    let rate = rateCache.get(cacheKey);
    if (rate === undefined) {
      const directRate = await this.exchangeRateService.getLatestRate(
        fromCurrency,
        defaultCurrency,
      );
      if (directRate !== null && directRate > 0) {
        rate = directRate;
      } else {
        const reverseRate = await this.exchangeRateService.getLatestRate(
          defaultCurrency,
          fromCurrency,
        );
        if (reverseRate === null || reverseRate <= 0) {
          // The absence is cached too (`null`), so a portfolio with many
          // holdings in one unrated currency resolves the pair once per
          // request instead of re-running both lookups and re-warning per
          // holding -- the warn below is therefore once per pair per cache.
          this.logger.warn(
            `No exchange rate available for ${cacheKey}; the affected total is reported as unknown rather than converted 1:1`,
          );
          rateCache.set(cacheKey, null);
          return null;
        }
        rate = 1 / reverseRate;
      }
      rateCache.set(cacheKey, rate);
    }
    if (rate === null) return null;
    return amount * rate;
  }

  /**
   * Pre-populate the rate cache with live spot FX rates for every non-default
   * currency held across the given accounts and their holdings. The portfolio
   * summary's "as of now" valuations (holdings value, cash, allocation, net
   * invested) then convert at the current rate -- matching the live Portfolio
   * Value Over Time chart -- instead of the once-a-day stored snapshot used by
   * getLatestRate.
   *
   * Best effort: when a live quote is unavailable for a currency the cache is
   * left unset for that pair, so the downstream convertToDefault falls back to
   * the stored daily rate (its existing behaviour).
   */
  async primeLiveRates(
    rateCache: FxRateCache,
    accounts: Account[],
    holdingsAccountIds: string[],
    defaultCurrency: string,
  ): Promise<void> {
    const currencies = new Set<string>();
    for (const account of accounts) {
      if (account.currencyCode) currencies.add(account.currencyCode);
    }

    if (holdingsAccountIds.length > 0) {
      const rows: Array<{ currency: string | null }> = await withScopedDb(
        this.dataSource,
        (m) =>
          m
            .getRepository(Holding)
            .createQueryBuilder("h")
            .innerJoin("h.security", "s")
            .where("h.account_id IN (:...ids)", { ids: holdingsAccountIds })
            .select("DISTINCT s.currency_code", "currency")
            .getRawMany(),
      );
      for (const row of rows) {
        if (row.currency) currencies.add(row.currency);
      }
    }

    currencies.delete(defaultCurrency);

    await mapWithConcurrency(
      [...currencies],
      LIVE_FX_FETCH_CONCURRENCY,
      async (currency) => {
        const rate = await this.exchangeRateService.getLiveRate(
          currency,
          defaultCurrency,
        );
        if (rate !== null && rate > 0) {
          rateCache.set(`${currency}->${defaultCurrency}`, rate);
        }
      },
    );
  }

  /**
   * Build a date-indexed history of stored daily rates for converting each of
   * `currencies` to `defaultCurrency`, covering [startDate, endDate]. Only the
   * pairs that involve the default currency and a requested currency are kept,
   * in either direction, so `resolveDailyRate` can apply the same direct-then-
   * inverse decision used everywhere else.
   *
   * Used by the intraday Portfolio Value Over Time chart to value bars that the
   * live intraday FX series does not cover at the daily close that prevailed on
   * that bar's own date, instead of the first/latest intraday rate.
   */
  async buildDailyRateIndex(
    currencies: Iterable<string>,
    defaultCurrency: string,
    startDate: string,
    endDate: string,
  ): Promise<DailyRateIndex> {
    const needed = new Set<string>();
    for (const c of currencies) {
      if (c && c !== defaultCurrency) needed.add(c);
    }
    const index: DailyRateIndex = new Map();
    if (needed.size === 0) return index;

    const rows = await this.exchangeRateService.getRateHistory(
      startDate,
      endDate,
    );
    for (const row of rows) {
      const from = row.fromCurrency;
      const to = row.toCurrency;
      const involvesPair =
        (needed.has(from) && to === defaultCurrency) ||
        (from === defaultCurrency && needed.has(to));
      if (!involvesPair) continue;
      const key = `${from}->${to}`;
      const arr = index.get(key);
      // rate_date is normally returned as a "YYYY-MM-DD" string (DATE columns
      // are parsed as strings, see main.ts) but tolerate a Date instance too.
      const rawDate: string | Date = row.rateDate;
      const date =
        rawDate instanceof Date
          ? formatDateYMD(rawDate)
          : String(rawDate).substring(0, 10);
      const entry = { date, rate: Number(row.rate) };
      if (arr) {
        index.set(key, [...arr, entry]);
      } else {
        index.set(key, [entry]);
      }
    }

    // getRateHistory already orders by rate_date ASC, but sort defensively so
    // the as-of walk in resolveDailyRate never depends on query ordering.
    for (const [key, arr] of index) {
      index.set(
        key,
        [...arr].sort((a, b) =>
          a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
        ),
      );
    }

    return index;
  }

  /**
   * Resolve the stored daily rate for converting 1 unit of `from` to `to` as of
   * `dateStr` (YYYY-MM-DD) from a `DailyRateIndex`. Picks the most recent rate
   * at or before the date; if none exists yet it uses the earliest known rate.
   * Returns undefined when the pair is absent in either direction so callers can
   * apply their own fallback.
   */
  resolveDailyRate(
    index: DailyRateIndex,
    from: string,
    to: string,
    dateStr: string,
  ): number | undefined {
    const result = convertWithRateLookup(1, from, to, (f, t) => {
      const rates = index.get(`${f}->${t}`);
      if (!rates || rates.length === 0) return undefined;
      let best: number | undefined;
      for (const r of rates) {
        if (r.date <= dateStr) best = r.rate;
        else break;
      }
      return best ?? rates[0].rate;
    });
    return result == null ? undefined : result;
  }

  // ---------------------------------------------------------------------------
  // Account categorisation
  // ---------------------------------------------------------------------------

  /**
   * Split a list of investment accounts into cash, brokerage, and standalone
   * buckets and derive the IDs of accounts that carry holdings.
   */
  categoriseAccounts(accounts: Account[]): CategorisedAccounts {
    const cashAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_CASH,
    );
    const brokerageAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE,
    );
    const standaloneAccounts = accounts.filter(
      (a) => a.accountSubType === null || a.accountSubType === undefined,
    );
    const holdingsAccountIds = [
      ...brokerageAccounts.map((a) => a.id),
      ...standaloneAccounts.map((a) => a.id),
    ];
    return {
      cashAccounts,
      brokerageAccounts,
      standaloneAccounts,
      holdingsAccountIds,
    };
  }

  // ---------------------------------------------------------------------------
  // Cash balance helpers
  // ---------------------------------------------------------------------------

  /**
   * Get effective cash balances (excluding future-dated transactions)
   * for the given accounts. Uses the account's currentBalance field,
   * which is already maintained to exclude future-dated transactions
   * by recalculateCurrentBalance / updateBalance.
   */
  async computeEffectiveBalances(
    accountIds: string[],
  ): Promise<Map<string, number>> {
    const effectiveBalances = new Map<string, number>();
    if (accountIds.length === 0) return effectiveBalances;

    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { id: In(accountIds) },
        select: ["id", "currentBalance"],
      }),
    );
    for (const account of accounts) {
      effectiveBalances.set(
        account.id,
        roundMoney(Number(account.currentBalance)),
      );
    }
    return effectiveBalances;
  }

  /**
   * Sum cash balances across the given accounts, converting to defaultCurrency.
   */
  async computeTotalCashValue(
    accounts: Account[],
    effectiveBalances: Map<string, number>,
    defaultCurrency: string,
    rateCache: FxRateCache,
  ): Promise<{
    total: number;
    fxComplete: boolean;
    missingRatePairs: string[];
  }> {
    const cash = new FxAggregate();
    for (const a of accounts) {
      const balance = effectiveBalances.get(a.id) ?? Number(a.currentBalance);
      cash.add(
        await this.convertToDefault(
          balance,
          a.currencyCode,
          defaultCurrency,
          rateCache,
        ),
        a.currencyCode,
        defaultCurrency,
      );
    }
    // The gap is returned, not only logged. A log is invisible to the API and to
    // every consumer downstream, so a caller had no way to tell this subtotal
    // from a complete total -- which is how an incomplete cash figure reached a
    // Monte Carlo starting balance (review finding FR-005).
    if (!cash.isComplete) {
      this.logger.warn(
        `Cash total omits balances with no exchange rate (${cash.missingPairs.join(", ")})`,
      );
    }
    return {
      total: cash.knownSubtotal,
      fxComplete: cash.isComplete,
      missingRatePairs: cash.missingPairs,
    };
  }

  // ---------------------------------------------------------------------------
  // Investment flow helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute per-account investment transaction sums (BUYs, SELLs, Income)
   * for Net Invested calculation.
   *
   * `total_amount` is stored in the security's native currency, so each row
   * is multiplied by its `exchange_rate` (security currency -> cash account
   * currency) to keep the returned figures in the holding account's cash
   * currency. This matches the units of the per-account `cashBalance` used
   * by `buildHoldingsByAccount`, preventing a USD + CAD mix-up when the
   * security and the account use different currencies.
   */
  async computeInvestmentFlows(
    userId: string,
    accountIds: string[],
  ): Promise<Map<string, { buys: number; sells: number; income: number }>> {
    const investmentFlows = new Map<
      string,
      { buys: number; sells: number; income: number }
    >();
    if (accountIds.length === 0) return investmentFlows;

    const flowRows: {
      account_id: string;
      buys: string;
      sells: string;
      income: string;
    }[] = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT account_id,
                COALESCE(SUM(CASE WHEN action = 'BUY' THEN total_amount * exchange_rate ELSE 0 END), 0) as buys,
                COALESCE(SUM(CASE WHEN action = ANY($3) THEN total_amount * exchange_rate ELSE 0 END), 0) as sells,
                COALESCE(SUM(CASE WHEN action = ANY($4) THEN total_amount * exchange_rate ELSE 0 END), 0) as income
         FROM investment_transactions
         WHERE user_id = $1
           AND account_id = ANY($2)
           AND transaction_date <= CURRENT_DATE
           AND status != 'VOID'
         GROUP BY account_id`,
        [
          userId,
          accountIds,
          // A CD/bond redemption's proceeds are a sale's; the term'd gain
          // distributions are income. Lists come from the shared constants so
          // a future refinement cannot fall out of this aggregate silently.
          [InvestmentAction.SELL, InvestmentAction.REDEEM],
          CASH_INCOME_ACTIONS,
        ],
      ),
    );
    for (const row of flowRows) {
      investmentFlows.set(row.account_id, {
        buys: Number(row.buys),
        sells: Number(row.sells),
        income: Number(row.income),
      });
    }
    return investmentFlows;
  }

  // ---------------------------------------------------------------------------
  // Holdings valuation
  // ---------------------------------------------------------------------------

  /**
   * Historical cost basis per (account, security), rebuilt by walking the
   * transaction history chronologically. Average cost, not FIFO: the whole
   * application values a position at its blended average, and a second model
   * here would disagree with everything it is displayed beside.
   *
   * **Acquisition (BUY, REINVEST).** The basis grows by
   * `(quantity × price + acquisition commission) × exchange rate`. The
   * commission is inside it because it is part of what the shares cost, and
   * inside the conversion because it was charged in the currency of the trade.
   *
   * **Denomination.** `exchangeRate` converts out of the security's currency
   * and into the *settlement* account's -- the funding account when the row
   * names one, otherwise the brokerage's linked cash account, otherwise the
   * brokerage itself. That is the currency the lot reports, and it is **not**
   * necessarily the holding account's. A consumer compares `currencyCode`
   * against the currency it is reporting in; a mismatch is unknown, never a
   * conversion, because today's rate cannot answer a question about a
   * historical purchase.
   *
   * **Partial disposal (SELL, TRANSFER_OUT).** Basis is drawn down at the
   * running average, so selling a third of a position releases a third of its
   * cost and the remainder keeps the same per-share average.
   *
   * **Transfer (TRANSFER_OUT/TRANSFER_IN pair).** Not a disposal and not an
   * acquisition: the destination takes exactly the basis the source released,
   * in the source's currency, together with the share of the acquisition
   * commission already blended into it. A partial transfer therefore splits
   * the basis in the same proportion as the units, and the total across the
   * pair is conserved. The legs are matched on `linkedTransactionId`, which
   * `transferSecurity` writes on both.
   *
   * **Unknown propagates.** The basis is reported unknown -- with a
   * `basisGap` naming which of these it was -- when the history contains an
   * acquisition with no price (`unpriced_acquisition`), a quantity-only row
   * that moved units without a cost (`quantity_only_action`), acquisitions
   * that settled in two different currencies (`mixed_basis_currency`), or a
   * transfer whose source leg is unpriced or outside the accounts being
   * replayed (`transferred_basis_unknown`). Unknown never degrades to zero,
   * and it survives being carried through a transfer.
   *
   * Quantity-only actions (ADD_SHARES/REMOVE_SHARES) move units and carry no
   * price, so they leave the running cost alone and mark the lot's basis
   * **unknown** (`basisKnown: false`). They are not a zero-cost sleeve: the
   * application itself keeps two different answers for what those units cost.
   * `HoldingsService.adjustQuantity` leaves `average_cost` per share untouched,
   * so the stored basis grows with an `ADD_SHARES` and shrinks with a
   * `REMOVE_SHARES`; `computeHoldingsMap`, the full rebuild, holds `totalCost`
   * fixed instead, so the same history gives a different stored basis depending
   * on whether a rebuild has run since. Neither is derivable here, and a
   * position whose cost has two answers has none.
   *
   * SPLIT is not in that class: it scales quantity and preserves total cost,
   * which is what both live paths do, so the per-share average adjusts and the
   * basis stays known.
   *
   * Returns the **quantity as well as the money**, because the two only mean
   * anything together. A basis replayed from an incomplete history is a real
   * number for a smaller position than the one being valued: 50 of 100 shares
   * imported gives a basis for 50, and pairing it with today's 100-share market
   * value reports a gain that is mostly the missing half. A caller pairing this
   * with a current holding must compare the quantities **per (account,
   * security)** and treat a mismatch as unknown. Comparing sums instead lets a
   * surplus of 30 units in one account cancel a shortfall of 30 in another and
   * report both bases as reconciled.
   *
   * @returns Map keyed by `${accountId}:${securityId}` -> the replayed lot,
   *          each carrying the currency its basis is denominated in.
   */
  async calculateCostBasisLotsInAccountCurrency(
    userId: string,
    holdingsAccountIds: string[],
  ): Promise<Map<string, ReplayedLot>> {
    const result = new Map<string, ReplayedLot>();
    if (holdingsAccountIds.length === 0) return result;

    const today = formatDateYMDLocal(new Date());

    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where: {
          userId,
          accountId: In(holdingsAccountIds),
          transactionDate: LessThanOrEqual(today),
          // Rows as effects: a VOID transaction moved no shares and no cost.
          status: NON_VOID_INVESTMENT_STATUS,
        },
        order: { transactionDate: "ASC", createdAt: "ASC" },
      }),
    );

    // No history, no lots, and so nothing to denominate. Returning before the
    // account read keeps the common empty case at one query.
    if (transactions.length === 0) return result;

    // Where each transaction's converted amount actually landed. Resolved for
    // the whole batch up front rather than per row: the funding accounts are
    // an arbitrary set and looking each one up inside the loop would be a
    // query per transaction.
    const basisCurrencyByAccount = await this.settlementCurrencies(
      userId,
      holdingsAccountIds,
      transactions,
    );

    // Both legs of a transfer are written in one transaction, so `created_at`
    // -- a statement timestamp -- is identical on the pair and the SQL order
    // between them is whatever the plan happens to produce. The OUT leg has to
    // be seen first, because it is what tells the IN leg what the shares cost.
    // Only the two legs are reordered: the comparator returns 0 for everything
    // else at the same instant, and `sort` is stable, so nothing else moves.
    const legRank = (action: InvestmentAction): number =>
      action === InvestmentAction.TRANSFER_OUT
        ? -1
        : action === InvestmentAction.TRANSFER_IN
          ? 1
          : 0;
    const ordered = [...transactions].sort((a, b) => {
      if (a.transactionDate !== b.transactionDate) {
        return a.transactionDate < b.transactionDate ? -1 : 1;
      }
      const created = Number(a.createdAt) - Number(b.createdAt);
      if (created !== 0) return created;
      return legRank(a.action) - legRank(b.action);
    });

    /**
     * What each `TRANSFER_OUT` released, for its paired `TRANSFER_IN` to take.
     *
     * Keyed by the OUT leg's id, which the IN leg names in
     * `linkedTransactionId` -- durable pairing the schema already carries, set
     * by `transferSecurity` on both rows.
     */
    const carriedByTransferOut = new Map<
      string,
      { amount: number; currencyCode: string | null; known: boolean }
    >();

    const state = new Map<
      string,
      {
        quantity: number;
        costBasis: number;
        currencyCode: string | null;
        basisGap: ReplayedBasisGap | null;
      }
    >();

    for (const tx of ordered) {
      if (!tx.securityId) continue;

      const key = `${tx.accountId}:${tx.securityId}`;
      let entry = state.get(key);
      if (!entry) {
        entry = {
          quantity: 0,
          costBasis: 0,
          currencyCode: null,
          basisGap: null,
        };
        state.set(key, entry);
      }

      const quantity = Number(tx.quantity) || 0;

      switch (baseInvestmentAction(tx.action)) {
        // A transfer is neither a sale nor a purchase: the same shares change
        // custody and keep whatever they cost. Treated as an acquisition
        // priced at the carried average with `exchangeRate` 1 -- which is what
        // `transferSecurity` writes on the row -- the replay rebuilt the basis
        // out of a per-share figure in the *security's* currency and then
        // labelled it with the destination's. Ten shares bought for PLN 3,000
        // (USD 100 each at 3.00) arrived in a PLN account as a basis of 1,000,
        // turning PLN 1,400 of real gain into 3,400 and PLN 266 of tax into
        // 646, with the quantity reconciling perfectly throughout.
        //
        // So the destination takes the basis the source gave up, which the
        // `TRANSFER_OUT` leg has already worked out at the running average --
        // proportional for a partial transfer, and carrying the share of the
        // acquisition commission that is in that average.
        case InvestmentAction.TRANSFER_IN: {
          const carried = tx.linkedTransactionId
            ? carriedByTransferOut.get(tx.linkedTransactionId)
            : undefined;
          entry.quantity += quantity;
          if (carried === undefined || !carried.known) {
            // The paired leg is out of this replay's scope -- a transfer in
            // from an account the caller did not ask about -- or the source
            // could not price the shares either. Either way this position's
            // cost is not known here, and the destination's own row cannot
            // supply it: its price is a carried average, not a market price,
            // and its rate is 1 regardless of what the money actually did.
            entry.basisGap ??= "transferred_basis_unknown";
            break;
          }
          if (entry.currencyCode === null) {
            entry.currencyCode = carried.currencyCode;
          } else if (entry.currencyCode !== carried.currencyCode) {
            entry.basisGap ??= "mixed_basis_currency";
            break;
          }
          entry.costBasis += carried.amount;
          break;
        }
        case InvestmentAction.BUY:
        case InvestmentAction.REINVEST: {
          // What the acquisition cost, which includes what it cost to
          // acquire. Leaving the commission out understates the basis and so
          // overstates every gain and every tax computed from it -- 20 of
          // commission on a 1,000 purchase is 20 of phantom gain and 3.80 of
          // phantom tax at 19%. The commission is recorded in the same
          // currency as the trade, so it is converted with it.
          //
          // `null` back means the row cannot say what it cost: `price` is
          // nullable, and `Number(null) || 0` folded that into a free purchase
          // -- the units joined the position, nothing joined the basis, and
          // the quantity reconciliation downstream then *passed* because the
          // units did add up. An incomplete import came out as a confident
          // gain and a confident tax bill. A stored `0` is *no price* too,
          // not a free acquisition: before the acquisition guard shipped,
          // `create()` stored `price ?? 0` and the form accepted a blank
          // field, so real databases hold zero-price BUY and REINVEST rows
          // that mean "unknown" -- and no legitimate zero can be stored from
          // here on, because `assertAcquisitionPriced` refuses it.
          const cost = acquisitionCost(tx);
          if (cost === null) {
            entry.quantity += quantity;
            entry.basisGap ??= "unpriced_acquisition";
            break;
          }

          // The currency the converted amount is in, which is the settlement
          // account's and not this holding account's. Acquisitions settled in
          // two different currencies cannot be added together at all, and
          // there is no rate to reconcile them with that would not be
          // answering today's question about a historical cost.
          // The funding account settles in its own currency; a row with no
          // funding account settles wherever the brokerage's cash sits. Same
          // split as `resolveExchangeRate`, which produced the rate being
          // applied here.
          const settledIn = tx.fundingAccountId
            ? basisCurrencyByAccount.own.get(tx.fundingAccountId)
            : basisCurrencyByAccount.brokerage.get(tx.accountId);
          if (settledIn === undefined) {
            entry.quantity += quantity;
            entry.basisGap ??= "mixed_basis_currency";
            break;
          }
          if (entry.currencyCode === null) entry.currencyCode = settledIn;
          else if (entry.currencyCode !== settledIn) {
            entry.basisGap ??= "mixed_basis_currency";
          }

          entry.costBasis += cost;
          entry.quantity += quantity;
          break;
        }
        case InvestmentAction.SELL:
        case InvestmentAction.TRANSFER_OUT: {
          let released = 0;
          let releasedAll = false;
          if (entry.quantity > 0) {
            const avgCostPerShare = entry.costBasis / entry.quantity;
            const sellQty = Math.min(quantity, entry.quantity);
            released = sellQty * avgCostPerShare;
            releasedAll = sellQty >= quantity;
            entry.costBasis -= released;
            entry.quantity -= sellQty;
          }
          if (tx.action === InvestmentAction.TRANSFER_OUT) {
            // What the destination inherits. Recorded even when it is not
            // knowable, so the paired leg can tell "the source gave up an
            // unpriced position" from "the source is not in this replay at
            // all" -- both unknown, but only the first is a fact this replay
            // established.
            //
            // `releasedAll` guards the case where the source's history does
            // not cover the units being moved: drawing down what there is and
            // calling the remainder free would hand the destination a basis
            // for a smaller position than it received, which is the same
            // partial-history error the quantity reconciliation exists to
            // catch, laundered through a transfer.
            carriedByTransferOut.set(tx.id, {
              amount: released,
              currencyCode: entry.currencyCode,
              known:
                entry.basisGap === null &&
                entry.currencyCode !== null &&
                releasedAll,
            });
          }
          break;
        }
        case InvestmentAction.ADD_SHARES:
          entry.quantity += quantity;
          if (quantity !== 0) entry.basisGap = "quantity_only_action";
          break;
        case InvestmentAction.REMOVE_SHARES:
          entry.quantity -= quantity;
          if (quantity !== 0) entry.basisGap = "quantity_only_action";
          break;
        case InvestmentAction.SPLIT:
          entry.quantity = applyActionToQuantity(
            entry.quantity,
            tx.action,
            quantity,
          );
          break;
        // DIVIDEND / INTEREST / CAPITAL_GAIN: cash only, no impact on cost basis
      }

      // Snap near-zero quantities to exactly zero so precision drift doesn't
      // leave a stale residual cost basis on fully-closed positions. A position
      // that closed also clears the gap: whatever the history could not price
      // has been disposed of, and units bought after this point are priced by
      // the rows that buy them.
      if (Math.abs(entry.quantity) < 0.0001) {
        entry.quantity = 0;
        entry.costBasis = 0;
        entry.basisGap = null;
        // The currency goes with the basis it described. A position rebought
        // after closing may well settle somewhere else, and holding the old
        // currency would call that a mixture when it is simply the next
        // position.
        entry.currencyCode = null;
      }
    }

    for (const [key, entry] of state) {
      result.set(key, {
        quantity: entry.quantity,
        costBasis: roundMoney(entry.costBasis),
        currencyCode: entry.currencyCode,
        basisKnown: entry.basisGap === null,
        basisGap: entry.basisGap,
      });
    }

    return result;
  }

  /**
   * Currency each account settles a trade in, for every account the replay can
   * be pointed at -- in the two roles an account can play, because the real
   * resolution treats them differently.
   *
   * A brokerage does not hold the cash: `InvestmentTransactionsService` posts
   * the converted amount to the funding account when the row names one
   * (`accountsService.findOne(fundingAccountId)` -- that account, whatever it
   * is), and otherwise to the brokerage's linked cash account
   * (`findCashAccount`, which redirects). This mirrors that resolution rather
   * than re-deriving it, and the two must be changed together.
   *
   * One map applying the redirect to every account did not mirror it: a funding
   * account that is itself a brokerage with a linked cash account came back as
   * the linked account's currency, while the trade had settled in the funding
   * account's own -- so a basis in the right currency was reported in the wrong
   * one, or a same-currency pair was called mixed and the basis thrown away.
   *
   * A brokerage with no linked cash account settles in its own currency, which
   * is the single-account case and by far the common one, so the two maps agree
   * for almost every account.
   */
  private async settlementCurrencies(
    userId: string,
    holdingsAccountIds: string[],
    transactions: InvestmentTransaction[],
  ): Promise<SettlementCurrencies> {
    const wanted = new Set<string>(holdingsAccountIds);
    for (const tx of transactions) {
      if (tx.fundingAccountId) wanted.add(tx.fundingAccountId);
    }

    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { userId, id: In([...wanted]) },
        select: {
          id: true,
          currencyCode: true,
          accountSubType: true,
          linkedAccountId: true,
        },
      }),
    );
    const byId = new Map(accounts.map((account) => [account.id, account]));

    // A linked cash account is not necessarily one of the above -- it is not a
    // holdings account and need never have funded a row explicitly.
    const linkedIds = accounts
      .map((account) => account.linkedAccountId)
      .filter((id): id is string => Boolean(id) && !byId.has(id as string));
    if (linkedIds.length > 0) {
      const linked = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Account).find({
          where: { userId, id: In(linkedIds) },
          select: { id: true, currencyCode: true },
        }),
      );
      for (const account of linked) byId.set(account.id, account);
    }

    const own = new Map<string, string>();
    const brokerage = new Map<string, string>();
    for (const account of byId.values()) {
      if (account.currencyCode) own.set(account.id, account.currencyCode);
      const linked =
        account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
        account.linkedAccountId
          ? byId.get(account.linkedAccountId)
          : undefined;
      const currency = (linked ?? account).currencyCode;
      if (currency) brokerage.set(account.id, currency);
    }
    return { own, brokerage };
  }

  /**
   * Replayed bases that a caller may state as a figure in the account's own
   * currency, keyed the same way as the lots.
   *
   * There used to be a projection here that returned `lot.costBasis` and
   * nothing else. It threw away the two fields that say whether the number
   * means anything -- `basisKnown` and `currencyCode` -- and its caller then
   * treated whatever came back as a cost in the *account's* currency. A PLN
   * brokerage funded from EUR contributed a EUR figure to a PLN total, and a
   * position the history could not price contributed a confident partial sum.
   * A number with its qualifications stripped off is not a smaller answer, it
   * is a different one.
   *
   * So the filtering happens here rather than at the call site: an entry is
   * present only when the replay knows the basis, denominated it in the currency
   * asked for, *and* replayed the same number of units the holding actually has.
   * Everything else is absent, and a caller that finds nothing falls back to
   * whatever it does when there is no history at all. Converting the mismatch
   * instead would need today's rate to answer a question about a historical
   * purchase.
   *
   * The quantity comparison is the rule
   * `calculateCostBasisLotsInAccountCurrency` states for every caller, applied
   * here so the claim and its one call site agree. A basis replayed from an
   * incomplete history is a real cost for a smaller position: 50 of 100 shares
   * imported gives a basis for 50, and setting that against a 100-share market
   * value reports a gain that is mostly the missing half. Per (account,
   * security), never on sums -- a surplus of 30 units in one account would
   * otherwise cancel a shortfall of 30 in another and both would pass.
   */
  private async knownCostBasesIn(
    userId: string,
    holdingsAccountIds: string[],
    currencyByAccount: Map<string, string>,
    /** Units actually held, keyed `${accountId}:${securityId}`. */
    quantityByKey: Map<string, number>,
  ): Promise<Map<string, number>> {
    const lots = await this.calculateCostBasisLotsInAccountCurrency(
      userId,
      holdingsAccountIds,
    );
    const usable = new Map<string, number>();
    for (const [key, lot] of lots) {
      if (!lot.basisKnown || lot.currencyCode === null) continue;
      const accountId = key.slice(0, key.indexOf(":"));
      if (currencyByAccount.get(accountId) !== lot.currencyCode) continue;
      const held = quantityByKey.get(key);
      if (
        held === undefined ||
        Math.abs(held - lot.quantity) > COST_BASIS_QUANTITY_TOLERANCE
      ) {
        continue;
      }
      usable.set(key, lot.costBasis);
    }
    return usable;
  }

  /**
   * Replay the user's investment transaction history to compute the realized
   * gain or loss of each SELL transaction using the average-cost method.
   *
   * For every prior BUY/REINVEST/TRANSFER_IN, the running cost basis for that
   * (account, security) grows by `quantity * price * exchangeRate`. A SELL
   * then draws down cost basis proportionally at the running average cost per
   * share, and the realized gain is `proceeds - costBasis` — all in the
   * holding account's currency.
   *
   * This is **not** the same bookkeeping as
   * `calculateCostBasisLotsInAccountCurrency`, which the comment here used to
   * claim: that replay adds the acquisition commission to the basis and
   * reports whether the basis is knowable at all. Reconciling the two is a
   * change to what every realized-gain figure in the application reports, so
   * it is its own change and not a footnote to this one.
   *
   * The entire history is replayed regardless of the requested date range so
   * SELLs early in the range still see cost basis built up by prior BUYs; only
   * the returned rows are filtered to the requested window.
   */
  async calculateRealizedGains(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
    } = {},
  ): Promise<RealizedGainEntry[]> {
    const { accountIds, startDate, endDate } = opts;

    const where: FindOptionsWhere<InvestmentTransaction> = { userId };
    if (accountIds && accountIds.length > 0) {
      where.accountId = In(accountIds);
    }
    if (endDate) {
      where.transactionDate = LessThanOrEqual(endDate);
    }

    // Rows as effects: a VOID transaction moved no shares and no cost.
    where.status = NON_VOID_INVESTMENT_STATUS;

    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where,
        relations: ["security", "account"],
        order: { transactionDate: "ASC", createdAt: "ASC" },
      }),
    );

    const state = new Map<string, { quantity: number; costBasis: number }>();
    const results: RealizedGainEntry[] = [];

    for (const tx of transactions) {
      if (!tx.securityId) continue;

      const key = `${tx.accountId}:${tx.securityId}`;
      let entry = state.get(key);
      if (!entry) {
        entry = { quantity: 0, costBasis: 0 };
        state.set(key, entry);
      }

      const quantity = Number(tx.quantity) || 0;
      const price = Number(tx.price) || 0;
      const exchangeRate = Number(tx.exchangeRate) || 1;

      switch (baseInvestmentAction(tx.action)) {
        case InvestmentAction.BUY:
        case InvestmentAction.REINVEST:
        case InvestmentAction.TRANSFER_IN: {
          // Acquisition commission belongs in the basis a later disposal is
          // measured against; omitting it reported the commission as gain and
          // taxed it. Shared with every other replay so the realized-gain
          // report and the holdings page cannot disagree about the same buy.
          const cost = acquisitionCost(tx);
          if (cost !== null) entry.costBasis += cost;
          entry.quantity = applyActionToQuantity(
            entry.quantity,
            tx.action,
            quantity,
          );
          break;
        }
        case InvestmentAction.SELL:
        case InvestmentAction.TRANSFER_OUT: {
          const sellQty = Math.min(quantity, entry.quantity);
          const avgCostPerShare =
            entry.quantity > 0 ? entry.costBasis / entry.quantity : 0;
          const costBasisSold = sellQty * avgCostPerShare;
          entry.costBasis -= costBasisSold;
          entry.quantity -= sellQty;

          // Base-normalized so a REDEEM's proceeds are realized like the sale
          // it is; a TRANSFER_OUT still realizes nothing.
          if (baseInvestmentAction(tx.action) === InvestmentAction.SELL) {
            // totalAmount is already stored in the security's currency and is
            // net of commission; multiply by exchangeRate to put both sides of
            // the gain calculation in the holding account's currency.
            const proceeds = Number(tx.totalAmount) * exchangeRate;
            const realizedGain = proceeds - costBasisSold;

            if (!startDate || tx.transactionDate >= startDate) {
              results.push({
                transactionId: tx.id,
                transactionDate: tx.transactionDate,
                accountId: tx.accountId,
                accountName: tx.account?.name ?? null,
                accountCurrencyCode: tx.account?.currencyCode ?? null,
                securityId: tx.securityId,
                symbol: tx.security?.symbol ?? null,
                securityName: tx.security?.name ?? null,
                securityCurrencyCode: tx.security?.currencyCode ?? null,
                quantity: Math.abs(quantity),
                price,
                commission: Number(tx.commission) || 0,
                proceeds: roundMoney(proceeds),
                costBasis: roundMoney(costBasisSold),
                realizedGain: roundMoney(realizedGain),
              });
            }
          }
          break;
        }
        default:
          entry.quantity = applyActionToQuantity(
            entry.quantity,
            tx.action,
            quantity,
          );
          break;
      }

      if (Math.abs(entry.quantity) < 0.0001) {
        entry.quantity = 0;
        entry.costBasis = 0;
      }
    }

    return results;
  }

  /**
   * Compute realized + unrealized capital gains per (account, security, month)
   * across the requested window. Replays the user's full investment history
   * to derive cost basis and quantities, then snapshots the position at each
   * month boundary using historical close prices to capture mark-to-market
   * changes alongside any realized gains from SELLs in the month.
   *
   * Quantities are snapshotted at each month boundary; market values use the
   * last available close on or before the snapshot date converted to the
   * holding account's currency at the latest exchange rate. BUYs/SELLs use
   * their stored historical exchange rate (matching `calculateRealizedGains`).
   * Months with no holding and no activity are omitted from the result.
   */
  async calculateCapitalGainsByMonth(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
  ): Promise<CapitalGainEntry[]> {
    const { startDate, endDate } = opts;
    if (!startDate || !endDate || startDate > endDate) return [];
    const periods = enumerateMonths(startDate, endDate);
    if (periods.length === 0) return [];
    return this.calculateCapitalGainsForPeriods(userId, opts, periods);
  }

  /**
   * Compute realized + unrealized capital gains per (account, security, day)
   * across the requested window. Identical to calculateCapitalGainsByMonth but
   * snapshotted at daily rather than monthly boundaries. The `month` field on
   * each returned CapitalGainEntry holds a YYYY-MM-DD key for the day.
   */
  async calculateCapitalGainsByDay(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
  ): Promise<CapitalGainEntry[]> {
    const { startDate, endDate } = opts;
    if (!startDate || !endDate || startDate > endDate) return [];
    const periods = enumerateDays(startDate, endDate);
    if (periods.length === 0) return [];
    return this.calculateCapitalGainsForPeriods(userId, opts, periods);
  }

  /**
   * Core capital-gains replay loop shared by calculateCapitalGainsByMonth and
   * calculateCapitalGainsByDay. Replays transaction history and snapshots the
   * position at the boundary of each PeriodBucket. The `month` field on each
   * returned entry is set to the bucket's `key` (YYYY-MM for months, YYYY-MM-DD
   * for days).
   */
  private async calculateCapitalGainsForPeriods(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
    periods: PeriodBucket[],
  ): Promise<CapitalGainEntry[]> {
    const { accountIds, endDate } = opts;

    const where: FindOptionsWhere<InvestmentTransaction> = { userId };
    if (accountIds && accountIds.length > 0) {
      where.accountId = In(accountIds);
    }
    where.transactionDate = LessThanOrEqual(endDate);

    // Rows as effects: a VOID transaction moved no shares and no cost.
    where.status = NON_VOID_INVESTMENT_STATUS;

    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where,
        relations: ["security", "account"],
        order: { transactionDate: "ASC", createdAt: "ASC" },
      }),
    );

    if (transactions.length === 0) return [];

    const securityIds = [
      ...new Set(
        transactions.filter((t) => t.securityId).map((t) => t.securityId!),
      ),
    ];
    const allPrices = await this.getAllPricesForSecurities(securityIds);

    // Group transactions by (account, security)
    type GroupKey = string;
    const groups = new Map<
      GroupKey,
      {
        accountId: string;
        accountName: string | null;
        accountCurrencyCode: string | null;
        securityId: string;
        symbol: string | null;
        securityName: string | null;
        securityCurrencyCode: string | null;
        txs: InvestmentTransaction[];
      }
    >();
    for (const tx of transactions) {
      if (!tx.securityId) continue;
      const groupKey = `${tx.accountId}:${tx.securityId}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          accountId: tx.accountId,
          accountName: tx.account?.name ?? null,
          accountCurrencyCode: tx.account?.currencyCode ?? null,
          securityId: tx.securityId,
          symbol: tx.security?.symbol ?? null,
          securityName: tx.security?.name ?? null,
          securityCurrencyCode: tx.security?.currencyCode ?? null,
          txs: [],
        };
        groups.set(groupKey, group);
      }
      group.txs.push(tx);
    }

    // Cache FX rates: securityCurrency -> accountCurrency
    const fxCache = new Map<string, number>();
    // `null` when the pair has no rate. This used to end `: 1`, valuing a
    // foreign security's period start and end as though its currency were the
    // account's (audit P5-009). Rate 1 only when the codes are equal.
    const fxRate = async (
      from: string | null,
      to: string | null,
    ): Promise<number | null> => {
      if (!from || !to || from === to) return 1;
      const cacheKey = `${from}->${to}`;
      const cached = fxCache.get(cacheKey);
      if (cached !== undefined) return cached;
      let rate = await this.exchangeRateService.getLatestRate(from, to);
      if (rate === null || rate <= 0) {
        const reverse = await this.exchangeRateService.getLatestRate(to, from);
        if (reverse === null || reverse <= 0) return null;
        rate = 1 / reverse;
      }
      fxCache.set(cacheKey, rate);
      return rate;
    };

    const results: CapitalGainEntry[] = [];

    for (const group of groups.values()) {
      const txs = group.txs;
      const state = { quantity: 0, costBasis: 0, basisKnown: true };
      let txIdx = 0;
      const securityToAccountFx = await fxRate(
        group.securityCurrencyCode,
        group.accountCurrencyCode,
      );

      // Replay any transactions strictly before the first period to seed state.
      while (
        txIdx < txs.length &&
        txs[txIdx].transactionDate < periods[0].periodStart
      ) {
        applyTxToState(txs[txIdx], state);
        txIdx++;
      }

      for (const { key: periodKey, periodEnd, priceLookupStart } of periods) {
        const startQuantity = state.quantity;
        const startPrice =
          this.lookupPrice(group.securityId, priceLookupStart, allPrices) ?? 0;
        // A period whose security currency cannot be converted into the
        // account's has no knowable start or end value; the rate is 1 only when
        // the two currencies are the same.
        const startValue =
          securityToAccountFx === null
            ? null
            : startQuantity * startPrice * securityToAccountFx;

        let buys = 0;
        let sells = 0;
        let realizedGain = 0;
        // The period's `buys` (and so its total gain) is complete only when
        // every acquisition this period could state its cost; its realized
        // gain only when no disposal drew on a basis with an unknown lot in
        // it. `?? 0` here replayed an unpriced BUY as free and reported the
        // full proceeds of the eventual sale as confident gain -- while
        // getCostBasis marks the identical row `unpriced_acquisition`.
        let buysComplete = true;
        let realizedKnown = true;

        while (txIdx < txs.length && txs[txIdx].transactionDate <= periodEnd) {
          const tx = txs[txIdx];
          const quantity = Number(tx.quantity) || 0;
          const exchangeRate = Number(tx.exchangeRate) || 1;

          switch (baseInvestmentAction(tx.action)) {
            case InvestmentAction.BUY:
            case InvestmentAction.REINVEST:
            case InvestmentAction.TRANSFER_IN: {
              // Commission included: it is money the period spent acquiring,
              // so leaving it out of `buys` also inflated the period's
              // capital gain by the same amount it understated the basis.
              const cost = acquisitionCost(tx);
              if (cost === null) {
                buysComplete = false;
                state.basisKnown = false;
              } else {
                buys += cost;
                state.costBasis += cost;
              }
              state.quantity = applyActionToQuantity(
                state.quantity,
                tx.action,
                quantity,
              );
              break;
            }
            case InvestmentAction.SELL:
            case InvestmentAction.TRANSFER_OUT: {
              const sellQty = Math.min(quantity, state.quantity);
              const avgCostPerShare =
                state.quantity > 0 ? state.costBasis / state.quantity : 0;
              const costBasisSold = sellQty * avgCostPerShare;
              state.costBasis -= costBasisSold;
              state.quantity -= sellQty;
              if (baseInvestmentAction(tx.action) === InvestmentAction.SELL) {
                const proceeds = Number(tx.totalAmount) * exchangeRate;
                sells += proceeds;
                realizedGain += proceeds - costBasisSold;
                // A basis carrying an unknown lot cannot price what was sold.
                if (!state.basisKnown) realizedKnown = false;
              }
              break;
            }
            default:
              state.quantity = applyActionToQuantity(
                state.quantity,
                tx.action,
                quantity,
              );
              break;
          }

          if (Math.abs(state.quantity) < 0.0001) {
            state.quantity = 0;
            state.costBasis = 0;
            state.basisKnown = true;
          }
          txIdx++;
        }

        const endQuantity = state.quantity;
        const endPrice =
          this.lookupPrice(group.securityId, periodEnd, allPrices) ?? 0;
        const endValue =
          securityToAccountFx === null
            ? null
            : endQuantity * endPrice * securityToAccountFx;

        // Unknown boundary values -- or an incomplete `buys` -- make the
        // capital gain unknown rather than equal to the known cash movements.
        const totalCapitalGain =
          startValue === null || endValue === null || !buysComplete
            ? null
            : endValue - startValue + sells - buys;
        const periodRealizedGain = realizedKnown ? realizedGain : null;
        const unrealizedGain =
          totalCapitalGain === null || periodRealizedGain === null
            ? null
            : totalCapitalGain - periodRealizedGain;

        const hasActivity =
          buys !== 0 ||
          sells !== 0 ||
          realizedGain !== 0 ||
          !buysComplete ||
          !realizedKnown ||
          startQuantity !== 0 ||
          endQuantity !== 0;
        if (!hasActivity) continue;

        // Suppress vanishingly small float drift to keep the chart clean.
        const round = (n: number) => (Math.abs(n) < 0.005 ? 0 : roundMoney(n));
        const roundOrNull = (n: number | null) =>
          n === null ? null : round(n);

        results.push({
          month: periodKey,
          accountId: group.accountId,
          accountName: group.accountName,
          accountCurrencyCode: group.accountCurrencyCode,
          securityId: group.securityId,
          symbol: group.symbol,
          securityName: group.securityName,
          securityCurrencyCode: group.securityCurrencyCode,
          startQuantity,
          endQuantity,
          startValue: roundOrNull(startValue),
          endValue: roundOrNull(endValue),
          buys: round(buys),
          sells: round(sells),
          realizedGain: roundOrNull(periodRealizedGain),
          unrealizedGain: roundOrNull(unrealizedGain),
          totalCapitalGain: roundOrNull(totalCapitalGain),
        });
      }
    }

    return results;
  }

  /**
   * Fetch holdings for the given account IDs, compute per-holding market value,
   * gain/loss, and accumulate totals (converted to defaultCurrency).
   *
   * Each holding is also annotated with `costBasisAccountCurrency`, the
   * historical cost basis in the holding account's currency derived from the
   * exchange rates stored on the original BUY transactions. Holdings that lack
   * matching transaction history (e.g. imported positions) fall back to
   * converting the current security-currency cost basis with the latest rate.
   *
   * @param getLatestPrices - callback to fetch latest prices by security IDs
   * Returns the enriched holdings array plus the converted totals.
   */
  async calculateHoldingsWithValues(
    userId: string,
    holdingsAccountIds: string[],
    defaultCurrency: string,
    rateCache: FxRateCache,
    getLatestPrices: (securityIds: string[]) => Promise<Map<string, number>>,
  ): Promise<{
    holdings: Holding[];
    holdingsWithValues: HoldingWithMarketValue[];
    totalCostBasis: number;
    totalHoldingsValue: number;
    /**
     * False when a holding could not be converted into the reporting currency,
     * which makes the two totals above subtotals of what did convert. A missing
     * rate used to be applied as 1:1 (audit P5-009); see
     * docs/specs/fx-conversion-completeness.md.
     */
    fxComplete: boolean;
    missingRatePairs: string[];
    /**
     * False when a held position has no current price.
     *
     * A separate dimension from `fxComplete`, and it was missing entirely: an
     * unpriced holding was skipped out of `holdingsValueTotal` without recording a
     * gap, so a portfolio holding 10 priced shares and 5 unpriced ones reported a
     * confident `totalHoldingsValue` of the priced 100 with `fxComplete: true` --
     * a subtotal under a total's name, which section 1 of the financial
     * calculation contract exists to forbid (recheck RR3-004). Unknown is not
     * absent and not zero.
     */
    pricesComplete: boolean;
    /** Securities held in a non-zero quantity with no current price. */
    unpricedSecurityIds: string[];
  }> {
    let holdings: Holding[] = [];
    if (holdingsAccountIds.length > 0) {
      holdings = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Holding).find({
          where: { accountId: In(holdingsAccountIds) },
          relations: ["security", "account"],
        }),
      );
    }

    // Get latest prices for all securities in holdings
    const securityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await getLatestPrices(securityIds);

    // Historical cost basis, but only where the replay both knows it and
    // states it in the currency the holding's account keeps its books in.
    // Anything else falls through to the stored average cost below, the same
    // way a holding with no transaction history does.
    const currencyByAccount = new Map(
      holdings
        .filter((h) => h.account?.currencyCode)
        .map((h) => [h.accountId, h.account.currencyCode] as const),
    );
    const historicalCostBasis = await this.knownCostBasesIn(
      userId,
      holdingsAccountIds,
      currencyByAccount,
      new Map(
        holdings.map(
          (h) =>
            [`${h.accountId}:${h.securityId}`, Number(h.quantity)] as const,
        ),
      ),
    );

    const costBasisTotal = new FxAggregate();
    const holdingsValueTotal = new FxAggregate();
    const unpricedSecurityIds = new Set<string>();
    const holdingsWithValues: HoldingWithMarketValue[] = [];

    for (const h of holdings) {
      if (Math.abs(Number(h.quantity)) < 0.0001) continue;

      const quantity = Number(h.quantity);
      const averageCost = Number(h.averageCost || 0);
      const costBasis = quantity * averageCost;
      const currentPrice = priceMap.get(h.securityId) ?? null;
      const marketValue =
        currentPrice !== null ? quantity * currentPrice : null;
      const gainLoss = marketValue !== null ? marketValue - costBasis : null;
      const gainLossPercent =
        gainLoss !== null && costBasis > 0
          ? (gainLoss / costBasis) * 100
          : null;

      const holdingCurrency = h.security.currencyCode;
      const accountCurrency = h.account?.currencyCode ?? holdingCurrency;

      // Prefer the historical cost basis derived from transaction exchange
      // rates; fall back to current-rate conversion when no *usable* one is
      // available -- no transaction history (e.g. holdings imported without
      // it), a history the replay could not price, or a basis denominated in
      // some other account's currency. The stored average cost is the
      // application's other answer for those, and it is at least an answer
      // about this holding in this currency.
      const historicalKey = `${h.accountId}:${h.securityId}`;
      // `null` when the holding's basis currency has no rate into the account
      // currency: unknown, not "the same number". The row carries the null so a
      // consumer sees an unavailable basis instead of an unconverted one.
      let costBasisAccountCurrency: number | null | undefined =
        historicalCostBasis.get(historicalKey);
      if (costBasisAccountCurrency === undefined) {
        costBasisAccountCurrency = await this.convertToDefault(
          costBasis,
          holdingCurrency,
          accountCurrency,
          rateCache,
        );
      }

      if (costBasisAccountCurrency === null) {
        // The conversion that failed is holding -> account; record that pair.
        // Filing it under account -> default named a hop that was never
        // attempted -- possibly a pair with a perfectly good rate, or the
        // degenerate `JPY->JPY` -- so the report told the user to fix a rate
        // that was not missing while never naming the one that was.
        costBasisTotal.add(null, holdingCurrency, accountCurrency);
      } else {
        costBasisTotal.add(
          await this.convertToDefault(
            costBasisAccountCurrency,
            accountCurrency,
            defaultCurrency,
            rateCache,
          ),
          accountCurrency,
          defaultCurrency,
        );
      }
      if (marketValue !== null) {
        holdingsValueTotal.add(
          await this.convertToDefault(
            marketValue,
            holdingCurrency,
            defaultCurrency,
            rateCache,
          ),
          holdingCurrency,
          defaultCurrency,
        );
      } else {
        // The position is held and its value is unknown. Recorded rather than
        // silently dropped, so the total can say it is a subtotal.
        unpricedSecurityIds.add(h.securityId);
      }

      holdingsWithValues.push({
        id: h.id,
        accountId: h.accountId,
        securityId: h.securityId,
        symbol: h.security.symbol,
        name: h.security.name,
        securityType: h.security.securityType || "STOCK",
        currencyCode: holdingCurrency,
        quantity,
        averageCost,
        costBasis,
        costBasisAccountCurrency,
        currentPrice,
        marketValue,
        gainLoss,
        gainLossPercent,
      });
    }

    const missingRatePairs = [
      ...new Set([
        ...costBasisTotal.missingPairs,
        ...holdingsValueTotal.missingPairs,
      ]),
    ].sort();
    if (missingRatePairs.length > 0) {
      this.logger.warn(
        `Portfolio totals omit holdings with no exchange rate (${missingRatePairs.join(", ")}); the returned totals are subtotals`,
      );
    }
    if (unpricedSecurityIds.size > 0) {
      this.logger.warn(
        `Portfolio totals omit ${unpricedSecurityIds.size} held position(s) with no current price; the returned totals are subtotals`,
      );
    }

    return {
      holdings,
      holdingsWithValues,
      totalCostBasis: costBasisTotal.knownSubtotal,
      totalHoldingsValue: holdingsValueTotal.knownSubtotal,
      fxComplete: missingRatePairs.length === 0,
      missingRatePairs,
      pricesComplete: unpricedSecurityIds.size === 0,
      unpricedSecurityIds: [...unpricedSecurityIds].sort(),
    };
  }

  // ---------------------------------------------------------------------------
  // Account grouping
  // ---------------------------------------------------------------------------

  /**
   * Sort holdings by market value descending (nulls last).
   */
  private sortHoldings(
    items: HoldingWithMarketValue[],
  ): HoldingWithMarketValue[] {
    return items.sort((a, b) => {
      if (a.marketValue === null && b.marketValue === null) return 0;
      if (a.marketValue === null) return 1;
      if (b.marketValue === null) return -1;
      return b.marketValue - a.marketValue;
    });
  }

  /**
   * Group enriched holdings by account, attaching cash balances and net-invested
   * figures. Returns an array of AccountHoldings sorted by total market value.
   */
  /**
   * Cost basis, market value and gain for one account, in that account's own
   * currency, with the completeness of each component.
   *
   * Written once and called from both the brokerage and standalone loops: the two
   * had the identical fold with a different currency variable, and the account-level
   * completeness fix would otherwise have gone into one of them (recheck RR3-005,
   * and the repo's rule that a predicate deciding which row counts is written once).
   *
   * The gaps are returned rather than only logged. The top-level totals convert each
   * security straight into the user's default currency, which is a *different*
   * conversion path -- so a portfolio can be complete at the top while a JPY
   * account's own total is missing EUR->JPY entirely, and a consumer reading the
   * nested figure has no way to know from the global flag.
   */
  private async accountTotals(
    accountHoldings: HoldingWithMarketValue[],
    accountCurrency: string,
    rateCache: FxRateCache,
  ): Promise<{
    totalCostBasis: number;
    totalMarketValue: number;
    totalGainLoss: number;
    totalGainLossPercent: number;
    fxComplete: boolean;
    missingRatePairs: string[];
    pricesComplete: boolean;
    unpricedSecurityIds: string[];
    unpricedHoldingsCount: number;
    valuationComplete: boolean;
  }> {
    const costBasisAgg = new FxAggregate();
    const marketValueAgg = new FxAggregate();
    const unpriced = new Set<string>();
    let unpricedHoldingsCount = 0;

    for (const h of accountHoldings) {
      // A holding whose basis could not be denominated in this account's currency
      // is recorded as a gap, not added as though it already were.
      costBasisAgg.add(
        h.costBasisAccountCurrency,
        h.currencyCode,
        accountCurrency,
      );
      // An unpriced holding is unknown, not zero: `?? 0` folded it in as free and
      // the account total then read like a complete valuation of a position nobody
      // could value.
      if (h.marketValue === null) {
        unpriced.add(h.securityId);
        unpricedHoldingsCount += 1;
        continue;
      }
      marketValueAgg.add(
        await this.convertToDefault(
          h.marketValue,
          h.currencyCode,
          accountCurrency,
          rateCache,
        ),
        h.currencyCode,
        accountCurrency,
      );
    }

    const missingRatePairs = [
      ...new Set([
        ...costBasisAgg.missingPairs,
        ...marketValueAgg.missingPairs,
      ]),
    ].sort();
    if (missingRatePairs.length > 0) {
      this.logger.warn(
        `Account totals omit holdings with no exchange rate (${missingRatePairs.join(", ")}); the returned totals and gain are subtotals`,
      );
    }

    const totalCostBasis = costBasisAgg.knownSubtotal;
    const totalMarketValue = marketValueAgg.knownSubtotal;
    const totalGainLoss = totalMarketValue - totalCostBasis;

    return {
      totalCostBasis,
      totalMarketValue,
      totalGainLoss,
      totalGainLossPercent:
        totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0,
      fxComplete: missingRatePairs.length === 0,
      missingRatePairs,
      pricesComplete: unpriced.size === 0,
      unpricedSecurityIds: [...unpriced].sort(),
      unpricedHoldingsCount,
      valuationComplete: missingRatePairs.length === 0 && unpriced.size === 0,
    };
  }

  async buildHoldingsByAccount(
    categorised: CategorisedAccounts,
    holdingsWithValues: HoldingWithMarketValue[],
    effectiveBalances: Map<string, number>,
    investmentFlows: Map<
      string,
      { buys: number; sells: number; income: number }
    >,
    rateCache: FxRateCache,
  ): Promise<AccountHoldings[]> {
    // Group holdings by account
    const holdingsByAccountMap = new Map<string, HoldingWithMarketValue[]>();
    for (const holding of holdingsWithValues) {
      const existing = holdingsByAccountMap.get(holding.accountId) || [];
      existing.push(holding);
      holdingsByAccountMap.set(holding.accountId, existing);
    }

    const holdingsByAccount: AccountHoldings[] = [];

    // Process brokerage accounts (paired with cash accounts)
    for (const brokerageAccount of categorised.brokerageAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(brokerageAccount.id) || [];

      // Find the linked cash account
      const linkedCashAccount = categorised.cashAccounts.find(
        (c) =>
          c.linkedAccountId === brokerageAccount.id ||
          brokerageAccount.linkedAccountId === c.id,
      );

      // Calculate account totals. Cost basis uses the historical (stored)
      // exchange rate from each originating transaction, while market value
      // uses the current exchange rate so unrealised gains reflect today's
      // valuation vs. the price actually paid when shares were bought.
      const acctTotals = await this.accountTotals(
        accountHoldings,
        brokerageAccount.currencyCode,
        rateCache,
      );

      // Get display name (remove the localized " - Brokerage" suffix if present)
      const accountName = stripBrokerageSuffix(brokerageAccount.name);

      const cashBalance = linkedCashAccount
        ? (effectiveBalances.get(linkedCashAccount.id) ??
          Number(linkedCashAccount.currentBalance))
        : 0;
      const flows = investmentFlows.get(brokerageAccount.id) ?? {
        buys: 0,
        sells: 0,
        income: 0,
      };
      const accountNetInvested =
        cashBalance + flows.buys - flows.sells - flows.income;

      holdingsByAccount.push({
        accountId: brokerageAccount.id,
        accountName,
        currencyCode: brokerageAccount.currencyCode,
        cashAccountId: linkedCashAccount?.id ?? null,
        cashBalance,
        holdings: this.sortHoldings(accountHoldings),
        totalCostBasis: acctTotals.totalCostBasis,
        totalMarketValue: acctTotals.totalMarketValue,
        unpricedHoldingsCount: acctTotals.unpricedHoldingsCount,
        totalGainLoss: acctTotals.totalGainLoss,
        totalGainLossPercent: acctTotals.totalGainLossPercent,
        fxComplete: acctTotals.fxComplete,
        missingRatePairs: acctTotals.missingRatePairs,
        pricesComplete: acctTotals.pricesComplete,
        unpricedSecurityIds: acctTotals.unpricedSecurityIds,
        valuationComplete: acctTotals.valuationComplete,
        netInvested: roundMoney(accountNetInvested),
      });
    }

    // Process standalone investment accounts (not paired, cash balance is on the same account)
    for (const standaloneAccount of categorised.standaloneAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(standaloneAccount.id) || [];

      // Calculate account totals — historical cost basis + current-rate
      // market value, same treatment as brokerage accounts above.
      const acctTotals = await this.accountTotals(
        accountHoldings,
        standaloneAccount.currencyCode,
        rateCache,
      );

      const standaloneCashBalance =
        effectiveBalances.get(standaloneAccount.id) ??
        Number(standaloneAccount.currentBalance);
      const standaloneFlows = investmentFlows.get(standaloneAccount.id) ?? {
        buys: 0,
        sells: 0,
        income: 0,
      };
      const standaloneNetInvested =
        standaloneCashBalance +
        standaloneFlows.buys -
        standaloneFlows.sells -
        standaloneFlows.income;

      holdingsByAccount.push({
        accountId: standaloneAccount.id,
        accountName: standaloneAccount.name,
        currencyCode: standaloneAccount.currencyCode,
        cashAccountId: standaloneAccount.id, // Cash is on this same account
        cashBalance: standaloneCashBalance,
        holdings: this.sortHoldings(accountHoldings),
        totalCostBasis: acctTotals.totalCostBasis,
        totalMarketValue: acctTotals.totalMarketValue,
        unpricedHoldingsCount: acctTotals.unpricedHoldingsCount,
        totalGainLoss: acctTotals.totalGainLoss,
        totalGainLossPercent: acctTotals.totalGainLossPercent,
        fxComplete: acctTotals.fxComplete,
        missingRatePairs: acctTotals.missingRatePairs,
        pricesComplete: acctTotals.pricesComplete,
        unpricedSecurityIds: acctTotals.unpricedSecurityIds,
        valuationComplete: acctTotals.valuationComplete,
        netInvested: roundMoney(standaloneNetInvested),
      });
    }

    // Sort accounts by total market value descending
    holdingsByAccount.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

    return holdingsByAccount;
  }

  // ---------------------------------------------------------------------------
  // Allocation
  // ---------------------------------------------------------------------------

  /**
   * Build the portfolio allocation breakdown from sorted holdings and cash.
   */
  async buildAllocation(
    sortedHoldings: HoldingWithMarketValue[],
    holdings: Holding[],
    totalCashValue: number,
    defaultCurrency: string,
    rateCache: FxRateCache,
  ): Promise<AllocationItem[]> {
    const allocation: AllocationItem[] = [];
    const colors = [
      "#3b82f6",
      "#22c55e",
      "#f97316",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#eab308",
      "#ef4444",
    ];

    // Consolidate holdings by security so the same security held across
    // multiple accounts appears as a single allocation slice.
    const consolidated = new Map<
      string,
      {
        name: string;
        symbol: string;
        currencyCode: string;
        value: number;
      }
    >();

    for (const holding of sortedHoldings) {
      if (holding.marketValue === null || holding.marketValue <= 0) continue;
      const originalHolding = holdings.find((h) => h.id === holding.id);
      const holdingCurrency =
        originalHolding?.security?.currencyCode || defaultCurrency;
      const convertedValue = await this.convertToDefault(
        holding.marketValue,
        holdingCurrency,
        defaultCurrency,
        rateCache,
      );
      // A holding with no rate into the reporting currency cannot be ranked
      // against the others; omitting it is honest, entering it at 1:1 would put
      // it in the wrong place in the list.
      if (convertedValue === null) continue;
      const existing = consolidated.get(holding.securityId);
      if (existing) {
        existing.value += convertedValue;
      } else {
        consolidated.set(holding.securityId, {
          name: holding.name,
          symbol: holding.symbol,
          currencyCode: holdingCurrency,
          value: convertedValue,
        });
      }
    }

    const consolidatedItems = [...consolidated.values()].sort(
      (a, b) => b.value - a.value,
    );

    // Percentages are measured against the sum of the slices actually drawn
    // (positive security values plus positive cash), not the net portfolio
    // value. Using the net value would let a negative cash balance (margin /
    // loan) or a short position shrink the denominator and inflate every
    // slice past 100%; the drawn total always reconciles to ~100%.
    const positiveCash = totalCashValue > 0 ? totalCashValue : 0;
    const drawnTotal =
      consolidatedItems.reduce((sum, item) => sum + item.value, 0) +
      positiveCash;
    const pct = (value: number) =>
      drawnTotal > 0 ? (value / drawnTotal) * 100 : 0;

    if (totalCashValue > 0) {
      allocation.push({
        name: "Cash",
        symbol: null,
        type: "cash",
        value: totalCashValue,
        percentage: pct(totalCashValue),
        color: "#6b7280",
        currencyCode: defaultCurrency,
      });
    }

    let colorIndex = 0;
    for (const item of consolidatedItems) {
      allocation.push({
        name: item.name,
        symbol: item.symbol,
        type: "security",
        value: item.value,
        percentage: pct(item.value),
        color: colors[colorIndex % colors.length],
        currencyCode: item.currencyCode,
      });
      colorIndex++;
    }

    allocation.sort((a, b) => b.value - a.value);
    return allocation;
  }

  /**
   * Build a portfolio "exposure by tag" breakdown from the already-consolidated
   * per-security allocation (values in the default currency) and a per-symbol
   * tag map.
   *
   * Multi-tag handling is option A (overlapping exposure): a security's full
   * value counts once under EACH of its tags, so a holding tagged both "AI" and
   * "All-World" contributes its whole value to both slices. Percentages are of
   * the total portfolio value and can therefore sum to more than 100% -- this is
   * an exposure view, not a strict partition. (Partitioning a multi-tagged
   * holding's value, or charting one tag dimension at a time, are deliberately
   * left as open follow-ups.)
   *
   * Securities with no tags fall into an "Untagged" bucket and cash into a
   * "Cash" bucket, each kept as an explicit slice. A tag's own colour is used
   * when set, otherwise a palette colour is assigned by descending value.
   */
  buildAllocationByTag(
    securityItems: AllocationItem[],
    tagsBySymbol: Map<
      string,
      Array<{ id: string; name: string; color: string | null }>
    >,
    totalCashValue: number,
    defaultCurrency: string,
  ): AllocationItem[] {
    const palette = [
      "#3b82f6",
      "#22c55e",
      "#f97316",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#eab308",
      "#ef4444",
    ];

    // Accumulate value per tag (overlapping) and the untagged remainder.
    const tagBuckets = new Map<
      string,
      { name: string; color: string | null; value: number }
    >();
    let untaggedValue = 0;
    // Sum of every security slice that lands on the chart (tagged or not).
    // This, plus positive cash, is the denominator so tag and Untagged slices
    // share one base and reconcile to ~100%.
    let includedSecuritiesValue = 0;

    for (const item of securityItems) {
      if (item.type !== "security" || item.value <= 0) continue;
      includedSecuritiesValue += item.value;
      const tags = item.symbol ? (tagsBySymbol.get(item.symbol) ?? []) : [];
      if (tags.length === 0) {
        untaggedValue += item.value;
        continue;
      }
      for (const tag of tags) {
        const existing = tagBuckets.get(tag.id);
        if (existing) {
          existing.value += item.value;
        } else {
          tagBuckets.set(tag.id, {
            name: tag.name,
            color: tag.color,
            value: item.value,
          });
        }
      }
    }

    const positiveCash = totalCashValue > 0 ? totalCashValue : 0;
    const drawnTotal = includedSecuritiesValue + positiveCash;
    const pct = (value: number) =>
      drawnTotal > 0 ? (value / drawnTotal) * 100 : 0;

    const allocation: AllocationItem[] = [];

    if (totalCashValue > 0) {
      allocation.push({
        name: "Cash",
        symbol: null,
        type: "cash",
        value: totalCashValue,
        percentage: pct(totalCashValue),
        color: "#6b7280",
        currencyCode: defaultCurrency,
      });
    }

    const sortedTags = [...tagBuckets.values()].sort(
      (a, b) => b.value - a.value,
    );
    let colorIndex = 0;
    for (const bucket of sortedTags) {
      allocation.push({
        name: bucket.name,
        symbol: null,
        type: "tag",
        value: bucket.value,
        percentage: pct(bucket.value),
        color: bucket.color || palette[colorIndex % palette.length],
        currencyCode: defaultCurrency,
      });
      colorIndex++;
    }

    if (untaggedValue > 0) {
      allocation.push({
        name: "Untagged",
        symbol: null,
        type: "untagged",
        value: untaggedValue,
        percentage: pct(untaggedValue),
        color: "#9ca3af",
        currencyCode: defaultCurrency,
      });
    }

    return allocation;
  }

  /**
   * Portfolio allocation aggregated by the VALUE of a single KEY:VALUE tag key.
   *
   * Given a key such as `country`, every security's value is attributed to the
   * value(s) of its `country:*` tags (`country:usa` -> the "usa" slice), so a
   * `country` chart reads e.g. "50% usa, 25% poland, 25% germany". A security
   * that carries no value for the key (no `country:*` tag, or only a bare
   * `country:` with an empty value) falls into an "Untagged" slice; cash is a
   * "Cash" slice. Every slice shares one denominator -- the drawn security
   * values plus positive cash -- so percentages reconcile to ~100%.
   *
   * Multi-value handling mirrors {@link buildAllocationByTag}'s overlapping
   * exposure: a security tagged both `country:usa` and `country:poland` (a
   * mixed fund) counts its full value under each, so slices can sum past 100%.
   * Weighted splitting per value is a deliberate follow-up.
   */
  buildAllocationByTagKey(
    securityItems: AllocationItem[],
    tagsBySymbol: Map<
      string,
      Array<{ id: string; name: string; color: string | null }>
    >,
    totalCashValue: number,
    defaultCurrency: string,
    key: string,
  ): AllocationItem[] {
    const palette = [
      "#3b82f6",
      "#22c55e",
      "#f97316",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#eab308",
      "#ef4444",
    ];
    const normalizedKey = key.trim().toLowerCase();

    // valueKey (case-folded) -> { display value, colour, accumulated value }
    const valueBuckets = new Map<
      string,
      { name: string; color: string | null; value: number }
    >();
    let unassignedValue = 0;
    let includedSecuritiesValue = 0;

    for (const item of securityItems) {
      if (item.type !== "security" || item.value <= 0) continue;
      includedSecuritiesValue += item.value;
      const tags = item.symbol ? (tagsBySymbol.get(item.symbol) ?? []) : [];

      // Distinct concrete values this security carries under the key.
      const matched = new Map<
        string,
        { display: string; color: string | null }
      >();
      for (const tag of tags) {
        const parsed = parseTag(tag.name);
        if (parsed.key === null || parsed.key.toLowerCase() !== normalizedKey) {
          continue;
        }
        if (parsed.value === null) continue; // bare `key:` -> no concrete value
        const valueKey = parsed.value.toLowerCase();
        if (!matched.has(valueKey)) {
          matched.set(valueKey, { display: parsed.value, color: tag.color });
        }
      }

      if (matched.size === 0) {
        unassignedValue += item.value;
        continue;
      }
      for (const [valueKey, meta] of matched) {
        const existing = valueBuckets.get(valueKey);
        if (existing) {
          existing.value += item.value;
        } else {
          valueBuckets.set(valueKey, {
            name: meta.display,
            color: meta.color,
            value: item.value,
          });
        }
      }
    }

    const positiveCash = totalCashValue > 0 ? totalCashValue : 0;
    const drawnTotal = includedSecuritiesValue + positiveCash;
    const pct = (value: number) =>
      drawnTotal > 0 ? (value / drawnTotal) * 100 : 0;

    const allocation: AllocationItem[] = [];

    if (totalCashValue > 0) {
      allocation.push({
        name: "Cash",
        symbol: null,
        type: "cash",
        value: totalCashValue,
        percentage: pct(totalCashValue),
        color: "#6b7280",
        currencyCode: defaultCurrency,
      });
    }

    const sortedValues = [...valueBuckets.values()].sort(
      (a, b) => b.value - a.value,
    );
    let colorIndex = 0;
    for (const bucket of sortedValues) {
      allocation.push({
        name: bucket.name,
        symbol: null,
        type: "tag",
        value: bucket.value,
        percentage: pct(bucket.value),
        color: bucket.color || palette[colorIndex % palette.length],
        currencyCode: defaultCurrency,
      });
      colorIndex++;
    }

    if (unassignedValue > 0) {
      allocation.push({
        name: "Untagged",
        symbol: null,
        type: "untagged",
        value: unassignedValue,
        percentage: pct(unassignedValue),
        color: "#9ca3af",
        currencyCode: defaultCurrency,
      });
    }

    return allocation;
  }

  // ---------------------------------------------------------------------------
  // Performance metrics
  // ---------------------------------------------------------------------------

  /**
   * Calculate CAGR (Compound Annual Growth Rate).
   * CAGR = (Portfolio Value / Net Invested) ^ (1/years) - 1
   */
  async calculateCAGR(
    userId: string,
    allInvestmentAccountIds: string[],
    totalNetInvested: number,
    totalPortfolioValue: number,
  ): Promise<number | null> {
    if (
      totalNetInvested <= 0 ||
      totalPortfolioValue <= 0 ||
      allInvestmentAccountIds.length === 0
    ) {
      return null;
    }

    const earliestRow: { earliest: string }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT MIN(transaction_date) as earliest
       FROM investment_transactions
       WHERE user_id = $1
         AND account_id = ANY($2)
         AND transaction_date <= CURRENT_DATE
         AND status != 'VOID'`,
          [userId, allInvestmentAccountIds],
        ),
    );
    if (!earliestRow[0]?.earliest) return null;

    const earliest = new Date(earliestRow[0].earliest);
    const now = new Date();
    const years =
      (now.getTime() - earliest.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    // CAGR annualizes the total return, so for periods shorter than a year
    // it extrapolates a few days of price movement into a multi-decade
    // growth rate. The math is correct but the number is meaningless and
    // can run into the thousands of percent (or worse) for fresh accounts.
    if (years < 1) return null;

    return (
      (Math.pow(totalPortfolioValue / totalNetInvested, 1 / years) - 1) * 100
    );
  }

  // ---------------------------------------------------------------------------
  // Time-Weighted Return (TWR)
  // ---------------------------------------------------------------------------

  /**
   * Get all historical prices for a list of security IDs, ordered by date.
   * Returns a map of securityId -> sorted array of { date, price }.
   */
  async getAllPricesForSecurities(
    securityIds: string[],
  ): Promise<Map<string, { date: string; price: number }[]>> {
    if (securityIds.length === 0) return new Map();

    const rows: {
      security_id: string;
      price_date: string;
      close_price: string;
    }[] = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT security_id, price_date::text AS price_date, close_price
         FROM security_prices
         WHERE security_id = ANY($1)
         ORDER BY security_id, price_date ASC`,
        [securityIds],
      ),
    );

    const result = new Map<string, { date: string; price: number }[]>();
    for (const row of rows) {
      let arr = result.get(row.security_id);
      if (!arr) {
        arr = [];
        result.set(row.security_id, arr);
      }
      arr.push({ date: row.price_date, price: Number(row.close_price) });
    }
    return result;
  }

  /**
   * Look up the price for a security on or before a given date using binary search.
   */
  lookupPrice(
    securityId: string,
    date: string,
    allPrices: Map<string, { date: string; price: number }[]>,
  ): number | null {
    const prices = allPrices.get(securityId);
    if (!prices || prices.length === 0) return null;

    let lo = 0;
    let hi = prices.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prices[mid].date <= date) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? prices[best].price : null;
  }

  /**
   * Calculate Time-Weighted Return (TWR) for a set of investment accounts.
   * Forward-simulates holdings at each transaction date boundary and chains
   * sub-period returns to produce a cumulative TWR percentage.
   *
   * @param getLatestPrices - callback to fetch latest prices (injected from PortfolioService)
   */
  async calculateTWR(
    userId: string,
    holdingsAccountIds: string[],
    defaultCurrency: string,
    rateCache: FxRateCache,
    getLatestPrices: (securityIds: string[]) => Promise<Map<string, number>>,
  ): Promise<number | null> {
    if (holdingsAccountIds.length === 0) return null;

    // Fetch all investment transactions for these accounts, ordered by date
    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        // Rows as effects: a VOID transaction moved no shares and no cost.
        where: {
          userId,
          accountId: In(holdingsAccountIds),
          status: NON_VOID_INVESTMENT_STATUS,
        },
        relations: ["security"],
        order: { transactionDate: "ASC", createdAt: "ASC" },
      }),
    );

    if (transactions.length === 0) return null;

    // Gather all referenced security IDs and fetch their full price history
    const securityIds = [
      ...new Set(
        transactions.filter((t) => t.securityId).map((t) => t.securityId!),
      ),
    ];
    const allPrices = await this.getAllPricesForSecurities(securityIds);

    // Build a map of securityId -> currencyCode from transactions
    const currencyMap = new Map<string, string>();
    for (const tx of transactions) {
      if (tx.securityId && tx.security) {
        currencyMap.set(tx.securityId, tx.security.currencyCode);
      }
    }

    // Group transactions by date
    const txByDate = new Map<string, InvestmentTransaction[]>();
    for (const tx of transactions) {
      let arr = txByDate.get(tx.transactionDate);
      if (!arr) {
        arr = [];
        txByDate.set(tx.transactionDate, arr);
      }
      arr.push(tx);
    }

    const sortedDates = [...txByDate.keys()].sort();

    // M16: Batch-fetch all latest prices once to avoid N+1 queries
    const latestPriceCache = await getLatestPrices(securityIds);

    // TWR chains period-over-period factors, so one period value missing an
    // unconvertible position poisons every factor after it -- and unlike the
    // summary's totals, the ratio carries no missingRatePairs field a consumer
    // could check. When any period value had an FX gap the chained return is a
    // return on a portfolio nobody owns: unknown, not approximated, the same
    // treatment CAGR gets from its completeness gate.
    let fxIncomplete = false;

    // Helper: compute portfolio value from holdings state (current prices)
    const computeValue = async (
      holdings: Map<string, number>,
    ): Promise<number> => {
      const value = new FxAggregate();
      for (const [secId, qty] of holdings) {
        if (qty === 0) continue;
        const price = latestPriceCache.get(secId);
        if (price != null) {
          const currency = currencyMap.get(secId) || defaultCurrency;
          value.add(
            await this.convertToDefault(
              qty * price,
              currency,
              defaultCurrency,
              rateCache,
            ),
            currency,
            defaultCurrency,
          );
        }
      }
      if (!value.isComplete) {
        this.logger.warn(
          `Portfolio value omits positions with no exchange rate (${value.missingPairs.join(", ")})`,
        );
        fxIncomplete = true;
      }
      return value.knownSubtotal;
    };

    // Helper: compute portfolio value from holdings state at a specific date
    const computeValueAtDate = async (
      holdings: Map<string, number>,
      date: string,
    ): Promise<number> => {
      const value = new FxAggregate();
      for (const [secId, qty] of holdings) {
        if (qty === 0) continue;
        const price = this.lookupPrice(secId, date, allPrices);
        if (price != null) {
          const currency = currencyMap.get(secId) || defaultCurrency;
          value.add(
            await this.convertToDefault(
              qty * price,
              currency,
              defaultCurrency,
              rateCache,
            ),
            currency,
            defaultCurrency,
          );
        }
      }
      if (!value.isComplete) {
        this.logger.warn(
          `Portfolio value at ${date} omits positions with no exchange rate (${value.missingPairs.join(", ")})`,
        );
        fxIncomplete = true;
      }
      return value.knownSubtotal;
    };

    // Forward-simulate holdings and chain sub-period returns
    const holdings = new Map<string, number>(); // securityId -> quantity
    const subPeriodFactors: number[] = [];
    let previousValue = 0;
    let previousDate: string | null = null;

    for (const date of sortedDates) {
      const dayTxs = txByDate.get(date)!;

      if (previousDate !== null && previousValue > 0) {
        // Value of existing holdings at this date's prices (before applying today's transactions)
        const currentValue = await computeValueAtDate(holdings, date);
        if (currentValue >= 0) {
          subPeriodFactors.push(currentValue / previousValue);
        }
      }

      // Apply today's transactions to holdings
      for (const tx of dayTxs) {
        if (!tx.securityId) continue;
        const current = holdings.get(tx.securityId) || 0;
        const qty = Number(tx.quantity || 0);

        // SPLIT was in the "no quantity change" list here, so every point after
        // a split valued the pre-split share count -- a 2-for-1 halved the
        // reported value of the position from that day on. Fold through the
        // shared reducer that every other holdings walk uses.
        holdings.set(
          tx.securityId,
          applyActionToQuantity(current, tx.action, qty),
        );
      }

      // Compute portfolio value after today's transactions
      previousValue = await computeValueAtDate(holdings, date);
      previousDate = date;
    }

    // Final sub-period: from last transaction date to today
    if (previousValue > 0) {
      const todayValue = await computeValue(holdings);
      if (todayValue >= 0) {
        subPeriodFactors.push(todayValue / previousValue);
      }
    }

    if (subPeriodFactors.length === 0) return null;

    // A factor chain built over an FX gap is not a return; see fxIncomplete.
    if (fxIncomplete) return null;

    // Chain: TWR = product of all factors - 1
    let product = 1;
    for (const factor of subPeriodFactors) {
      product *= factor;
    }

    return (product - 1) * 100;
  }
}
