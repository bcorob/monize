/**
 * What a document is. A warranty's new document is stored as `other` and the
 * reader sets its kind on its row (`warranty` is the warranty certificate
 * itself); a transaction's attachments are always `other`
 * (docs/specs/warranty-tracker.md decision 7).
 */
export type DocumentKind = 'receipt' | 'manual' | 'photo' | 'warranty' | 'other';

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  'receipt',
  'manual',
  'photo',
  'warranty',
  'other',
];

/**
 * The row an attachment hangs off: a transaction or a warranty, never both
 * (WTY-003). A caller names one; the API module builds the route from it.
 */
export type AttachmentParent = { transactionId: string } | { warrantyId: string };

/**
 * Metadata for a file attached to a transaction or a warranty. The bytes
 * themselves are never part of this payload -- they are fetched from the
 * download endpoint. Exactly one of `transactionId` and `warrantyId` is set,
 * so a row with `warrantyId` in a transaction's list is a linked warranty's
 * document, not the transaction's own.
 */
export interface Attachment {
  id: string;
  transactionId: string | null;
  warrantyId: string | null;
  documentKind: DocumentKind;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  /**
   * The unprocessed photo a scanned document came from, when one was kept.
   *
   * A scan pair is ONE attachment: this row is what the user sees, and the
   * original is reached through this id rather than listed beside it. `null`
   * for an ordinary upload; absent from an older backend, which reads the same
   * way.
   */
  originalAttachmentId?: string | null;
  /**
   * The warranty's name on a row that is one of its documents. A
   * transaction's list carries the documents of every warranty linked to it
   * after its own rows, and this is what labels them; `null` on a
   * transaction's own row.
   */
  warrantyName?: string | null;
}

/** Client-side limits mirroring the server (server remains authoritative). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_TRANSACTION = 10;
/**
 * A file staged against a transaction that does not exist yet.
 *
 * Two files rather than one, because a scan is a pair: the enhanced image the
 * user will see, and the photo it came from. Both are uploaded together once
 * the transaction has been created, in the request that makes them a pair.
 */
export interface StagedAttachment {
  file: File;
  original?: File;
}

export const ACCEPTED_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
];
