import { detectForwardedOriginal } from "./forwarded-message";

/** The bounds the `email_receipts` columns enforce. */
const MAX_FROM_ADDRESS_CHARS = 320;
const MAX_FROM_DOMAIN_CHARS = 255;
const MAX_SUBJECT_CHARS = 500;
const DAY_MS = 86_400_000;

/** The identity columns of a stored email that a forward changes. */
export interface ReceiptIdentity {
  fromAddress: string;
  fromDomain: string;
  subject: string;
  /** The outer From of the owner's own forward, else null (never anybody else's). */
  forwardedBy: string | null;
  /** When the shop sent the order, read from the forwarded header block. */
  originalSentAt: Date | null;
}

/**
 * One address as `resolveForwardedIdentity` compares it: trimmed and lower-case.
 * An address with no `@` is no address (a mailbox login that is a bare user
 * name), and is never anybody's.
 */
export function normalizeOwnAddress(
  address: string | null | undefined,
): string | null {
  const trimmed = (address ?? "").trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : "")
    .toLowerCase()
    .slice(0, MAX_FROM_DOMAIN_CHARS);
}

/**
 * What a stored email's sender, subject and dates are once a forwarded header
 * block in its text is taken into account, or null when nothing changes (the
 * columns stay as they are). Used at ingestion and again on reprocess, from the
 * stored text, so an email stored before this was understood heals on
 * "Reprocess".
 *
 * The block is text the sender wrote, so it is honoured only for the owner's
 * own forward: the outer sender (`forwardedBy` once healed, else `fromAddress`)
 * must be one of `ownAddresses` (the mailbox login and the owner's verified
 * account email, read by the server, `normalizeOwnAddress`). Anyone else's
 * pasted block is text, not an identity (A26-H02): the email stays the outer
 * sender's. A row re-identified by somebody else's block before this rule
 * existed is put back under that sender (`forwardedBy` becomes its From again;
 * its own subject is gone, so the shop's subject stays).
 *
 * Idempotent: a row already healed carries `forwardedBy`, which is kept, so a
 * second pass over it writes the same values and never replaces the forwarder
 * with the shop. The original date is dropped when it names a day later than
 * the day the forward arrived: a header that claims the shop wrote after the
 * user forwarded it is garbled, and the arrival date is the better guide.
 */
export function resolveForwardedIdentity(
  current: ReceiptIdentity,
  bodyText: string,
  receivedAt: Date,
  ownAddresses: ReadonlySet<string>,
): ReceiptIdentity | null {
  const sender = normalizeOwnAddress(
    current.forwardedBy ?? current.fromAddress,
  );
  if (sender === null || !ownAddresses.has(sender)) {
    if (current.forwardedBy === null) return null;
    const fromAddress = current.forwardedBy.slice(0, MAX_FROM_ADDRESS_CHARS);
    return {
      fromAddress,
      fromDomain: domainOf(fromAddress),
      subject: current.subject,
      forwardedBy: null,
      originalSentAt: null,
    };
  }

  const original = detectForwardedOriginal(bodyText);
  if (original === null) return null;

  const fromAddress = original.fromAddress.slice(0, MAX_FROM_ADDRESS_CHARS);
  const fromDomain = domainOf(fromAddress);
  const sentAt =
    original.sentAt !== null &&
    original.sentAt.getTime() <= receivedAt.getTime() + DAY_MS
      ? original.sentAt
      : null;
  const subject = (original.subject ?? current.subject)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUBJECT_CHARS);

  return {
    fromAddress,
    fromDomain,
    subject,
    forwardedBy: (current.forwardedBy ?? current.fromAddress).slice(
      0,
      MAX_FROM_ADDRESS_CHARS,
    ),
    originalSentAt: sentAt,
  };
}

/**
 * Whether `resolveForwardedIdentity` could change anything: the row already
 * names a forwarder, or its text holds a forwarded header block. A caller asks
 * this before it reads the owner's addresses, so an ordinary email costs no
 * query.
 */
export function mayBeForwarded(
  current: Pick<ReceiptIdentity, "forwardedBy">,
  bodyText: string,
): boolean {
  return (
    current.forwardedBy !== null || detectForwardedOriginal(bodyText) !== null
  );
}

/**
 * Whether the email's sender identity came from a forwarded header block: the
 * one predicate both auto-apply gates read (A26-H02). Any stored forwarder
 * counts, so the answer fails closed.
 */
export function isForwardedReceipt(receipt: {
  forwardedBy?: string | null;
}): boolean {
  return typeof receipt.forwardedBy === "string";
}

/** Whether two identities are the same, so a reprocess writes only a real change. */
export function sameIdentity(a: ReceiptIdentity, b: ReceiptIdentity): boolean {
  return (
    a.fromAddress === b.fromAddress &&
    a.fromDomain === b.fromDomain &&
    a.subject === b.subject &&
    a.forwardedBy === b.forwardedBy &&
    (a.originalSentAt?.getTime() ?? null) ===
      (b.originalSentAt?.getTime() ?? null)
  );
}

/**
 * The date a receipt's match window is centred on: the day the shop sent the
 * order when a forward carried it, else the day the email arrived.
 */
export function effectiveReceiptDate(receipt: {
  originalSentAt: Date | null;
  receivedAt: Date;
}): Date {
  return receipt.originalSentAt ?? receipt.receivedAt;
}
