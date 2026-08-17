import { Not } from "typeorm";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";

/**
 * The one predicate for "does this investment row's effect count".
 *
 * A VOID investment transaction records something that did not happen: it
 * moves no shares, no cost basis and no cash, on every surface at once
 * (docs/specs/investment-transaction-status.md). Every reader of
 * investment_transactions therefore decides whether it reads ROWS AS RECORDS
 * (the register list, row counts, delete guards, backup export -- VOID rows
 * included, because a VOID row is still a row) or ROWS AS EFFECTS (share
 * replays, cost basis, realized/capital gains, valuations, net-worth history,
 * cash projections -- VOID rows excluded).
 *
 * Effects readers use one of these three forms; records readers say so with an
 * `includes VOID` comment beside the query.
 * `investment-void-classification.guard.spec.ts` fails on a query site that
 * does neither, so a new reader cannot skip the decision.
 *
 * The column is NOT NULL (migration 157), so `!= 'VOID'` needs no NULL arm.
 */
export const NON_VOID_INVESTMENT_STATUS = Not(TransactionStatus.VOID);

/** SQL fragment for raw queries: `alias` is the investment_transactions alias. */
export function investmentEffectStatusSql(alias: string): string {
  return `${alias}.status != 'VOID'`;
}

/** In-memory filter for rows already loaded as records. */
export function investmentRowHasEffect(row: {
  status?: TransactionStatus | string | null;
}): boolean {
  return row.status !== TransactionStatus.VOID;
}
