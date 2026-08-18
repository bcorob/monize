import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { FxAggregate } from "../common/fx-aggregate";
import { convertWithRateLookup } from "../common/currency-conversion.util";
import { roundMoney } from "../common/round.util";
import { applyActionToQuantity } from "../securities/investment-replay.util";
import {
  BOUNDARY_LAG_DAYS,
  closeAt,
  withLeadDays,
  type PricePoint,
} from "../common/time-series/price-boundary.util";
import { todayYMD } from "../common/date-utils";
import { UserPreference } from "../users/entities/user-preference.entity";

/**
 * One account's worth at the end of a single day.
 *
 * `docs/specs/account-balances-as-of.md` is canonical for what each field means
 * and when it is allowed to be `null`; the short version is that `balance` is a
 * ledger sum the database always knows, and `marketValue` is a *total* -- so it
 * is `null` unless every position in the account was both priced and converted.
 */
export interface AccountBalanceAsOf {
  accountId: string;
  currencyCode: string;
  balance: number;
  marketValue: number | null;
  knownMarketValueSubtotal: number;
  unpricedHoldingsCount: number;
  missingRatePairs: string[];
  pricesComplete: boolean;
  fxComplete: boolean;
  valuationComplete: boolean;
}

export interface AccountBalancesAsOfResponse {
  /** Echoes the date the figures were measured at, so the payload carries its own request key. */
  asOfDate: string;
  /** The user's reporting currency, which every total is presented in. */
  displayCurrency: string;
  /**
   * Multiplier from each account currency present to `displayCurrency`, as the
   * rate stood on `asOfDate`.
   *
   * A currency **absent** from this map has no accepted rate for that date, and
   * a consumer must treat its accounts as unconvertible rather than reaching
   * for a live rate or for 1 -- which is the whole point of shipping the rates
   * beside the figures they belong to. `displayCurrency` itself is present at
   * 1, because same-currency is 1:1 by definition and has to stay
   * distinguishable from the missing case.
   */
  displayRates: Record<string, number>;
  accounts: AccountBalanceAsOf[];
}

/** A share position is treated as closed below this, matching HoldingsService. */
const QUANTITY_EPSILON = 0.00000001;

/**
 * The date the *market* is read at, for a report asked about `asOfDate`.
 *
 * The ledger runs ahead -- a transaction can be dated next year -- but prices
 * and rates cannot, so a future `asOfDate` is clamped to today, which is the
 * same thing `ExchangeRateService.getRateForDate` does and for the same reason:
 * today's figure is the best available estimate of a day that has not happened.
 *
 * Without the clamp the staleness bound refuses its own inputs. `closeAt` asks
 * how old an observation is *relative to the date being priced*, so a report
 * dated a year out would find today's close 365 days stale and call every
 * position unpriced -- and the bounded query would not even return it.
 */
function marketDateFor(asOfDate: string): string {
  const today = todayYMD();
  return asOfDate > today ? today : asOfDate;
}

/**
 * Point-in-time balances for the Account Balances report (issue #1198).
 *
 * Kept apart from `AccountsService` because it answers a different question:
 * that service maintains `current_balance`, a running figure the ledger writes
 * keep up to date, while this one measures every account at a date the caller
 * chose -- which may be years back or years ahead.
 */
@Injectable()
export class AccountBalancesReportService {
  private readonly logger = new Logger(AccountBalancesReportService.name);

  constructor(private dataSource: DataSource) {}

  private scopedQuery<T = any>(sql: string, params?: any[]): Promise<T> {
    return withScopedDb(this.dataSource, (m) => m.query(sql, params));
  }

