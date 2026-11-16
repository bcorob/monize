import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/ai-attachments';
import type { EmailReceiptDetail } from '@/types/email-receipts';

/**
 * The order email as the text file the assistant's chat takes as an attachment
 * (`text/plain`, at most `MAX_ATTACHMENT_BYTES`, at most `MAX_ATTACHMENTS` files
 * and `MAX_TOTAL_ATTACHMENT_BYTES` together). The header is the facts the
 * assistant should not have to guess (sender, subject, date, and the email's id
 * when several are attached); the body is the email's stored text, which the
 * server already converted from HTML.
 *
 * The file is data the assistant reads, never an instruction; the chat message
 * that goes with it is the user's own words, staged for them to send.
 */

/** Bytes a character can take in UTF-8, at most. */
const MAX_BYTES_PER_CHAR = 4;
/** Room kept for the header lines of a file (an address and a subject can be 4-byte characters too). */
const HEADER_BYTES = 8_000;

type AttachableEmail = Pick<EmailReceiptDetail, 'fromAddress' | 'subject' | 'receivedAt' | 'bodyText'> &
  Partial<Pick<EmailReceiptDetail, 'id' | 'effectiveDate' | 'forwardedBy'>>;

/** Characters of body kept for one file out of `count`: a character is at most 4 bytes, so the caps hold in bytes. */
export function maxBodyChars(count = 1): number {
  const perFile = Math.min(MAX_ATTACHMENT_BYTES, Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / Math.max(1, count)));
  return Math.floor((perFile - HEADER_BYTES) / MAX_BYTES_PER_CHAR);
}

export function receiptAttachmentName(date: string, position?: number): string {
  const day = date.slice(0, 10);
  return position === undefined ? `order-email-${day}.txt` : `order-email-${position}-${day}.txt`;
}

function buildFile(email: AttachableEmail, name: string, count: number, withId: boolean): File {
  const limit = maxBodyChars(count);
  const body = email.bodyText.length > limit ? email.bodyText.slice(0, limit) : email.bodyText;
  const date = email.effectiveDate ?? email.receivedAt;
  const text = [
    ...(withId && email.id ? [`Id: ${email.id}`] : []),
    `From: ${email.fromAddress}`,
    ...(email.forwardedBy ? [`Forwarded by: ${email.forwardedBy}`] : []),
    `Subject: ${email.subject}`,
    `Date: ${date}`,
    '',
    body,
    '',
  ].join('\n');
  return new File([text], name, { type: 'text/plain' });
}

export function buildReceiptAttachment(email: AttachableEmail): File {
  return buildFile(email, receiptAttachmentName(email.effectiveDate ?? email.receivedAt), 1, false);
}

/**
 * One text file per email for "Draft parser with AI": at most `MAX_ATTACHMENTS`
 * (the chat's own cap), each named by its position and day so two emails of one
 * day do not collide, each carrying the email's id (the assistant tests its
 * parser on stored emails by id) and cut so all of them together stay within the
 * chat's total attachment size.
 */
export function buildParserDraftAttachments(emails: readonly AttachableEmail[]): File[] {
  const chosen = emails.slice(0, MAX_ATTACHMENTS);
  return chosen.map((email, index) =>
    buildFile(email, receiptAttachmentName(email.effectiveDate ?? email.receivedAt, index + 1), chosen.length, true),
  );
}
