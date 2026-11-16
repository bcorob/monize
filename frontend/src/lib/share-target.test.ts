import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
} from '@/types/attachment';
import {
  ATTACHMENT_EXTENSIONS_BY_MIME,
  SHARE_ATTACHMENT_EXTENSIONS,
  SHARE_KEY_PREFIX,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_FILES,
  SHARE_STATEMENT_EXTENSIONS,
  SHARE_STATEMENT_MIME_TYPES,
  SHARE_TARGET_ACCEPT,
  classifySharedFile,
  extensionOf,
  isExpiredBundle,
  isShareBundleId,
  shareBundleIdFromIndexKey,
  shareFileKey,
  shareIndexKey,
  sharePageUrl,
  SHARE_STASH_TTL_MS,
} from './share-target';

describe('share target accept list', () => {
  it('covers every attachment type the server accepts', () => {
    for (const mime of ACCEPTED_ATTACHMENT_TYPES) {
      expect(SHARE_TARGET_ACCEPT).toContain(mime);
    }
  });

  // The point of the derivation: adding a MIME to ACCEPTED_ATTACHMENT_TYPES
  // without giving it an extension here would leave the share sheet unable to
  // match a file the server would happily take.
  it('gives every accepted attachment type at least one extension', () => {
    for (const mime of ACCEPTED_ATTACHMENT_TYPES) {
      expect(ATTACHMENT_EXTENSIONS_BY_MIME[mime] ?? []).not.toHaveLength(0);
    }
  });

  it('maps no extension to a type the server does not accept', () => {
    for (const mime of Object.keys(ATTACHMENT_EXTENSIONS_BY_MIME)) {
      expect(ACCEPTED_ATTACHMENT_TYPES).toContain(mime);
    }
  });

  it('lists both MIME and dotted-extension entries for statements', () => {
    for (const mime of SHARE_STATEMENT_MIME_TYPES) {
      expect(SHARE_TARGET_ACCEPT).toContain(mime);
    }
    for (const extension of SHARE_STATEMENT_EXTENSIONS) {
      expect(SHARE_TARGET_ACCEPT).toContain(`.${extension}`);
    }
    for (const extension of SHARE_ATTACHMENT_EXTENSIONS) {
      expect(SHARE_TARGET_ACCEPT).toContain(`.${extension}`);
    }
  });

  // A Money file is a whole profile behind a password prompt and a wipe
  // confirmation. Offering it in a share sheet invites an accidental import.
  it('never offers Microsoft Money files', () => {
    expect(SHARE_TARGET_ACCEPT).not.toContain('.mny');
    expect(SHARE_STATEMENT_EXTENSIONS).not.toContain('mny');
  });

  it('never offers a type the server refuses', () => {
    expect(SHARE_TARGET_ACCEPT).not.toContain('image/svg+xml');
    expect(SHARE_TARGET_ACCEPT).not.toContain('.svg');
    expect(SHARE_TARGET_ACCEPT).not.toContain('application/zip');
  });

  it('takes its limits from the attachment caps rather than restating them', () => {
    expect(SHARE_MAX_FILE_BYTES).toBe(MAX_ATTACHMENT_BYTES);
    expect(SHARE_MAX_FILES).toBe(MAX_ATTACHMENTS_PER_TRANSACTION);
  });
});

