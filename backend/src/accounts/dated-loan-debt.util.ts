import { EntityManager } from "typeorm";
import {
  ACCOUNT_BALANCE_AS_OF_SQL,
  ACCOUNT_BALANCES_AS_OF_DATES_SQL,
} from "../common/ledger-balance.sql";
import { roundMoney } from "../common/round.util";

/**
 * The outstanding debt of a loan-like account through `asOfDate`, inclusive,
 * from the authoritative ledger: opening balance plus every non-void,
 * top-level transaction dated on or before that date -- the same expression
 * `recalculateCurrentBalance` and the balances-as-of report use, with the
 * pricing date in place of today.
 *
 * `accounts.current_balance` deliberately excludes future-dated rows, so it
 * cannot price an installment, or a rate change, dated after a payment that is
 * already posted for the future. This is `debt(d)` of
 * docs/specs/mortgage-types.md section 2, the one as-of read that installment
 * pricing (INV-LOAN-006) and the rate-change paths (spec decision 5) share.
 *
 * Debt accounts store the balance negative; an overpaid balance (in credit)
 * reads as retired (0) rather than as fresh debt. Null only when the account
 * row cannot be read back (deleted concurrently); a failed lookup is not a
 * zero balance.
 */
export async function datedLoanDebt(
  m: EntityManager,
  loanAccount: { id: string; userId: string },
  asOfDate: string,
): Promise<number | null> {
  const rows: Array<{ balance: string | null }> = await m.query(
    ACCOUNT_BALANCE_AS_OF_SQL,
    [loanAccount.id, loanAccount.userId, asOfDate],
  );
  if (rows.length === 0 || rows[0].balance == null) {
    return null;
  }
  return debtFromBalance(rows[0].balance);
}

/**
 * `datedLoanDebt` for several dates in one statement
 * (`ACCOUNT_BALANCES_AS_OF_DATES_SQL`): the settlement of a pass of bank rows
 * prices every slot it may claim, and reads them all under the locks it holds
 * rather than one round trip per slot. Equal to `datedLoanDebt` date by date
 * because both are the one as-of balance expression bounded at the date
 * (`backend/test/integration/loan-settlement-debt.integration.spec.ts`).
 *
 * Keyed by the `YYYY-MM-DD` date asked for; a date asked for twice appears
 * once. Null when the account row cannot be read (gone, or not this owner's),
 * never for an empty ledger, which is a debt of the opening balance.
 */
export async function datedLoanDebts(
  m: EntityManager,
  loanAccount: { id: string; userId: string },
  asOfDates: readonly string[],
): Promise<ReadonlyMap<string, number> | null> {
  const dates = [...new Set(asOfDates)];
  if (dates.length === 0) return new Map();
  const rows: Array<{ as_of: string; balance: string | null }> = await m.query(
    ACCOUNT_BALANCES_AS_OF_DATES_SQL,
    [loanAccount.id, loanAccount.userId, dates],
  );
  if (rows.length === 0) return null;
  const debts = new Map<string, number>();
  for (const row of rows) {
    if (row.balance == null) return null;
    debts.set(row.as_of, debtFromBalance(row.balance));
  }
  for (const date of dates) {
    if (!debts.has(date)) return null;
  }
  return debts;
}

/** Debt accounts store the balance negative; a balance in credit reads as retired (0). */
function debtFromBalance(balance: string): number {
  return Math.max(0, -roundMoney(Number(balance)));
}
