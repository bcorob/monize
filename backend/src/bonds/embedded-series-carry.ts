import { EntityManager } from "typeorm";

/**
 * The bond series of the investment rows embedded in a split parent, read
 * before an edit of the parent tears them down and recreates them
 * (`TransactionSplitService.updateSplits`, `TransactionsService.update`).
 *
 * A recreated row is a new row, but not a new decision: when the incoming split
 * does not name a series, the row that is the same split keeps the series (or the
 * NULL) its predecessor had, so a parent-only edit never asks for a series, and
 * never re-infers one, for a row it did not change (INV-BOND-007).
 *
 * The rule, as far as the schema allows. A split stores no position among its
 * parent's splits, so "the same split" is matched on what the row is: the same
 * security, action, quantity and date (the parent's), consumed first come first
 * served in ascending id order, so rows that look alike are paired
 * deterministically and each predecessor is used once. A row with no match (a new
 * split, or one whose security, action, quantity or date changed) is a new
 * decision and is resolved like any write. A series the incoming split names
 * wins; the carried one is only the default.
 */
export interface EmbeddedSeriesCarry {
  readonly securityId: string | null;
  readonly action: string;
  readonly quantity: number;
  /** YYYY-MM-DD. */
  readonly transactionDate: string;
  readonly bondInstrumentId: string | null;
}

/**
 * The parent's embedded investment rows with their stored series, in ascending
 * id order. Reads only; call it BEFORE the rows are removed.
 */
export async function readEmbeddedSeriesCarry(
  m: EntityManager,
  userId: string,
  parentTransactionId: string,
): Promise<EmbeddedSeriesCarry[]> {
  // includes VOID: a record read -- a VOID parent's embedded rows are rebuilt
  // VOID with the parent, and keep their series too.
  const rows: Array<{
    security_id: string | null;
    action: string;
    quantity: string | null;
    tx_date: string;
    bond_instrument_id: string | null;
  }> = await m.query(
    `SELECT it.security_id,
            it.action::text AS action,
            it.quantity::text AS quantity,
            TO_CHAR(it.transaction_date, 'YYYY-MM-DD') AS tx_date,
            it.bond_instrument_id
       FROM investment_transactions it
       JOIN transaction_splits ts ON ts.id = it.transaction_split_id
      WHERE ts.transaction_id = $1 AND it.user_id = $2
      ORDER BY it.id`,
    [parentTransactionId, userId],
  );
  return rows.map((r) => ({
    securityId: r.security_id,
    action: r.action,
    quantity: Number(r.quantity ?? 0),
    transactionDate: r.tx_date,
    bondInstrumentId: r.bond_instrument_id,
  }));
}

/**
 * Removes and returns the predecessor of an incoming embedded row from `pool`,
 * or null when none matches (see the rule above). Mutates `pool`, which the
 * caller owns for one rebuild.
 */
export function takeCarriedSeries(
  pool: EmbeddedSeriesCarry[],
  incoming: {
    readonly securityId?: string | null;
    readonly action: string;
    readonly quantity?: number | null;
    readonly transactionDate: string;
  },
): EmbeddedSeriesCarry | null {
  const index = pool.findIndex(
    (c) =>
      (c.securityId ?? null) === (incoming.securityId ?? null) &&
      c.action === incoming.action &&
      c.quantity === Number(incoming.quantity ?? 0) &&
      c.transactionDate === incoming.transactionDate.slice(0, 10),
  );
  return index < 0 ? null : pool.splice(index, 1)[0];
}
