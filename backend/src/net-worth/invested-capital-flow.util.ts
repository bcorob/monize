/**
 * What crossed the boundary of the INVESTED part, per day and per currency.
 *
 * The sibling of `external-flow.util.ts`, drawn around a different boundary.
 * That one asks "did cash cross the edge of the portfolio", so a BUY, a SELL
 * and a DIVIDEND are internal to it. This one asks "did value enter or leave
 * the securities", so those same rows ARE the flows: a purchase moves a
 * reader's cash into the invested part and is not a gain, a sale moves it out
 * and is not a loss, and a distribution is what the invested part earned.
 * `docs/specs/portfolio-period-result.md` section 10.2 is the definition.
 *
 * Three rules this file exists to keep:
 *
 * - **The action classification is not restated here.** Which action is
 *   capital in, capital out, income or nothing is `INVESTED_FLOW_KIND_BY_BASE_ACTION`
 *   (`securities/investment-replay.util.ts`), checked against the enum by a
 *   spec. The SQL groups by raw action and the fold below asks that constant,
 *   so a new action cannot become a silent zero in a capital flow.
 * - **Rows as effects.** A VOID investment transaction moved no shares and no
 *   value, through the shared predicate (`investmentEffectStatusSql`).
 * - **Each day at its own rate.** A row is recorded in its security's currency
 *   and converted at the rate that stood on its own day, through the same
 *   `RateIndex` the value series and the external-flow fold use (INV-FX-001).
 *   A day that would not convert makes that day incomplete, which withholds the
 *   period's figures rather than shrinking them.
 */
