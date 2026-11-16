import { returnedRows } from "../common/db/query-result";
import { investmentEffectStatusSql } from "../securities/investment-row-effects.util";

/** Runs one parameterized statement through the caller's scoped door. */
export type InceptionQuery = (
  sql: string,
  params: unknown[],
) => Promise<unknown>;

/**
 * The scope's earliest investment transaction date, or `null` when it has
 * none. Rows as EFFECTS: a VOID row records something that did not happen, so
 * it cannot be the day a portfolio started (`investmentEffectStatusSql`).
 *
 * The one spelling of "when did this portfolio start". The period result's
 * `all` window, the batch route's history gate and the sampled long-range
 * value series all open from it, so the chart and the figures under it cannot
 * open on different days (`docs/specs/portfolio-period-result.md` section
 * 10.9).
 */
export async function loadFirstInvestmentDate(
  query: InceptionQuery,
  userId: string,
  accountIds: string[],
): Promise<string | null> {
  if (accountIds.length === 0) return null;
  const rows = returnedRows<{ date: string | null }>(
    await query(
      `SELECT TO_CHAR(MIN(it.transaction_date), 'YYYY-MM-DD') AS date
         FROM investment_transactions it
        WHERE it.user_id = $1
          AND it.account_id = ANY($2::UUID[])
          -- Rows as EFFECTS: renders it.status != 'VOID', because a void
          -- row records something that did not happen.
          AND ${investmentEffectStatusSql("it")}`,
      [userId, accountIds],
    ),
  );
  return rows[0]?.date ?? null;
}
