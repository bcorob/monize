import {
  ACCEPTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
} from '@/types/attachment';

/**
 * The Web Share Target: the one place that says what an installed Monize PWA
 * accepts from the OS share sheet, where a share lands, and what bounds the
 * stash it lands in.
 *
 * The service worker cannot import this module (it is a classic script), so
 * `public/sw.js` carries the same values as literals and
 * `src/test/sw-share-target.test.ts` asserts the two agree -- the mirroring
 * discipline `sw-offline.test.ts` already applies to the boot palette. Change a
 * value here and that test tells you which literal in the worker to move.
 */

/** Where the OS POSTs a share. Handled by the worker, never by a page. */
export const SHARE_TARGET_PATH = '/share-target';

/** Where the worker redirects, and the page the user actually reads. */
export const SHARE_PAGE_PATH = '/share';

/** The stash. Separate from the static cache so a worker update cannot drop it. */
export const SHARE_CACHE_NAME = 'monize-share-v1';

/**
 * Synthetic key prefix for stash entries. Deliberately extension-less: the
 * worker's `isStaticAsset` matches on a trailing extension, so no stash key can
 * ever be mistaken for a cacheable asset and served to a page fetch.
 */
export const SHARE_KEY_PREFIX = '/__monize/share/';

/** Header carrying the original filename on a stored file's Response. */
export const SHARE_NAME_HEADER = 'X-Monize-Share-Name';

// ---------------------------------------------------------------------------
// Limits (plan section 3.2). The server remains the authority -- these bound
// what a device stores and let the review screen explain a refusal, rather
// than the user discovering it after an upload.
// ---------------------------------------------------------------------------

/** Per file. The attachment cap; the statement endpoints sit behind 10 MB too. */
export const SHARE_MAX_FILE_BYTES = MAX_ATTACHMENT_BYTES;

/** Per share. The per-transaction attachment cap. */
export const SHARE_MAX_FILES = MAX_ATTACHMENTS_PER_TRANSACTION;

/** Per share, in total. Bounds the stash; a bank export never approaches it. */
export const SHARE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * How long a bundle survives. Long enough to log in and come back, short
 * enough that a statement is not left sitting on a shared device.
 */
export const SHARE_STASH_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// What we accept
// ---------------------------------------------------------------------------

/**
 * Statement formats the import wizard can parse. Written here rather than taken
 * from the wizard's own `detectFileType`: that function falls through to QIF for
 * every extension it does not recognise, which is right for a picker (the user
 * chose the file) and wrong for a share sheet (the OS chose it, and anything
 * outside this list must be refused with a reason rather than parsed as QIF).
 *
 * `.mny` is deliberately absent -- a Money file is a whole profile imported
 * once behind a password prompt and a wipe confirmation, not something to offer
 * in a share sheet.
 */
export const SHARE_STATEMENT_EXTENSIONS = ['csv', 'ofx', 'qfx', 'qif'] as const;

/**
 * MIME spellings for those formats. Listed alongside the extensions because
 * Android matches the share sheet on the shared item's MIME, while a statement
 * exported from a bank app frequently arrives as `application/octet-stream`
 * with only the extension to go on -- the same reason `ATTACHMENT_ACCEPT` in
 * `lib/ai-attachments.ts` lists both.
 */
export const SHARE_STATEMENT_MIME_TYPES = [
  'text/csv',
  'application/csv',
  'application/x-ofx',
  'application/vnd.intu.qfx',
  'application/qif',
  'application/x-qif',
] as const;

/**
 * Extensions for each accepted attachment MIME. Derived from
 * `ACCEPTED_ATTACHMENT_TYPES` rather than restated beside it: a new attachment
 * type with no entry here fails `share-target.test.ts`, which is the point --
 * the accept list must not silently stop covering a type the server accepts.
 */
export const ATTACHMENT_EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
};

const dotted = (extensions: readonly string[]): string[] =>
  extensions.map((extension) => `.${extension}`);

/** Every attachment extension, in the order its MIME appears. */
export const SHARE_ATTACHMENT_EXTENSIONS: readonly string[] =
  ACCEPTED_ATTACHMENT_TYPES.flatMap(
    (mime) => ATTACHMENT_EXTENSIONS_BY_MIME[mime] ?? [],
  );

/**
 * The manifest's `accept` list. Derived from the two source lists so the share
 * sheet cannot promise what the server refuses, nor omit what it accepts.
 */
