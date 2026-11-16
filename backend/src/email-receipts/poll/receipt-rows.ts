import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import {
  mayBeForwarded,
  resolveForwardedIdentity,
  type ReceiptIdentity,
} from "../imap/forwarded-receipt";
import {
  extractMailText,
  type ExtractedMailText,
} from "../imap/mail-text.util";

const DAY_MS = 86_400_000;

/** One `email_receipts` row as the poll and the archive import store it. */
export interface ReceiptRow {
  messageId: string | null;
  fromAddress: string;
  fromDomain: string;
  subject: string;
  receivedAt: Date;
  bodyText: string;
  bodyHtml: string | null;
  forwardedBy: string | null;
  originalSentAt: Date | null;
  uid: string;
  status: "pending" | "skipped";
  statusReason: "too_large" | "undecodable" | null;
}

/** What one insert pass did. `duplicates` are rows `ON CONFLICT` refused. */
export interface InsertReceiptRowsResult {
  stored: number;
  skipped: number;
  duplicates: number;
}

/**
 * When the email was written: its Date header when that is a real date no later
 * than a day from now (a forwarded order keeps the shop's date, which is what
 * the match window is about), else the server's own arrival time.
 */
export function pickReceivedAt(
  header: Date | null,
  internalDate: Date,
  now: Date,
): Date {
  if (header !== null && header.getTime() <= now.getTime() + DAY_MS) {
    return header;
  }
  return Number.isNaN(internalDate.getTime()) ? now : internalDate;
}

/** A message stored without a body: its identity is consumed, nothing is read. */
export function skippedRow(
  uid: string,
  reason: "too_large" | "undecodable",
  receivedAt: Date,
): ReceiptRow {
  return {
    messageId: null,
    fromAddress: "",
    fromDomain: "",
    subject: "",
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    bodyText: "",
    bodyHtml: null,
    forwardedBy: null,
    originalSentAt: null,
    uid,
    status: "skipped",
    statusReason: reason,
  };
}

/**
 * The one row builder of the poll and the archive import: the same text
 * extraction, forwarded-identity resolution and arrival time. `fallbackDate` is
 * the arrival time used when the Date header is missing or in the future (the
 * IMAP internal date, or an mbox separator date). `ownAddresses` reads the
 * owner's own addresses (`loadOwnAddresses`), asked only for a message whose
 * text holds a forwarded header block: only a forward from one of them is
 * stored as the shop's. A message that cannot be decoded becomes a `skipped`
 * row.
 */
export async function buildReceiptRow(
  source: Buffer,
  uid: string,
  fallbackDate: Date,
  now: Date,
  ownAddresses: () => Promise<ReadonlySet<string>>,
): Promise<ReceiptRow> {
  let mail: ExtractedMailText;
  let outer: ReceiptIdentity;
  let receivedAt: Date;
  let forwarded: boolean;
  try {
    mail = await extractMailText(source);
    receivedAt = pickReceivedAt(mail.date, fallbackDate, now);
    outer = {
      fromAddress: mail.fromAddress,
      fromDomain: mail.fromDomain,
      subject: mail.subject,
      forwardedBy: null,
      originalSentAt: null,
    };
    forwarded = mayBeForwarded(outer, mail.text);
  } catch {
    return skippedRow(uid, "undecodable", fallbackDate);
  }
  // Outside the catch: a failure to read the owner's addresses is the batch's
  // failure (nothing is stored, the cursor stays), never an undecodable message.
  const own = forwarded ? await ownAddresses() : null;
  // A forward from the user's own address: the shop, the subject and the day
  // it wrote come from the forwarded header block in the text, so the parser
  // is chosen by the shop and the match window is centred on the purchase.
  // Anyone else's pasted block is text: the email stays theirs (A26-H02).
  const identity =
    (own === null
      ? null
      : resolveForwardedIdentity(outer, mail.text, receivedAt, own)) ?? outer;
  return {
    messageId: mail.messageId,
    fromAddress: identity.fromAddress,
    fromDomain: identity.fromDomain,
    subject: identity.subject,
    receivedAt,
    bodyText: mail.text,
    bodyHtml: mail.html,
    forwardedBy: identity.forwardedBy,
    originalSentAt: identity.originalSentAt,
    uid,
    status: "pending",
    statusReason: null,
  };
}

/**
 * Insert the rows in the caller's transaction. A row whose
 * `(mailbox_id, uid_validity, uid)` exists is not stored (INV-RECEIPT-002) and
 * is counted as a duplicate.
 */
export async function insertReceiptRows(
  m: EntityManager,
  userId: string,
  mailboxId: string,
  uidValidity: string,
  rows: readonly ReceiptRow[],
): Promise<InsertReceiptRowsResult> {
  let stored = 0;
  let skipped = 0;
  let duplicates = 0;
  for (const row of rows) {
    const inserted = returnedRows<{ id: string }>(
      await m.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, message_id, from_address,
            from_domain, subject, received_at, body_text, body_html,
            forwarded_by, original_sent_at, status, status_reason)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15)
         ON CONFLICT (mailbox_id, uid_validity, uid) DO NOTHING
         RETURNING id`,
        [
          userId,
          mailboxId,
          uidValidity,
          row.uid,
          row.messageId,
          row.fromAddress,
          row.fromDomain,
          row.subject,
          row.receivedAt,
          row.bodyText,
          row.bodyHtml,
          row.forwardedBy,
          row.originalSentAt,
          row.status,
          row.statusReason,
        ],
      ),
    );
    if (inserted.length === 0) {
      duplicates++;
      continue;
    }
    if (row.status === "skipped") skipped++;
    else stored++;
  }
  return { stored, skipped, duplicates };
}
