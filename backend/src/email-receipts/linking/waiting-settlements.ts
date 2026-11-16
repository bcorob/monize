import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";

/** The most settlements one component's arrival looks up (linked receipts spec 8). */
export const MAX_WAITING_SETTLEMENTS = 20;

/** A settlement receipt with a link row that waits for a link value. */
export interface WaitingSettlement {
  id: string;
  subject: string;
  /** `YYYY-MM-DD` (UTC): `original_sent_at ?? received_at`. */
  effectiveDate: string;
}

/**
 * The settlements with a part waiting for this link value (a link row with the
 * value and no component), newest first, at most `limit` (spec 8). The one
 * query behind the pipeline's re-join after a component is stored and the dry
 * run's `waitingSettlements`. Reads only: no row lock.
 */
export async function waitingSettlements(
  m: EntityManager,
  userId: string,
  componentId: string,
  linkKey: string,
  limit: number = MAX_WAITING_SETTLEMENTS,
): Promise<WaitingSettlement[]> {
  const rows = returnedRows<{
    id: string;
    subject: string;
    effective_date: string;
  }>(
    await m.query(
      `SELECT s.id, s.subject,
              TO_CHAR((COALESCE(s.original_sent_at, s.received_at) AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS effective_date
         FROM email_receipts s
        WHERE s.user_id = $1
          AND s.id <> $2
          AND EXISTS (SELECT 1
                        FROM email_receipt_links l
                       WHERE l.settlement_receipt_id = s.id
                         AND l.user_id = $1
                         AND l.link_value = $3
                         AND l.component_receipt_id IS NULL)
        ORDER BY COALESCE(s.original_sent_at, s.received_at) DESC, s.id DESC
        LIMIT $4`,
      [userId, componentId, linkKey, limit],
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    effectiveDate: row.effective_date,
  }));
}