  /**
   * Every account the caller can see, valued at the end of `asOfDate`.
   *
   * `jointAccountIds` are accounts another owner shared with the caller; the
   * controller has already authorized them, and the predicate widens to those
   * exact ids and nothing else -- the same shape `getDailyBalances` uses.
   *
   * `restrictToAccountIds` narrows the answer to exactly those accounts, for a
   * delegate whose grant names a subset of the owner's. It is a restriction on
   * the *query*, not a filter over its result: reading the owner's other
   * balances and dropping them afterwards answers correctly while still having
   * read them.
   */
  async getBalancesAsOf(
    userId: string,
    asOfDate: string,
    jointAccountIds: string[] = [],
    restrictToAccountIds?: string[],
  ): Promise<AccountBalancesAsOfResponse> {
    // An answer with no accounts in it still has a reporting currency: the
    // client draws its (zero) totals and its empty state in one, and a response
    // that omitted it would leave that currency to be guessed.
    const displayCurrency = await this.resolveDisplayCurrency(userId);
    const empty = {
      asOfDate,
      displayCurrency,
      displayRates: { [displayCurrency]: 1 },
      accounts: [],
    };

    // An empty restriction is "no accounts", not "no restriction": a delegate
    // granted nothing must not fall through to the owner's whole list.
    if (restrictToAccountIds && restrictToAccountIds.length === 0) return empty;
    const restriction = restrictToAccountIds ?? null;

    const accounts: Array<{
      id: string;
      currency_code: string;
      account_type: string;
      account_sub_type: string | null;
    }> = await this.scopedQuery(
      `SELECT id, currency_code, account_type, account_sub_type
         FROM accounts
        WHERE (user_id = $1 OR id = ANY($2::UUID[]))
          AND ($3::UUID[] IS NULL OR id = ANY($3::UUID[]))`,
      [userId, jointAccountIds, restriction],
    );

    if (accounts.length === 0) return empty;

    const ledgerBalances = await this.ledgerBalances(
      userId,
      asOfDate,
      jointAccountIds,
      restriction,
    );

    // One rate read serves both jobs: pricing a foreign holding into its own
    // account's currency, and presenting every account in the user's. Reading
    // them twice would be two chances for the two halves of one report to be
    // converted at different vintages.
    const rates = await this.storedRatesAsOf(marketDateFor(asOfDate));

    // Only these hold securities. The cash sleeve of a linked pair is an
    // ordinary ledger account and is excluded here, exactly as it is everywhere
    // else -- counting it twice is the double-count the pairing exists to avoid.
    const holdingsAccounts = accounts.filter(
      (a) =>
        a.account_type === "INVESTMENT" &&
        (a.account_sub_type === "INVESTMENT_BROKERAGE" || !a.account_sub_type),
    );
    const marketValues = await this.marketValuesAsOf(
      holdingsAccounts.map((a) => ({
        id: a.id,
        currencyCode: a.currency_code,
      })),
      asOfDate,
      rates,
    );

    return {
      asOfDate,
      displayCurrency,
      displayRates: this.displayRates(
        accounts.map((a) => a.currency_code),
        displayCurrency,
        rates,
        asOfDate,
      ),
      accounts: accounts.map((a) => {
        const valuation = marketValues.get(a.id);
        // A row that holds no securities has no market value to report -- that
        // is "does not apply", which is why the completeness flag stays true
        // rather than following the null.
        if (!valuation) {
          return {
            accountId: a.id,
            currencyCode: a.currency_code,
            balance: ledgerBalances.get(a.id) ?? 0,
            marketValue: null,
            knownMarketValueSubtotal: 0,
            unpricedHoldingsCount: 0,
            missingRatePairs: [],
            pricesComplete: true,
            fxComplete: true,
            valuationComplete: true,
          };
        }
        return {
          accountId: a.id,
          currencyCode: a.currency_code,
          balance: ledgerBalances.get(a.id) ?? 0,
          ...valuation,
        };
      }),
    };
  }

  /**
   * Opening balance plus every non-void, non-child transaction dated on or
   * before `asOfDate` -- the same expression `recalculateCurrentBalance` uses,
   * with the caller's date in place of today.
   */
  private async ledgerBalances(
    userId: string,
    asOfDate: string,
    jointAccountIds: string[],
    restriction: string[] | null,
  ): Promise<Map<string, number>> {
    const rows: Array<{ id: string; balance: string }> = await this.scopedQuery(
      `SELECT a.id,
                COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance
           FROM accounts a
           LEFT JOIN transactions t ON t.account_id = a.id
            AND (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date <= $2
          WHERE (a.user_id = $1 OR a.id = ANY($3::UUID[]))
            AND ($4::UUID[] IS NULL OR a.id = ANY($4::UUID[]))
          GROUP BY a.id, a.opening_balance`,
      [userId, asOfDate, jointAccountIds, restriction],
    );

    return new Map(rows.map((r) => [r.id, roundMoney(Number(r.balance))]));
  }