export const SHARE_TARGET_ACCEPT: readonly string[] = [
  ...ACCEPTED_ATTACHMENT_TYPES,
  ...SHARE_STATEMENT_MIME_TYPES,
  ...dotted(SHARE_ATTACHMENT_EXTENSIONS),
  ...dotted(SHARE_STATEMENT_EXTENSIONS),
];

/** Name of the manifest form field the OS puts the files in. */
export const SHARE_TARGET_FILES_FIELD = 'files';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** What a shared file can be used for, or `null` when it is neither. */
export type SharedFileKind = 'attachment' | 'statement';

/** Why the worker refused to stash a file's bytes. */
export type ShareRejectionReason =
  | 'unsupported'
  | 'tooLarge'
  | 'tooMany'
  | 'shareTooLarge';

/** Lowercase extension without the dot, or '' when the name carries none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Decide what a shared file is, from its declared type and its name.
 *
 * MIME first for attachments (that list is exact, and the server sniffs the
 * magic bytes regardless), then extension for statements (the common case, an
 * `application/octet-stream` export), then MIME for a statement that arrived
 * with no extension at all. Anything else is `null` -- refused with a reason,
 * never guessed at.
 */
export function classifySharedFile(file: {
  name: string;
  type: string;
}): SharedFileKind | null {
  const type = (file.type || '').toLowerCase().split(';')[0].trim();
  if ((ACCEPTED_ATTACHMENT_TYPES as readonly string[]).includes(type)) {
    return 'attachment';
  }
  const extension = extensionOf(file.name);
  if ((SHARE_STATEMENT_EXTENSIONS as readonly string[]).includes(extension)) {
    return 'statement';
  }
  if ((SHARE_STATEMENT_MIME_TYPES as readonly string[]).includes(type)) {
    return 'statement';
  }
  if ((SHARE_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension)) {
    return 'attachment';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The stash's shape and keys
// ---------------------------------------------------------------------------

/** One file in a share, accepted (with `key`) or refused (with `reason`). */
export interface SharedFileEntry {
  name: string;
  type: string;
  size: number;
  kind: SharedFileKind | null;
  /** Cache key holding the bytes. Absent exactly when the file was refused. */
  key?: string;
  /** Why it was refused. Absent exactly when the file was accepted. */
  reason?: ShareRejectionReason;
}

/**
 * The record of one share. Authoritative for every file's name, type and size:
 * a refused file has no stored Response at all, so the index is the only place
 * that can describe the whole share.
 */
export interface SharedBundleIndex {
  id: string;
  createdAt: number;
  files: SharedFileEntry[];
  /**
   * The account this bundle belongs to, stamped by the first authenticated
   * reader that observed it (`claimIndex` in `lib/share-inbox.ts`).
   *
   * The worker cannot set it: a share can arrive with nobody signed in. Absent
   * therefore means "not yet claimed", which is claimable -- never "everyone's".
   */
  ownerUserId?: string;
}

/**
 * A bundle id is minted by the worker with `crypto.randomUUID`, but it reaches
 * the page through the query string, so it is validated before it is ever used
 * to build a cache key.
 */
export function isShareBundleId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
}

export function shareIndexKey(id: string): string {
  return `${SHARE_KEY_PREFIX}${id}/index`;
}

export function shareFileKey(id: string, position: number): string {
  return `${SHARE_KEY_PREFIX}${id}/file/${position}`;
}

/** The bundle id an index key names, or null when the URL is not one. */
export function shareBundleIdFromIndexKey(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url, 'https://monize.invalid').pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(SHARE_KEY_PREFIX)) return null;
  const rest = pathname.slice(SHARE_KEY_PREFIX.length);
  const match = /^([A-Za-z0-9-]{1,64})\/index$/.exec(rest);
  return match ? match[1] : null;
}

/** True once a bundle is older than the stash lifetime. */
export function isExpiredBundle(
  index: Pick<SharedBundleIndex, 'createdAt'>,
  now: number = Date.now(),
): boolean {
  return !(typeof index.createdAt === 'number') ||
    now - index.createdAt >= SHARE_STASH_TTL_MS;
}

/** The review-screen URL for a bundle. */
export function sharePageUrl(id: string): string {
  return `${SHARE_PAGE_PATH}?id=${encodeURIComponent(id)}`;
}
