/**
 * Which accounts an investment question is about.
 *
 * A brokerage and its cash sleeve are one portfolio wearing two account rows, so
 * asking about either has to mean asking about both: a scope of the brokerage
 * alone values the holdings and loses the cash that funded them, and a scope of
 * the sleeve alone reports cash with no securities. Every surface that takes an
 * `accountIds` filter over investments therefore widens it the same way -- the
 * requested accounts, anything linked TO them, and the accounts they link to --
 * and that widening is written once here so two surfaces cannot disagree about
 * what "this portfolio" means.
 *
 * Resolved in one statement rather than a round trip per id.
 */

/** Runs one parameterized statement; supplied by the caller's scoped door. */
export type InvestmentScopeQuery = (
  sql: string,
  params: unknown[],
) => Promise<Array<{ id: string }>>;

/**
 * The requested accounts plus their linked pairs, deduplicated.
 *
 * Returns an empty array when nothing matched, which callers read as "no scope"
 * and answer emptily -- never as "every account", which is what an undefined
 * filter means.
 */
export async function resolveInvestmentScopeAccountIds(
  query: InvestmentScopeQuery,
  userId: string,
  accountIds: string[],
): Promise<string[]> {
  if (accountIds.length === 0) return [];
  const resolved = await query(
    `SELECT id FROM accounts
         WHERE user_id = $2
           AND (
             id = ANY($1)
             OR linked_account_id = ANY($1)
             OR id IN (
               SELECT linked_account_id FROM accounts
               WHERE id = ANY($1) AND user_id = $2
             )
           )`,
    [accountIds, userId],
  );
  return [...new Set(resolved.map((a) => a.id))];
}

/**
 * The account-type predicate that stands in for an unfiltered investment scope:
 * a brokerage, a cash sleeve, or a standalone investment account that predates
 * the pair (its sub-type is null).
 *
 * A literal on the alias `a`, for composition into a larger statement.
 */
export const UNFILTERED_INVESTMENT_SCOPE_SQL = `(a.account_sub_type IN ('INVESTMENT_CASH', 'INVESTMENT_BROKERAGE') OR (a.account_type = 'INVESTMENT' AND a.account_sub_type IS NULL))`;
