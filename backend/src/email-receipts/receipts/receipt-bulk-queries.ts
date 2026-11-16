import { BadRequestException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { tr } from "../../i18n/translate";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";
import {
  EMAIL_RECEIPTS_APPROVABLE_MAX,
  EMAIL_RECEIPTS_BULK_MAX_MATCHES,
} from "./dto/email-receipts.dto";
import type { ReceiptBulkTarget } from "./receipt-bulk";
import { receiptSelectionClause } from "./receipt-filter";

/**
 * The reads behind the bulk count, reprocess and approval listing. Each one
 * renders the target through `receiptSelectionClause`, the predicate the bulk
 * delete / ignore locks its rows with, so the number shown is the number acted on.
 */

const REQUEST_JOIN = `LEFT JOIN ai_review_requests rq
                    ON rq.id = r.ai_review_request_id AND rq.user_id = r.user_id`;

/** `$1` is the user; the target's own bind values start at `$firstIndex`. */
function targetClause(
  target: ReceiptBulkTarget,
  firstIndex: number,
): { sql: string; params: unknown[] } {
  if ("ids" in target) {
    return {
      sql: `r.id = ANY($${firstIndex}::uuid[])`,
      params: [[...target.ids]],
    };
  }
  return receiptSelectionClause(target.filter, firstIndex);
}

/** How many emails a filter selects, counted up to `EMAIL_RECEIPTS_BULK_MAX_MATCHES + 1`. */
export async function countSelected(
  m: EntityManager,
  userId: string,
  filter: Extract<ReceiptBulkTarget, { filter: unknown }>["filter"],
): Promise<number> {
  const selection = receiptSelectionClause(filter, 3);
  const [row] = returnedRows<{ count: number | string }>(
    await m.query(
      `SELECT COUNT(*)::int AS count
         FROM (SELECT 1
                 FROM email_receipts r
                WHERE r.user_id = $1
                  AND ${selection.sql}
                LIMIT $2) selected`,
      [userId, EMAIL_RECEIPTS_BULK_MAX_MATCHES + 1, ...selection.params],
    ),
  );
  return Number(row?.count ?? 0);
}

/** The database's instant a reprocess run counts from: the caller's `since`, never later than now. */
export async function reprocessSince(
  m: EntityManager,
  since: string | undefined,
): Promise<string> {
  const [stamp] = returnedRows<{ since: string }>(
    await m.query(
      `SELECT TO_CHAR(
                LEAST(COALESCE($1::timestamptz, CURRENT_TIMESTAMP),
                      CURRENT_TIMESTAMP) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since`,
      [since ?? null],
    ),
  );
  return stamp.since;
}

const NOT_YET_REPROCESSED = `r.status NOT IN ('skipped', 'pending')
              AND rq.status IS DISTINCT FROM 'applied'
              AND (cardinality($2::varchar[]) = 0 OR r.status = ANY($2::varchar[]))
              AND r.updated_at < $3::timestamptz`;

interface ReprocessOptions {
  onlyStatuses: readonly EmailReceiptStatus[];
  since: string;
}

/**
 * The emails a reprocess run can still take: in the target, not `skipped` and not
 * `pending`, no applied request, in `onlyStatuses` when given, and not updated
 * since `since`. Oldest first, at most `limit`.
 */
export async function reprocessCandidates(
  m: EntityManager,
  userId: string,
  target: ReceiptBulkTarget,
  options: ReprocessOptions & { limit: number },
): Promise<string[]> {
  const selection = targetClause(target, 4);
  const rows = returnedRows<{ id: string }>(
    await m.query(
      `SELECT r.id
         FROM email_receipts r ${REQUEST_JOIN}
        WHERE r.user_id = $1
          AND ${selection.sql}
          AND ${NOT_YET_REPROCESSED}
        ORDER BY r.received_at ASC, r.id ASC
        LIMIT $${selection.params.length + 4}`,
      [
        userId,
        [...options.onlyStatuses],
        options.since,
        ...selection.params,
        options.limit,
      ],
    ),
  );
  return rows.map((row) => row.id);
}

/** How many emails of the target a reprocess run has not touched yet (same predicate as `reprocessCandidates`). */
export async function reprocessRemaining(
  m: EntityManager,
  userId: string,
  target: ReceiptBulkTarget,
  options: ReprocessOptions,
): Promise<number> {
  const selection = targetClause(target, 4);
  const [row] = returnedRows<{ remaining: number | string }>(
    await m.query(
      `SELECT COUNT(*)::int AS remaining
         FROM email_receipts r ${REQUEST_JOIN}
        WHERE r.user_id = $1
          AND ${selection.sql}
          AND ${NOT_YET_REPROCESSED}`,
      [userId, [...options.onlyStatuses], options.since, ...selection.params],
    ),
  );
  return Number(row?.remaining ?? 0);
}

/**
 * The requests a bulk approval would send: every selected non-trade email in
 * `review` whose request is `proposed` and not expired. `trades` counts the
 * selected trade emails with such a proposal that are left out (a trade is
 * approved from its card in the review inbox). More requests than
 * `EMAIL_RECEIPTS_APPROVABLE_MAX` is a 400 asking to narrow the selection.
 */
export async function approvableRequests(
  m: EntityManager,
  userId: string,
  target: ReceiptBulkTarget,
): Promise<{ requestIds: string[]; trades: number }> {
  const selection = targetClause(target, 2);
  const proposed = `FROM email_receipts r
         JOIN ai_review_requests rq
           ON rq.id = r.ai_review_request_id AND rq.user_id = r.user_id
        WHERE r.user_id = $1
          AND ${selection.sql}
          AND r.status = 'review'
          AND rq.status = 'proposed'
          AND rq.expires_at > CURRENT_TIMESTAMP`;
  const isTrade = `(r.trade IS NOT NULL OR rq.kind = 'email_trade')`;
  const rows = returnedRows<{ request_id: string }>(
    await m.query(
      `SELECT rq.id AS request_id
         ${proposed}
          AND NOT ${isTrade}
        ORDER BY r.received_at ASC, r.id ASC
        LIMIT $${selection.params.length + 2}`,
      [userId, ...selection.params, EMAIL_RECEIPTS_APPROVABLE_MAX + 1],
    ),
  );
  if (rows.length > EMAIL_RECEIPTS_APPROVABLE_MAX) {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.bulkTooManyApprovable",
        "More than {{ max }} proposals match. Narrow the selection, for example by choosing a sender domain or a date range, and try again.",
        { max: EMAIL_RECEIPTS_APPROVABLE_MAX },
      ),
    );
  }
  const [tradeRow] = returnedRows<{ trades: number | string }>(
    await m.query(
      `SELECT COUNT(*)::int AS trades
         ${proposed}
          AND ${isTrade}`,
      [userId, ...selection.params],
    ),
  );
  return {
    requestIds: rows.map((row) => row.request_id),
    trades: Number(tradeRow?.trades ?? 0),
  };
}
