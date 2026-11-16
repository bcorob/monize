import {
  investmentLinkedSplitExclusion,
  investmentLinkedTransactionExclusion,
} from "../common/investment-filter.util";
import { returnedRows } from "../common/db/query-result";

/**
 * What "cash crossed the investment boundary" means, in one place.
 *
 * Two surfaces measure a portfolio's movement net of the reader's own
 * contributions -- the daily movement notification
 * (`docs/specs/portfolio-movement-notifications.md`) and the calendar's daily
 * change layer -- and both subtract this figure from a value difference. Two
 * spellings of the predicate would be two different measures wearing one name,
 * so the classification lives here and each caller supplies only its scope and
 * its window.
 *
 * A row counts as external flow when ALL of the following hold:
 *
 *  - its account is in the scope (an investment account, or an explicit id set);
 *  - it is a top-level row (`parent_transaction_id IS NULL`), not a split child
 *    that would double-count its parent;
 *  - it is not VOID -- a void row moved no cash (INV-TRANSFER-001);
 *  - it is not investment-linked, by either representation: a row an
 *    `investment_transactions` record points at, or a parent carrying an
 *    embedded investment split line. Both use the shared exclusions from
 *    `investment-filter.util.ts` rather than a hand-written action list
 *    (INV-REPORT-001, INV-PORTMOVE-006). A hand-rolled copy once joined
 *    `investment_transactions.transaction_split_id` (a `transaction_splits` FK)
 *    against `transactions.id`, a table mismatch that made the split exclusion a
 *    silent no-op;
 *  - it is not a transfer whose counterparty is also in the scope: cash moved
 *    between two scoped accounts never crossed the boundary;
 *  - when the caller names an `investmentScope`, it is not a transfer whose
 *    counterparty is the cash leg of an investment action on one of those
 *    accounts. That is the trade settling inside the portfolio in the shape the
 *    QIF/CSV import writes: the action's cash leg is a transfer row on the
 *    brokerage and its counterpart is the sleeve's cash. A caller drawing the
 *    boundary around the sleeves alone would otherwise read every imported BUY
 *    as a withdrawal and every dividend as a deposit.
 *
 * TWO KNOWN COARSE CASES (INV-PORTMOVE, tracked in the spec's open items), both
 * narrowing rather than corrupting the common path. A caller that subtracts this
 * figure from a value change has to decide what to do about them: the period
 * result counts both per window and withholds its result rather than reporting a
 * difference that is not the market's (`docs/specs/portfolio-period-result.md`
 * section 6.1).
 *
 *  - A split parent that mixes an embedded investment line with an ordinary
 *    external cash line is excluded WHOLE (the sum is over `t.amount`, so it
 *    cannot keep one line and drop another). The line-granular form --
 *    `reportableTransactionAmount`'s dialect -- is a spec-guided follow-up,
 *    because this flow's transfer policy (a transfer OUT of the set counts)
 *    differs from that helper's (it drops all transfers).
 *  - A BUY/SELL funded from an account OUTSIDE the scope (an explicit
 *    `fundingAccountId` on an ordinary account) moves value in with no cash leg
 *    in the scope, so this flow cannot see it and the purchase reads as a market
 *    move. The spec treats BUY/SELL as internal; widening that is a maintainer
 *    decision, not a coded defect.
 *
 * NOTE: verified by unit tests at the fold layer and by asserting the generated
 * SQL here; the classification itself needs the integration environment (a real
 * database with the investment account pair and an embedded-investment split) to
 * confirm end to end.
 */

/** One external-flow subtotal, in the account currency it was recorded in. */
export interface ExternalFlowSubtotal {
  /** The day the flow landed on; `null` when the caller asked for a range total. */
  date: string | null;
  currency: string;
  amount: number;
}

export interface ExternalFlowQueryOptions {
  userId: string;
  /** Exclusive lower bound: flows strictly AFTER this date. */
  afterDate: string;
  /** Inclusive upper bound. */
  throughDate: string;
  /**
   * The accounts the flow's boundary is drawn around. Omitted means every
   * INVESTMENT account of the user, which is what the daily notification asks
   * about; an explicit set is what a filtered calendar asks about.
   */
  accountIds?: string[];
  /** Subtotal per day as well as per currency, rather than over the window. */
  perDay?: boolean;
  /**
   * The accounts whose investment actions settle INSIDE the boundary even when
   * their cash leg sits on an account outside `accountIds` (a brokerage row
   * transferring to its sleeve). Only meaningful with `accountIds`: an
   * unscoped read already holds every investment account on both sides.
   */
  investmentScope?: string[];
}

