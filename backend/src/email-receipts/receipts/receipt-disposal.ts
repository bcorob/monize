import { ConflictException, NotFoundException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { tr } from "../../i18n/translate";
import { EmailReceipt } from "../entities/email-receipt.entity";
import { removeLinkRows } from "../linking/link-rows";
import {
  closeReceiptRequests,
  currentReceiptRequestStatus,
  lockReceiptTransaction,
} from "../pipeline/receipt-requests.util";

/**
 * Ignoring and deleting one stored email, inside the caller's transaction:
 * the single actions (`EmailReceiptsService.ignore` / `remove`) and the
 * profile's bulk ones (`EmailReceiptProfileBatchService`) run the same steps,
 * so the two cannot drift. Each takes the email under its row lock first.
 */

export function receiptNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr("errors.emailReceipts.receiptNotFound", `Email ${id} not found`, { id }),
  );
}

/** The email, locked for the rest of the transaction; null when the user has none by that id. */
export function lockReceipt(
  m: EntityManager,
  userId: string,
  id: string,
): Promise<EmailReceipt | null> {
  return m.getRepository(EmailReceipt).findOne({
    where: { id, userId },
    lock: { mode: "pessimistic_write" },
  });
}

/** Whether the email's proposal was already applied to a transaction. */
export async function receiptApplied(
  m: EntityManager,
  userId: string,
  receipt: EmailReceipt,
): Promise<boolean> {
  return (
    (await currentReceiptRequestStatus(
      m,
      userId,
      receipt.aiReviewRequestId,
    )) === "applied"
  );
}

export const receiptAppliedConflict = (): ConflictException =>
  new ConflictException(
    tr(
      "errors.emailReceipts.receiptApplied",
      "This email's proposal has already been applied to a transaction.",
    ),
  );

export const receiptSkippedConflict = (): ConflictException =>
  new ConflictException(
    tr(
      "errors.emailReceipts.receiptSkipped",
      "This email could not be read (it was too large or could not be decoded), so there is nothing to process.",
    ),
  );

/**
 * Mark a locked email ignored: its open request is closed, its link rows are
 * deleted and it proposes nothing. The caller has refused an email that was skipped or applied.
 */
export async function ignoreLockedReceipt(
  m: EntityManager,
  userId: string,
  receipt: EmailReceipt,
): Promise<void> {
  if (receipt.transactionId) {
    await lockReceiptTransaction(m, receipt.transactionId);
  }
  await closeReceiptRequests(m, userId, receipt.id);
  // An ignored settlement takes nothing from a component (linked receipts spec 5).
  await removeLinkRows(m, userId, [receipt.id]);
  await m.getRepository(EmailReceipt).update(
    { id: receipt.id, userId },
    {
      status: "ignored",
      statusReason: null,
      aiReviewRequestId: null,
      linkKey: null,
    },
  );
}

/** Delete a locked email; its open request is dismissed in the same transaction. */
export async function deleteLockedReceipt(
  m: EntityManager,
  userId: string,
  receipt: EmailReceipt,
): Promise<void> {
  if (receipt.transactionId) {
    await lockReceiptTransaction(m, receipt.transactionId);
  }
  await closeReceiptRequests(m, userId, receipt.id);
  // The rows go through the helper first, so a component only this settlement
  // used falls back to awaiting_settlement (the cascade would leave its reason).
  await removeLinkRows(m, userId, [receipt.id]);
  await m.getRepository(EmailReceipt).delete({ id: receipt.id, userId });
}
