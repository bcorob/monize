import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import type {
  ReceiptLinkOutcome,
  ReceiptLinkReport,
} from "../parsing/receipt-parser.types";

const UNITS_PER_MONEY = 10000;

/** One `email_receipt_links` row to write; `partAmount` in 1/10000 units. */
export interface LinkRowInput {
  partIndex: number;
  link: string | null;
  partAmount: number;
  /** Set only for a `joined` or `scaled` part. */
  componentReceiptId: string | null;
  outcome: ReceiptLinkOutcome;
}

/** The link rows of a joined settlement's reports (spec 5): the component only for `joined` and `scaled`. */
export function linkRowsOf(
  reports: readonly ReceiptLinkReport[],
): LinkRowInput[] {
  return reports.map((report) => ({
    partIndex: report.partIndex,
    link: report.link,
    partAmount: report.partAmount,
    componentReceiptId:
      report.outcome === "joined" || report.outcome === "scaled"
        ? report.componentReceiptId
        : null,
    outcome: report.outcome,
  }));
}

/** Integer units as an exact decimal string (`12345` -> `1.2345`): no float is accumulated. */
export function unitsToDecimal(units: number): string {
  const negative = units < 0;
  const abs = Math.abs(Math.round(units));
  const whole = Math.floor(abs / UNITS_PER_MONEY);
  const fraction = String(abs % UNITS_PER_MONEY).padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** The reason of a component no settlement row names any more (spec 2.1). */
const AWAITING_SETTLEMENT = "awaiting_settlement";

/**
 * Delete the link rows of these settlements and return the components they
 * named. The caller holds the settlements' row locks and then calls
 * `resetOrphanedComponents` with the result once its own rows are written.
 */
async function deleteLinkRows(
  m: EntityManager,
  userId: string,
  settlementReceiptIds: readonly string[],
): Promise<string[]> {
  const rows = returnedRows<{ component_receipt_id: string | null }>(
    await m.query(
      `DELETE FROM email_receipt_links
        WHERE settlement_receipt_id = ANY($1::uuid[]) AND user_id = $2
    RETURNING component_receipt_id`,
      [[...settlementReceiptIds], userId],
    ),
  );
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.component_receipt_id === null ? [] : [row.component_receipt_id],
      ),
    ),
  ];
}

/**
 * A component that no row of any settlement names any more is
 * `awaiting_settlement` again (spec 2.1); one that another settlement still
 * names keeps the reason it has, which that settlement's own join set (an
 * instalment may then read `settled` although part of it was released: the
 * next join of that settlement corrects it). The rows are locked in ascending
 * id, as every writer of component rows does (spec 11).
 */
async function resetOrphanedComponents(
  m: EntityManager,
  userId: string,
  componentIds: readonly string[],
): Promise<void> {
  if (componentIds.length === 0) return;
  await m.query(
    `WITH locked AS (
       SELECT r.id
         FROM email_receipts r
        WHERE r.user_id = $1
          AND r.id = ANY($2::uuid[])
          AND r.status = 'component'
          AND r.status_reason IS DISTINCT FROM $3::varchar
          AND NOT EXISTS (SELECT 1
                            FROM email_receipt_links l
                           WHERE l.component_receipt_id = r.id
                             AND l.user_id = $1)
        ORDER BY r.id
          FOR UPDATE OF r)
     UPDATE email_receipts SET status_reason = $3::varchar
      WHERE id IN (SELECT id FROM locked)`,
    [userId, [...componentIds], AWAITING_SETTLEMENT],
  );
}

/**
 * Remove the link rows of settlements that are ignored or deleted (spec 5), and
 * give back the components they alone used. Call it BEFORE the receipt rows are
 * deleted.
 */
export async function removeLinkRows(
  m: EntityManager,
  userId: string,
  settlementReceiptIds: readonly string[],
): Promise<void> {
  await resetOrphanedComponents(
    m,
    userId,
    await deleteLinkRows(m, userId, settlementReceiptIds),
  );
}

/**
 * Replace the rows of a settlement (spec 5): delete, then one multi-row insert,
 * then the components it no longer names fall back to `awaiting_settlement`.
 * `rows` undefined or empty leaves the settlement with none, which is what an
 * outcome that never reached the join stores.
 */
export async function replaceLinkRows(
  m: EntityManager,
  userId: string,
  settlementReceiptId: string,
  rows: readonly LinkRowInput[] | undefined,
): Promise<void> {
  const previous = await deleteLinkRows(m, userId, [settlementReceiptId]);
  if (rows && rows.length > 0) {
    await insertLinkRows(m, userId, settlementReceiptId, rows);
  }
  await resetOrphanedComponents(m, userId, previous);
}

async function insertLinkRows(
  m: EntityManager,
  userId: string,
  settlementReceiptId: string,
  rows: readonly LinkRowInput[],
): Promise<void> {
  const values: unknown[] = [userId, settlementReceiptId];
  const tuples = rows.map((row) => {
    const base = values.length;
    values.push(
      row.partIndex,
      row.link,
      unitsToDecimal(row.partAmount),
      row.componentReceiptId,
      row.outcome,
    );
    return `($1, $2, $${base + 1}, $${base + 2}, $${base + 3}::numeric, $${base + 4}, $${base + 5})`;
  });
  await m.query(
    `INSERT INTO email_receipt_links
       (user_id, settlement_receipt_id, part_index, link_value, part_amount,
        component_receipt_id, outcome)
     VALUES ${tuples.join(", ")}`,
    values,
  );
}
