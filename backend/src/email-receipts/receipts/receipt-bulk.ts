import { BadRequestException, ConflictException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { tr } from "../../i18n/translate";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";
import { removeLinkRows } from "../linking/link-rows";
import { closeRequestsOfReceipts } from "../pipeline/receipt-requests.util";
import {
  EMAIL_RECEIPTS_BULK_MAX_IDS,
  EMAIL_RECEIPTS_BULK_MAX_MATCHES,
} from "./dto/email-receipts.dto";
import type { EmailReceiptBulkAction } from "./dto/email-receipts.dto";
import { receiptSelectionClause } from "./receipt-filter";
import type { ReceiptSelectionFilter } from "./receipt-filter";

/** Which emails a bulk command names: by id, or by the list's own filter. */
export type ReceiptBulkTarget =
  { ids: readonly string[] } | { filter: ReceiptSelectionFilter };

/** What a bulk command did; the four counts partition the matching emails. */
export interface ReceiptBulkResult {
  /** Emails deleted, or turned to `ignored`. */
  affected: number;
  /** Emails linked to a transaction: a bulk command never touches them. */
  skippedLinked: number;
  /** Ignore only: emails that were already ignored. */
  unchanged: number;
  /** Ignore only: emails that cannot be ignored (unreadable, or a proposal already applied). */
  notIgnorable: number;
}

interface LockedRow {
  id: string;
  status: EmailReceiptStatus;
  transaction_id: string | null;
  request_status: string | null;
}

/** The answer of a request whose count no longer matches: nothing was written. */
export function receiptBulkCountChanged(
  currentCount: number,
  expectedCount: number,
): ConflictException {
  return new ConflictException({
    message: tr(
      "errors.emailReceipts.bulkCountChanged",
      "The number of matching emails changed from {{ expected }} to {{ current }}. Nothing was changed. Check the new number and try again.",
      { expected: expectedCount, current: currentCount },
    ),
    errorCode: "EMAIL_RECEIPTS_BULK_COUNT_CHANGED",
    currentCount,
  });
}

/** Refuses, before anything is read, a target that names more ids than one request may. */
export function refuseTooManyIds(target: ReceiptBulkTarget): void {
  if ("ids" in target && target.ids.length > EMAIL_RECEIPTS_BULK_MAX_IDS) {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.bulkTooManyIds",
        "At most {{ max }} emails can be chosen one by one. Select fewer emails, or select all that match the filter.",
        { max: EMAIL_RECEIPTS_BULK_MAX_IDS },
      ),
    );
  }
}

/**
 * Delete or ignore many of one user's emails in the caller's transaction
 * (`withScopedDb`). Every check that can refuse runs before the first write:
 * the matching rows are read FOR UPDATE (ascending id, so two bulk commands
 * queue rather than deadlock), their number is compared with what the person was
 * told, and only then are their open requests closed and the rows written, each
 * in one set-based statement keyed on the user as well as the ids.
 *
 * A row linked to a transaction is skipped and counted. For `ignore` a row
 * already ignored is `unchanged`, and one `ignore()` refuses (`skipped`, or a
 * proposal already applied) is `notIgnorable`.
 */
export async function bulkActOnReceipts(
  m: EntityManager,
  userId: string,
  action: EmailReceiptBulkAction,
  target: ReceiptBulkTarget,
  expectedCount: number,
): Promise<ReceiptBulkResult> {
  refuseTooManyIds(target);
  const rows = await lockMatchingRows(m, userId, target);
  if (rows.length > EMAIL_RECEIPTS_BULK_MAX_MATCHES) {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.bulkTooManyMatches",
        "More than {{ max }} emails match. Narrow the filter, for example by choosing a state or a sender domain, and try again.",
        { max: EMAIL_RECEIPTS_BULK_MAX_MATCHES },
      ),
    );
  }
  if (rows.length !== expectedCount) {
    throw receiptBulkCountChanged(rows.length, expectedCount);
  }

  const result: ReceiptBulkResult = {
    affected: 0,
    skippedLinked: 0,
    unchanged: 0,
    notIgnorable: 0,
  };
  const targets: string[] = [];
  for (const row of rows) {
    if (row.transaction_id !== null) {
      result.skippedLinked++;
    } else if (action === "ignore" && row.status === "ignored") {
      result.unchanged++;
    } else if (
      action === "ignore" &&
      (row.status === "skipped" || row.request_status === "applied")
    ) {
      result.notIgnorable++;
    } else {
      targets.push(row.id);
    }
  }
  if (targets.length === 0) return result;

  await closeRequestsOfReceipts(m, userId, targets);
  // An ignored or deleted settlement takes nothing from a component (linked
  // receipts spec 5); the rows go first, so a component only they used falls back
  // to awaiting_settlement.
  await removeLinkRows(m, userId, targets);
  const written =
    action === "delete"
      ? returnedRows<{ id: string }>(
          await m.query(
            `DELETE FROM email_receipts
              WHERE id = ANY($1::uuid[])
                AND user_id = $2
                AND transaction_id IS NULL
          RETURNING id`,
            [targets, userId],
          ),
        )
      : returnedRows<{ id: string }>(
          await m.query(
            `UPDATE email_receipts
                SET status = 'ignored', status_reason = NULL,
                    ai_review_request_id = NULL, link_key = NULL
              WHERE id = ANY($1::uuid[])
                AND user_id = $2
                AND transaction_id IS NULL
          RETURNING id`,
            [targets, userId],
          ),
        );
  result.affected = written.length;
  return result;
}

/**
 * The target's rows, locked. A filter reads the list's own predicate
 * (`receiptSelectionClause`) and takes one row past the limit, so a request that
 * matches too many is refused without reading them all.
 */
async function lockMatchingRows(
  m: EntityManager,
  userId: string,
  target: ReceiptBulkTarget,
): Promise<LockedRow[]> {
  const select = `SELECT r.id, r.status, r.transaction_id, rq.status AS request_status
             FROM email_receipts r
             LEFT JOIN ai_review_requests rq
                    ON rq.id = r.ai_review_request_id AND rq.user_id = r.user_id`;
  if ("ids" in target) {
    return returnedRows<LockedRow>(
      await m.query(
        `${select}
            WHERE r.user_id = $1
              AND r.id = ANY($2::uuid[])
            ORDER BY r.id
              FOR UPDATE OF r`,
        [userId, [...target.ids]],
      ),
    );
  }
  const selection = receiptSelectionClause(target.filter, 3);
  return returnedRows<LockedRow>(
    await m.query(
      `${select}
          WHERE r.user_id = $1
            AND ${selection.sql}
          ORDER BY r.id
          LIMIT $2
            FOR UPDATE OF r`,
      [userId, EMAIL_RECEIPTS_BULK_MAX_MATCHES + 1, ...selection.params],
    ),
  );
}