  /**
   * Replay each holdings account to `asOfDate` and value what it held.
   *
   * The price used is the security's last close **on or before** the date, and
   * the rate is the last stored rate on or before it. That is what makes a
   * future date meaningful: the position is carried at the most recent figure
   * anybody knows, which is the only honest answer about a day that has not
   * happened yet. It is not a forecast, and nothing here extrapolates.
   */
  private async marketValuesAsOf(
    holdingsAccounts: Array<{ id: string; currencyCode: string }>,
    asOfDate: string,
    rates: Map<string, number>,
  ): Promise<
    Map<
      string,
      {
        marketValue: number | null;
        knownMarketValueSubtotal: number;
        unpricedHoldingsCount: number;
        missingRatePairs: string[];
        pricesComplete: boolean;
        fxComplete: boolean;
        valuationComplete: boolean;
      }
    >
  > {
    const result = new Map<
      string,
      {
        marketValue: number | null;
        knownMarketValueSubtotal: number;
        unpricedHoldingsCount: number;
        missingRatePairs: string[];
        pricesComplete: boolean;
        fxComplete: boolean;
        valuationComplete: boolean;
      }
    >();
    if (holdingsAccounts.length === 0) return result;

    const accountIds = holdingsAccounts.map((a) => a.id);
    const transactions: Array<{
      account_id: string;
      security_id: string;
      action: string;
      quantity: string | null;
    }> = await this.scopedQuery(
      `SELECT account_id, security_id, action, quantity
         FROM investment_transactions
        WHERE account_id = ANY($1::UUID[])
          AND security_id IS NOT NULL
          AND status != 'VOID'
          AND transaction_date <= $2
        ORDER BY transaction_date ASC, created_at ASC`,
      [accountIds, asOfDate],
    );

    // accountId -> securityId -> quantity, folded through the one reducer every
    // other replay in the codebase uses (a SPLIT's quantity is a ratio).
    const positions = new Map<string, Map<string, number>>();
    for (const tx of transactions) {
      let bySecurity = positions.get(tx.account_id);
      if (!bySecurity) {
        bySecurity = new Map<string, number>();
        positions.set(tx.account_id, bySecurity);
      }
      bySecurity.set(
        tx.security_id,
        applyActionToQuantity(
          bySecurity.get(tx.security_id) ?? 0,
          tx.action,
          Number(tx.quantity ?? 0),
        ),
      );
    }

    const heldSecurityIds = [
      ...new Set(
        [...positions.values()].flatMap((bySecurity) =>
          [...bySecurity.entries()]
            .filter(([, qty]) => Math.abs(qty) > QUANTITY_EPSILON)
            .map(([securityId]) => securityId),
        ),
      ),
    ];

    const [prices, securityCurrencies] = await Promise.all([
      this.closingPricesAsOf(heldSecurityIds, marketDateFor(asOfDate)),
      this.securityCurrencies(heldSecurityIds),
    ]);

    for (const account of holdingsAccounts) {
      const bySecurity = positions.get(account.id);
      const aggregate = new FxAggregate();
      const unpriced = new Set<string>();

      for (const [securityId, quantity] of bySecurity ?? []) {
        if (Math.abs(quantity) <= QUANTITY_EPSILON) continue;
        const price = prices.get(securityId);
        // An unpriced position is unknown, not free. Folding it in at zero is
        // what makes a partial valuation look like a settled one.
        if (price == null) {
          unpriced.add(securityId);
          continue;
        }
        const securityCurrency =
          securityCurrencies.get(securityId) ?? account.currencyCode;
        aggregate.add(
          convertWithRateLookup(
            quantity * price,
            securityCurrency,
            account.currencyCode,
            (from, to) => rates.get(`${from}->${to}`),
          ),
          securityCurrency,
          account.currencyCode,
        );
      }

      const missingRatePairs = aggregate.missingPairs;
      if (missingRatePairs.length > 0) {
        this.logger.warn(
          `Account ${account.id} valuation at ${asOfDate} omits positions with no exchange rate (${missingRatePairs.join(", ")})`,
        );
      }
      const complete = aggregate.isComplete && unpriced.size === 0;
      const knownSubtotal = roundMoney(aggregate.knownSubtotal);

      result.set(account.id, {
        // An account holding nothing is worth zero, not unknown -- the
        // aggregate returns 0 for that case and it stays complete.
        marketValue: complete ? knownSubtotal : null,
        knownMarketValueSubtotal: knownSubtotal,
        unpricedHoldingsCount: unpriced.size,
        missingRatePairs,
        pricesComplete: unpriced.size === 0,
        fxComplete: aggregate.isComplete,
        valuationComplete: complete,
      });
    }

    return result;
  }

  /** The currency the user reads their totals in. */
  private async resolveDisplayCurrency(userId: string): Promise<string> {
    const preference = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preference?.defaultCurrency || "USD";
  }