/** Runs one parameterized statement; supplied by the caller's scoped door. */
export type ExternalFlowQuery = (
  sql: string,
  params: unknown[],
) => Promise<unknown>;

/**
 * The SQL for one external-flow read. Exported so a spec can assert the
 * predicate without a database; `loadExternalFlowSubtotals` is what callers use.
 */
export function externalFlowSubtotalsSql(options: {
  scoped: boolean;
  perDay: boolean;
  /** Binds `$5`: only a scoped read takes it. */
  investmentScoped?: boolean;
}): string {
  // $1 userId, $2 afterDate, $3 throughDate, $4 accountIds (scoped only),
  // $5 investmentScope (scoped with an investment scope only).
  const inScope = options.scoped
    ? "a.id = ANY($4::UUID[])"
    : "a.account_type = 'INVESTMENT'";
  const counterpartyInScope = options.scoped
    ? "la.id = ANY($4::UUID[])"
    : "la.account_type = 'INVESTMENT'";
  // The counterpart is an investment action's cash leg on an account of the
  // investment scope: the trade settled into this row, inside the portfolio.
  // Read as a record (includes VOID), like `investmentLinkedTransactionExclusion`:
  // it asks what the counterpart IS. A voided trade's legs are VOID themselves,
  // and the outer query already drops a VOID row.
  const settlesScopedAction =
    options.scoped && options.investmentScoped
      ? `
                     OR EXISTS (
                       SELECT 1 FROM investment_transactions lit
                        WHERE lit.transaction_id = lt.id
                          AND lit.account_id = ANY($5::UUID[])
                     )`
      : "";
  // Unchanged text when no investment scope is asked for: the unscoped form is
  // pinned verbatim to the notification's original statement.
  const counterpartyClause = settlesScopedAction
    ? `(${counterpartyInScope}${settlesScopedAction})`
    : counterpartyInScope;
  // `TO_CHAR(..., 'YYYY-MM-DD')`, never `::TEXT`: the caller keys its per-day
  // map on this string and compares it with `YYYY-MM-DD` keys, and a DATE
  // rendered through the session's DateStyle is not obliged to be that.
  const dateColumn = options.perDay
    ? "TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date, "
    : "NULL::TEXT AS date, ";
  const groupBy = options.perDay
    ? "GROUP BY t.transaction_date, t.currency_code"
    : "GROUP BY t.currency_code";

  return `SELECT ${dateColumn}t.currency_code AS currency, SUM(t.amount) AS total
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.user_id = $1
              AND ${inScope}
              AND t.parent_transaction_id IS NULL
              AND t.transaction_date > $2
              AND t.transaction_date <= $3
              AND t.status IS DISTINCT FROM 'VOID'
              AND ${investmentLinkedTransactionExclusion("t")}
              AND NOT EXISTS (
                SELECT 1 FROM transaction_splits s
                 WHERE s.transaction_id = t.id
                   AND NOT (${investmentLinkedSplitExclusion("s")})
              )
              AND NOT (
                t.is_transfer = true
                AND EXISTS (
                  SELECT 1 FROM transactions lt
                   JOIN accounts la ON la.id = lt.account_id
                   WHERE lt.id = t.linked_transaction_id
                     AND ${counterpartyClause}
                )
              )
            ${groupBy}`;
}

/**
 * The scope's external cash flow, subtotalled by currency (and by day when
 * asked). Conversion into a reporting currency is the caller's, through
 * `foldExternalFlow`, because a missing rate makes the flow incomplete and what
 * that withholds differs per caller.
 */
export async function loadExternalFlowSubtotals(
  query: ExternalFlowQuery,
  options: ExternalFlowQueryOptions,
): Promise<ExternalFlowSubtotal[]> {
  const scoped = options.accountIds !== undefined;
  // An explicit but EMPTY scope is not "every investment account": it is a
  // scope nothing is in, and it must total nothing.
  if (scoped && options.accountIds!.length === 0) return [];

  const params: unknown[] = [
    options.userId,
    options.afterDate,
    options.throughDate,
  ];
  if (scoped) params.push(options.accountIds);
  // Every placeholder the statement names is bound, and nothing more: an
  // unreferenced parameter is a type PostgreSQL cannot infer.
  const investmentScoped = scoped && (options.investmentScope?.length ?? 0) > 0;
  if (investmentScoped) params.push(options.investmentScope);

  const rows = returnedRows<{
    date: string | null;
    currency: string;
    total: string;
  }>(
    await query(
      externalFlowSubtotalsSql({
        scoped,
        perDay: options.perDay === true,
        investmentScoped,
      }),
      params,
    ),
  );

  return rows.map((row) => ({
    date: row.date,
    currency: row.currency,
    amount: Number(row.total),
  }));
}
