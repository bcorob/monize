import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import type {
  EmailReceiptEnrichedBy,
  EmailReceiptLinkedComponent,
  EmailReceiptLinkedSettlement,
} from "./email-receipt.view";

/** Settlements a component's detail lists (newest first). */
export const MAX_LINKED_SETTLEMENTS = 20;

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * The components a settlement's parts joined, by part (linked receipts spec 5):
 * the link rows that name one. One parameterized, user-scoped query.
 */
export async function readLinkedComponents(
  m: EntityManager,
  userId: string,
  settlementId: string,
): Promise<EmailReceiptLinkedComponent[]> {
  const rows = returnedRows<{
    part_index: number;
    id: string;
    subject: string;
    effective_at: Date | string;
  }>(
    await m.query(
      `SELECT l.part_index, c.id, c.subject,
              COALESCE(c.original_sent_at, c.received_at) AS effective_at
         FROM email_receipt_links l
         JOIN email_receipts c
           ON c.id = l.component_receipt_id AND c.user_id = l.user_id
        WHERE l.user_id = $1
          AND l.settlement_receipt_id = $2
        ORDER BY l.part_index`,
      [userId, settlementId],
    ),
  );
  return rows.map((row) => ({
    partIndex: Number(row.part_index),
    receiptId: row.id,
    subject: row.subject,
    effectiveDate: iso(row.effective_at),
  }));
}

/**
 * The settlements whose link rows name this component, one entry per part,
 * newest first, at most `MAX_LINKED_SETTLEMENTS`. A numeric is read with
 * `Number` at the boundary (backend/CLAUDE.md).
 */
export async function readLinkedSettlements(
  m: EntityManager,
  userId: string,
  componentId: string,
): Promise<EmailReceiptLinkedSettlement[]> {
  const rows = returnedRows<{
    id: string;
    subject: string;
    effective_at: Date | string;
    part_amount: string | number;
    outcome: string;
    transaction_id: string | null;
  }>(
    await m.query(
      `SELECT s.id, s.subject,
              COALESCE(s.original_sent_at, s.received_at) AS effective_at,
              l.part_amount, l.outcome, s.transaction_id
         FROM email_receipt_links l
         JOIN email_receipts s
           ON s.id = l.settlement_receipt_id AND s.user_id = l.user_id
        WHERE l.user_id = $1
          AND l.component_receipt_id = $2
        ORDER BY COALESCE(s.original_sent_at, s.received_at) DESC, s.id DESC,
                 l.part_index ASC
        LIMIT $3`,
      [userId, componentId, MAX_LINKED_SETTLEMENTS],
    ),
  );
  return rows.map((row) => ({
    receiptId: row.id,
    subject: row.subject,
    effectiveDate: iso(row.effective_at),
    partAmount: Number(row.part_amount),
    outcome: row.outcome,
    transactionId: row.transaction_id,
  }));
}

/**
 * The email whose applied email-receipt request sits on this transaction (the
 * newest one, as the matcher reads it): who enriched the transaction a
 * settlement stopped at (`enriched_by_other`). Null when none is found.
 */
export async function readEnrichedBy(
  m: EntityManager,
  userId: string,
  transactionId: string,
): Promise<EmailReceiptEnrichedBy | null> {
  const rows = returnedRows<{ id: string; subject: string }>(
    await m.query(
      `SELECT e.id, e.subject
         FROM ai_review_requests applied
         JOIN email_receipts e
           ON e.id = applied.email_receipt_id AND e.user_id = applied.user_id
        WHERE applied.user_id = $1
          AND applied.transaction_id = $2
          AND applied.kind = 'email_receipt'
          AND applied.status = 'applied'
        ORDER BY applied.updated_at DESC, applied.id DESC
        LIMIT 1`,
      [userId, transactionId],
    ),
  );
  return rows[0] ? { receiptId: rows[0].id, subject: rows[0].subject } : null;
}