describe('classifySharedFile', () => {
  it('reads an image or PDF as an attachment from its MIME', () => {
    expect(classifySharedFile({ name: 'receipt.jpg', type: 'image/jpeg' })).toBe(
      'attachment',
    );
    expect(classifySharedFile({ name: 'bill.pdf', type: 'application/pdf' })).toBe(
      'attachment',
    );
  });

  // The common Android case: a bank app exports with no useful content type.
  it('reads a statement from its extension when the MIME says nothing', () => {
    expect(
      classifySharedFile({
        name: 'january.csv',
        type: 'application/octet-stream',
      }),
    ).toBe('statement');
    expect(classifySharedFile({ name: 'export.QFX', type: '' })).toBe(
      'statement',
    );
  });

  it('reads a statement from its MIME when the name has no extension', () => {
    expect(classifySharedFile({ name: 'download', type: 'text/csv' })).toBe(
      'statement',
    );
  });

  it('tolerates a parameterised content type', () => {
    expect(
      classifySharedFile({ name: 'a.csv', type: 'text/csv; charset=utf-8' }),
    ).toBe('statement');
  });

  it('falls back to an attachment extension for a typeless image', () => {
    expect(classifySharedFile({ name: 'photo.PNG', type: '' })).toBe(
      'attachment',
    );
  });

  // The whole reason this is not the import wizard's detectFileType: that
  // returns 'qif' for anything it does not recognise, which would have a share
  // sheet hand an arbitrary file to the QIF parser.
  it('refuses anything else rather than guessing QIF', () => {
    expect(classifySharedFile({ name: 'profile.mny', type: '' })).toBeNull();
    expect(
      classifySharedFile({ name: 'notes.txt', type: 'text/plain' }),
    ).toBeNull();
    expect(
      classifySharedFile({ name: 'logo.svg', type: 'image/svg+xml' }),
    ).toBeNull();
    expect(classifySharedFile({ name: 'archive.zip', type: '' })).toBeNull();
  });
});

describe('extensionOf', () => {
  it('lowercases, and reads nothing from a name without a dot', () => {
    expect(extensionOf('Statement.CSV')).toBe('csv');
    expect(extensionOf('receipt')).toBe('');
    expect(extensionOf('a.b.pdf')).toBe('pdf');
  });
});

describe('stash keys', () => {
  it('accepts a minted id and rejects anything that could escape the prefix', () => {
    expect(isShareBundleId('0f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b')).toBe(true);
    expect(isShareBundleId('../../etc/passwd')).toBe(false);
    expect(isShareBundleId('a/b')).toBe(false);
    expect(isShareBundleId('')).toBe(false);
    expect(isShareBundleId('x'.repeat(65))).toBe(false);
    expect(isShareBundleId(42)).toBe(false);
  });

  // isStaticAsset in the worker matches a trailing extension, so a stash key
  // must never carry one -- otherwise a page fetch could be answered from it.
  it('builds extension-less keys under the synthetic prefix', () => {
    const index = shareIndexKey('abc');
    const file = shareFileKey('abc', 2);
    expect(index).toBe(`${SHARE_KEY_PREFIX}abc/index`);
    expect(file).toBe(`${SHARE_KEY_PREFIX}abc/file/2`);
    for (const key of [index, file]) {
      expect(key.split('/').pop()).not.toContain('.');
    }
  });

  it('recovers a bundle id from an index key and only from an index key', () => {
    expect(shareBundleIdFromIndexKey(shareIndexKey('abc'))).toBe('abc');
    expect(
      shareBundleIdFromIndexKey(`https://monize.test${shareIndexKey('abc')}`),
    ).toBe('abc');
    expect(shareBundleIdFromIndexKey(shareFileKey('abc', 0))).toBeNull();
    expect(shareBundleIdFromIndexKey('/_next/static/chunk.js')).toBeNull();
    expect(shareBundleIdFromIndexKey('not a url at all %')).toBeNull();
  });

  it('encodes the id into the review URL', () => {
    expect(sharePageUrl('abc')).toBe('/share?id=abc');
  });
});

describe('isExpiredBundle', () => {
  it('expires exactly at the lifetime, and treats a missing stamp as expired', () => {
    const now = 1_000_000_000_000;
    expect(isExpiredBundle({ createdAt: now }, now)).toBe(false);
    expect(
      isExpiredBundle({ createdAt: now - SHARE_STASH_TTL_MS + 1 }, now),
    ).toBe(false);
    expect(isExpiredBundle({ createdAt: now - SHARE_STASH_TTL_MS }, now)).toBe(
      true,
    );
    expect(
      isExpiredBundle({ createdAt: undefined as unknown as number }, now),
    ).toBe(true);
  });
});