import { FxAggregate } from "../common/fx-aggregate";
import {
  RateIndex,
  RateIndexLogger,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { returnedRows } from "../common/db/query-result";
import { actionCarriesTotal } from "../securities/investment-amount.util";
import {
  REINVESTED_INCOME_ACTIONS,
  investedFlowKind,
  reinvestedIncomeAmount,
} from "../securities/investment-replay.util";
import { investmentEffectStatusSql } from "../securities/investment-row-effects.util";
import { SeriesRateGap } from "./series-rate-fill";
import { PricePoint, positionCloseAsOf } from "./position-price.util";

/** One day's subtotal for one currency, action and security, as the loader returns it. */
export interface InvestedFlowRow {
  date: string;
  currency: string;
  action: string;
  /** The security the rows moved; null only for a row that names none. */
  securityId: string | null;
  /** Sum of the executed totals, for the actions that carry one. */
  total: number;
  /** Shares moved, unsigned. What a share-moving leg is VALUED from. */
  quantity: number;
  /**
   * The row's per-share price, or null. Read only for a reinvestment, which
   * the statement never groups with another row, so it is that row's own
   * price; on a grouped row it means nothing.
   */
  price: number | null;
  /** Sum of the commissions; read only for a reinvestment, as `price` is. */
  commission: number;
}

export interface InvestedFlowQueryOptions {
  userId: string;
  /** Exclusive lower bound: rows strictly AFTER this date, as IV(b) holds it. */
  afterDate: string;
  /** Inclusive upper bound. */
  throughDate: string;
  /** Every account of the scope; investment rows live on its brokerage sleeves. */
  accountIds: string[];
}

/** Runs one parameterized statement; supplied by the caller's scoped door. */
export type InvestedFlowQuery = (
  sql: string,
  params: unknown[],
) => Promise<unknown>;

/**
 * The SQL for one capital-and-income read. Exported so a spec can assert the
 * predicate and the bindings without a database.
 *
 * `total_amount` is stored in the security's currency, commission in on an
 * acquisition and out on a disposal (`deriveInvestmentTotal`), which is the
 * cost-basis convention the invested part measures in.
 *
 * The share-moving legs carry no total, and what they are valued at is not
 * their carried basis: `IV` moves by the position's MARKET value at the day's
 * accepted close, so a leg valued at anything else leaves the difference in
 * the P&L as a gain nobody made (`docs/specs/portfolio-period-result.md`
 * section 10.6). The shares are therefore returned unsummed-of-price, per
 * SECURITY, and `foldInvestedFlows` values them through `positionCloseAsOf` --
 * the same close, resolved by the same helper, that valued the position.
 *
 * A reinvestment is returned one row per transaction ($5 names the actions),
 * with its own price and commission, so the fold can value the distribution
 * through `reinvestedIncomeAmount` -- its total, else quantity x price +
 * commission -- rather than a second spelling of that rule in SQL. A reinvest
 * created in the app stores no total, so the total alone would value it at
 * nothing.
 */
export function investedCapitalFlowSql(): string {
  // $1 userId, $2 afterDate, $3 throughDate, $4 accountIds, $5 the reinvest
  // actions. Every placeholder this statement names is bound and no other: an
  // unreferenced parameter is a type PostgreSQL cannot infer, and it refuses at
  // PARSE.
  return `SELECT TO_CHAR(it.transaction_date, 'YYYY-MM-DD') AS date,
                 COALESCE(s.currency_code, a.currency_code) AS currency,
                 it.action AS action,
                 it.security_id AS security_id,
                 SUM(ABS(COALESCE(it.total_amount, 0))) AS total,
                 SUM(ABS(COALESCE(it.quantity, 0))) AS quantity,
                 MAX(it.price) AS price,
                 SUM(COALESCE(it.commission, 0)) AS commission
            FROM investment_transactions it
            JOIN accounts a ON a.id = it.account_id
            LEFT JOIN securities s ON s.id = it.security_id
           WHERE it.user_id = $1
             AND it.account_id = ANY($4::UUID[])
             AND it.transaction_date > $2
             AND it.transaction_date <= $3
             -- Rows as EFFECTS: renders it.status != 'VOID', because a void
             -- investment row moved no shares and no value.
             AND ${investmentEffectStatusSql("it")}
           GROUP BY it.transaction_date, COALESCE(s.currency_code, a.currency_code), it.action, it.security_id,
                    CASE WHEN it.action = ANY($5) THEN it.id END`;
}

/**
 * The scope's capital and income rows for the window, subtotalled per day,
 * currency and action. Conversion is the caller's, through `foldInvestedFlows`.
 */
export async function loadInvestedCapitalFlowRows(
  query: InvestedFlowQuery,
  options: InvestedFlowQueryOptions,
): Promise<InvestedFlowRow[]> {
  // An empty scope is a scope nothing is in, and it must total nothing.
  if (options.accountIds.length === 0) return [];

  const rows = returnedRows<{
    date: string;
    currency: string;
    action: string;
    security_id: string | null;
    total: string;
    quantity: string;
    price: string | null;
    commission: string | null;
  }>(
    await query(investedCapitalFlowSql(), [
      options.userId,
      options.afterDate,
      options.throughDate,
      options.accountIds,
      REINVESTED_INCOME_ACTIONS,
    ]),
  );

  return rows.map((row) => ({
    date: row.date,
    currency: row.currency,
    action: row.action,
    securityId: row.security_id ?? null,
    total: Number(row.total) || 0,
    quantity: Number(row.quantity) || 0,
    price: row.price === null ? null : Number(row.price),
    commission: Number(row.commission) || 0,
  }));
}

/** One day of the invested part's flows, in the reporting currency. */
export interface InvestedFlowDay {
  /** Value paid INTO the securities: it funds the day, it is not a gain. */
  capitalIn: number;
  /** Value taken OUT of them: it is what the position came to, not a loss. */
  capitalOut: number;
  /** Cash the invested part paid out, and therefore earned. */
  income: number;
  /**
   * Distributions the invested part earned and put straight back into shares.
   * Income AND capital in one: a surface adds it to both, so the result is
   * unchanged, and the return chains read neither, because its shares are
   * already in that day's `IV`.
   */
  reinvestedIncome: number;
  /** False when a component of this day could not be converted OR valued. */
  complete: boolean;
  /** `"EUR->USD"` for each pair with no rate on this day. */
  missingPairs: string[];
  /**
   * The securities whose share-moving leg this day could not be valued at,
   * because nothing priced them on or before it. Their shares are in `IV` with
   * no capital flow to net them, so the day is a subtotal and the period is
   * withheld -- naming a price to add, which is a repair, rather than a
   * movement nobody can act on.
   */
  unpricedSecurityIds: string[];
}

/**
 * The accepted close valuing one security on one day, or `null` when nothing
 * priced it by then.
 *
 * Supplied by the caller rather than resolved here, and it MUST be
 * `positionCloseAsOf` over the very series the value chart was built from: a
 * second price-resolution rule would let `IV` and `K` move by different amounts
 * for the same shares, which is the whole defect this values legs at market to
 * avoid.
 */
export type ShareLegClose = (
  securityId: string | null,
  date: string,
) => number | null;

/**
 * The securities whose legs this window has to price, and no others.
 *
 * Only a share-moving leg is valued from a close; a BUY or a DIVIDEND carries
 * its own executed total. A window with none of the former loads no prices at
 * all, which is the common case.
 */
export function shareLegSecurityIds(
  rows: readonly InvestedFlowRow[],
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (actionCarriesTotal(row.action)) continue;
    // A reinvestment is valued from its own price, not from a close.
    const kind = investedFlowKind(row.action);
    if (kind === "none" || kind === "reinvestedIncome") continue;
    if (row.quantity === 0 || !row.securityId) continue;
    ids.add(row.securityId);
  }
  return [...ids];
}

/**
 * The one resolver every caller passes to {@link foldInvestedFlows}, over the
 * valuation series `NetWorthService.loadValuationSeries` returns.
 *
 * Written once here because both period routes need it and `positionCloseAsOf`
 * is the merge rule the value series itself resolves a close by: two spellings
 * would let `IV` and `K` disagree about what a share was worth on a day.
 */