  /**
   * The multiplier from each account currency to `displayCurrency`, as the rate
   * stood on the report's date.
   *
   * A point-in-time report converts at that point in time: asked what an
   * account held in 2019, "what it was worth then" is the question, and today's
   * rate answers a different one. The rates travel in the payload beside the
   * figures for the same reason the date does -- a consumer converting with a
   * live rate map would be presenting one date's balances at another date's
   * rates, and nothing on screen would say so.
   *
   * A currency with no accepted rate is **omitted**, never given 1. The display
   * currency itself is present at 1 because that is a definition, not a
   * fallback, and it has to stay distinguishable from the absent case.
   */
  private displayRates(
    accountCurrencies: string[],
    displayCurrency: string,
    rates: Map<string, number>,
    asOfDate: string,
  ): Record<string, number> {
    const resolved: Record<string, number> = { [displayCurrency]: 1 };
    const missing = new Set<string>();
    for (const currency of new Set(accountCurrencies)) {
      if (currency === displayCurrency) continue;
      const rate = convertWithRateLookup(1, currency, displayCurrency, (f, t) =>
        rates.get(`${f}->${t}`),
      );
      if (rate === null) {
        missing.add(`${currency}->${displayCurrency}`);
        continue;
      }
      resolved[currency] = rate;
    }
    if (missing.size > 0) {
      this.logger.warn(
        `No exchange rate at ${asOfDate} for ${[...missing].sort().join(", ")}; accounts in those currencies cannot be presented in ${displayCurrency}`,
      );
    }
    return resolved;
  }

  /**
   * Each security's close standing for `asOfDate`, through the one door.
   *
   * `closeAt` is what applies the staleness bound (`docs/time-series-contract.md`
   * section 2.1): a security last quoted months before the date has no price
   * *for that date*, and answering with the old close would report an
   * instrument as having gone nowhere since. Absent here means unpriced, which
   * the caller turns into a null account total rather than a smaller one.
   *
   * The query is bounded on both sides for the same reason -- it loads exactly
   * the window `closeAt` can accept, so the door and the read agree.
   */
  private async closingPricesAsOf(
    securityIds: string[],
    asOfDate: string,
  ): Promise<Map<string, number>> {
    if (securityIds.length === 0) return new Map();
    const rows: Array<{
      security_id: string;
      price_date: string;
      close_price: string;
    }> = await this.scopedQuery(
      `SELECT security_id, price_date::text AS price_date, close_price
           FROM security_prices
          WHERE security_id = ANY($1::UUID[])
            AND price_date >= $3
            AND price_date <= $2
          ORDER BY security_id, price_date ASC`,
      [securityIds, asOfDate, withLeadDays(asOfDate, BOUNDARY_LAG_DAYS)],
    );

    const series = new Map<string, PricePoint[]>();
    for (const row of rows) {
      const points = series.get(row.security_id);
      const point = { date: row.price_date, close: Number(row.close_price) };
      if (points) {
        points.push(point);
      } else {
        series.set(row.security_id, [point]);
      }
    }

    const prices = new Map<string, number>();
    for (const [securityId, points] of series) {
      const close = closeAt(points, asOfDate);
      if (close !== null) prices.set(securityId, close);
    }
    return prices;
  }

  private async securityCurrencies(
    securityIds: string[],
  ): Promise<Map<string, string>> {
    if (securityIds.length === 0) return new Map();
    const rows: Array<{ id: string; currency_code: string }> =
      await this.scopedQuery(
        `SELECT id, currency_code FROM securities WHERE id = ANY($1::UUID[])`,
        [securityIds],
      );
    return new Map(rows.map((r) => [r.id, r.currency_code]));
  }

  /**
   * The rate standing for `asOfDate` for every pair, keyed `"FROM->TO"`.
   * `convertWithRateLookup` tries the reverse pair itself, so only one
   * direction needs to exist.
   *
   * A rate is an observation on a date exactly as a close is, so it goes
   * through the same door and the same staleness bound: a pair last quoted
   * long before the date has no rate *for* it, and the caller reports the pair
   * as missing rather than converting at a number from another era.
   */
  private async storedRatesAsOf(
    asOfDate: string,
  ): Promise<Map<string, number>> {
    const rows: Array<{
      from_currency: string;
      to_currency: string;
      rate_date: string;
      rate: string;
    }> = await this.scopedQuery(
      `SELECT from_currency, to_currency, rate_date::text AS rate_date, rate
         FROM exchange_rates
        WHERE rate_date >= $2
          AND rate_date <= $1
        ORDER BY from_currency, to_currency, rate_date ASC`,
      [asOfDate, withLeadDays(asOfDate, BOUNDARY_LAG_DAYS)],
    );

    const series = new Map<string, PricePoint[]>();
    for (const row of rows) {
      const key = `${row.from_currency}->${row.to_currency}`;
      const points = series.get(key);
      const point = { date: row.rate_date, close: Number(row.rate) };
      if (points) {
        points.push(point);
      } else {
        series.set(key, [point]);
      }
    }

    const rates = new Map<string, number>();
    for (const [pair, points] of series) {
      const rate = closeAt(points, asOfDate);
      if (rate !== null) rates.set(pair, rate);
    }
    return rates;
  }
}
