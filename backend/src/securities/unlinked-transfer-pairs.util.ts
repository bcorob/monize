/**
 * Two legs of one share transfer that the ledger never paired.
 *
 * `transferSecurity` writes `linked_transaction_id` on both rows it creates, and
 * the cost-basis replay matches on exactly that: an unpaired `TRANSFER_IN`
 * cannot take the basis its source released, so the destination position
 * reports `transferred_basis_unknown` and the reader loses the gain on it
 * (`portfolio-calculation.service.ts`). Rows that arrived by import were
 * written independently and carry no pairing at all.
 *
 * What this finds is a CANDIDATE, never a conclusion. Two legs on one day, of
 * one security, for the same number of shares, in opposite directions, on two
 * accounts of the portfolio, neither already paired: that is strong evidence of
 * one transfer recorded twice, and it is still a person's call. Nothing here
 * writes, and no measure consults it -- inferring the pairing inside a
 * valuation would be a guess wearing a figure's clothes.
 *
 * The pair is matched on ABSOLUTE quantity because a leg's sign is its
 * action's, not its number's: `TRANSFER_OUT` and `REMOVE_SHARES` are both
 * recorded with a positive quantity.
 */
import { investmentEffectStatusSql } from "./investment-row-effects.util";

/** One candidate, both legs named, as the query returns it. */
export interface UnlinkedTransferPair {
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  transactionDate: string;
  quantity: number;
  /** The leg that released the shares. */
  out: { transactionId: string; accountId: string; accountName: string };
  /** The leg that received them. */
  in: { transactionId: string; accountId: string; accountName: string };
}

/**
 * The pairs of actions that make one transfer. An `ADD_SHARES` answers a
 * `REMOVE_SHARES` for the same reason a `TRANSFER_IN` answers a
 * `TRANSFER_OUT`: one ledger's units left and another's arrived.
 */
export const TRANSFER_LEG_PAIRS: ReadonlyArray<[string, string]> = [
  ["TRANSFER_OUT", "TRANSFER_IN"],
  ["REMOVE_SHARES", "ADD_SHARES"],
];

/**
 * The SQL for one candidate read. Exported so a spec can assert the predicate
 * and the bindings without a database.
 *
 * `$1` is the user, `$2` the accounts of the portfolio scope. The join is
 * one-directional -- the OUT leg on the left -- so a pair is returned once
 * rather than twice, and `a.id < b.id` is not needed for that.
 */
export function unlinkedTransferPairsSql(): string {
  const pairs = TRANSFER_LEG_PAIRS.map(
    ([out, into]) => `(o.action = '${out}' AND i.action = '${into}')`,
  ).join("\n                 OR ");

  return `SELECT o.security_id AS security_id,
                 s.symbol AS symbol,
                 s.name AS security_name,
                 TO_CHAR(o.transaction_date, 'YYYY-MM-DD') AS transaction_date,
                 ABS(o.quantity) AS quantity,
                 o.id AS out_transaction_id,
                 o.account_id AS out_account_id,
                 oa.name AS out_account_name,
                 i.id AS in_transaction_id,
                 i.account_id AS in_account_id,
                 ia.name AS in_account_name
            FROM investment_transactions o
            JOIN investment_transactions i
              ON i.user_id = o.user_id
             AND i.security_id = o.security_id
             AND i.transaction_date = o.transaction_date
             AND ABS(i.quantity) = ABS(o.quantity)
             AND i.account_id <> o.account_id
             AND (${pairs})
            JOIN accounts oa ON oa.id = o.account_id
            JOIN accounts ia ON ia.id = i.account_id
            LEFT JOIN securities s ON s.id = o.security_id
           WHERE o.user_id = $1
             AND o.account_id = ANY($2::UUID[])
             AND i.account_id = ANY($2::UUID[])
             AND o.security_id IS NOT NULL
             AND COALESCE(o.quantity, 0) <> 0
             -- Rows as EFFECTS on both legs: renders o.status != 'VOID' and
             -- i.status != 'VOID', because a void row recorded something that
             -- did not happen and cannot be half of a transfer.
             AND ${investmentEffectStatusSql("o")}
             AND ${investmentEffectStatusSql("i")}
             -- Neither leg is already paired. A row pointing at a leg outside
             -- the scope is still paired: it is somebody's pairing, not ours
             -- to replace.
             AND o.linked_transaction_id IS NULL
             AND i.linked_transaction_id IS NULL
           ORDER BY o.transaction_date DESC, s.symbol, o.id`;
}

/** The driver's row shape, mapped at this boundary. */
export interface UnlinkedTransferPairRow {
  security_id: string;
  symbol: string | null;
  security_name: string | null;
  transaction_date: string;
  quantity: string | number;
  out_transaction_id: string;
  out_account_id: string;
  out_account_name: string;
  in_transaction_id: string;
  in_account_id: string;
  in_account_name: string;
}

export function toUnlinkedTransferPairs(
  rows: readonly UnlinkedTransferPairRow[],
): UnlinkedTransferPair[] {
  return rows.map((row) => ({
    securityId: row.security_id,
    symbol: row.symbol,
    securityName: row.security_name,
    transactionDate: row.transaction_date,
    quantity: Number(row.quantity) || 0,
    out: {
      transactionId: row.out_transaction_id,
      accountId: row.out_account_id,
      accountName: row.out_account_name,
    },
    in: {
      transactionId: row.in_transaction_id,
      accountId: row.in_account_id,
      accountName: row.in_account_name,
    },
  }));
}