export function shareLegCloseFrom(series: {
  stored: Map<string, PricePoint[]>;
  txFallback: Map<string, PricePoint[]>;
}): ShareLegClose {
  return (securityId, date) =>
    securityId === null
      ? null
      : positionCloseAsOf(
          series.stored.get(securityId),
          series.txFallback.get(securityId),
          date,
        );
}

export interface FoldedInvestedFlows {
  /** Keyed by `YYYY-MM-DD`; a day with no rows is simply absent. */
  byDay: Map<string, InvestedFlowDay>;
  /** The per-day gaps the read-path rate fill plans a provider fetch from. */
  gaps: SeriesRateGap[];
}

/** An empty day: no capital moved, no income arrived, and that is known. */
export const EMPTY_INVESTED_FLOW_DAY: InvestedFlowDay = {
  capitalIn: 0,
  capitalOut: 0,
  income: 0,
  reinvestedIncome: 0,
  complete: true,
  missingPairs: [],
  unpricedSecurityIds: [],
};

/**
 * The rows folded per day into the reporting currency.
 *
 * Folded per DAY rather than per window so a preset reads its own slice out of
 * one wide load without re-folding: a day is the same day whatever window was
 * asked for, which is what makes the batch route's answers identical to the
 * single-range route's (section 10.7).
 */
export function foldInvestedFlows(
  rows: readonly InvestedFlowRow[],
  currency: string,
  rateIndex: RateIndex,
  logger: RateIndexLogger,
  shareLegClose: ShareLegClose,
): FoldedInvestedFlows {
  const aggregates = new Map<
    string,
    {
      in: FxAggregate;
      out: FxAggregate;
      income: FxAggregate;
      reinvested: FxAggregate;
      unpriced: Set<string>;
    }
  >();
  const gaps: SeriesRateGap[] = [];

  const dayEntry = (date: string) => {
    let entry = aggregates.get(date);
    if (!entry) {
      entry = {
        in: new FxAggregate(),
        out: new FxAggregate(),
        income: new FxAggregate(),
        reinvested: new FxAggregate(),
        unpriced: new Set<string>(),
      };
      aggregates.set(date, entry);
    }
    return entry;
  };

  for (const row of rows) {
    const kind = investedFlowKind(row.action);
    if (kind === "none") continue;
    // The executed total is the fact where the action carries one. A
    // share-moving leg has none, and is valued at the close that valued the
    // position -- NOT at the basis the row carries. `IV` moves by market
    // value, so the two cancel exactly and a transfer is neither a gain nor a
    // loss, whatever cost the leg was recorded at (section 10.6).
    let amount: number;
    if (kind === "reinvestedIncome") {
      // The distribution: its total, else what its shares cost. A legacy row
      // with neither a total nor a price is in no basis and in no income; it
      // would add the same unknown to both figures, which cancel anyway.
      const value = reinvestedIncomeAmount({
        quantity: row.quantity,
        price: row.price,
        commission: row.commission,
        totalAmount: row.total,
      });
      if (value === null) continue;
      amount = value;
    } else if (actionCarriesTotal(row.action)) {
      amount = row.total;
    } else {
      if (row.quantity === 0) continue;
      const close = shareLegClose(row.securityId, row.date);
      if (close === null) {
        // Unknown, never zero: the shares are in `IV` and free capital would
        // read as a gain. The day becomes a subtotal and names the price to add.
        if (row.securityId) dayEntry(row.date).unpriced.add(row.securityId);
        continue;
      }
      amount = row.quantity * close;
    }
    if (amount === 0) continue;

    const entry = dayEntry(row.date);
    const target =
      kind === "capitalIn"
        ? entry.in
        : kind === "capitalOut"
          ? entry.out
          : kind === "reinvestedIncome"
            ? entry.reinvested
            : entry.income;

    if (row.currency === currency) {
      target.addConverted(amount);
      continue;
    }
    const converted = convertAtDate(
      amount,
      row.currency,
      currency,
      row.date,
      rateIndex,
      logger,
    );
    if (converted === null) {
      gaps.push({
        date: row.date,
        missingRatePairs: [`${row.currency}->${currency}`],
      });
    }
    target.add(converted, row.currency, currency);
  }

  const byDay = new Map<string, InvestedFlowDay>();
  for (const [date, entry] of aggregates) {
    const missing = new Set<string>([
      ...entry.in.missingPairs,
      ...entry.out.missingPairs,
      ...entry.income.missingPairs,
      ...entry.reinvested.missingPairs,
    ]);
    byDay.set(date, {
      capitalIn: entry.in.knownSubtotal,
      capitalOut: entry.out.knownSubtotal,
      income: entry.income.knownSubtotal,
      reinvestedIncome: entry.reinvested.knownSubtotal,
      complete:
        entry.in.isComplete &&
        entry.out.isComplete &&
        entry.income.isComplete &&
        entry.reinvested.isComplete &&
        entry.unpriced.size === 0,
      missingPairs: [...missing].sort(),
      unpricedSecurityIds: [...entry.unpriced].sort(),
    });
  }

  return { byDay, gaps };
}
