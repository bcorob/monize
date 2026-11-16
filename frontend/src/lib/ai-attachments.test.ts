import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveMediaType,
  kindForMediaType,
  validateFile,
  validateAddition,
  assistantAcceptsFiles,
  fileToAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from './ai-attachments';
import type { ChatAttachment } from '@/types/ai';

function makeFile(name: string, type: string, size = 8): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('ai-attachments', () => {
  beforeEach(() => {
    // jsdom doesn't implement object URLs; stub them for fileToAttachment.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });

  describe('resolveMediaType', () => {
    it('normalises CSV by extension even when the browser MIME differs', () => {
      expect(resolveMediaType(makeFile('a.csv', 'application/vnd.ms-excel'))).toBe(
        'text/csv',
      );
    });

    it('resolves images by extension', () => {
      expect(resolveMediaType(makeFile('shot.png', 'image/png'))).toBe('image/png');
    });

    it('falls back to the file type when there is no known extension', () => {
      expect(resolveMediaType(makeFile('clipboard', 'image/png'))).toBe('image/png');
    });

    it('returns null for unsupported files', () => {
      expect(resolveMediaType(makeFile('a.exe', 'application/octet-stream'))).toBeNull();
    });

    it('resolves a PDF by MIME when it has no extension', () => {
      expect(resolveMediaType(makeFile('statement', 'application/pdf'))).toBe(
        'application/pdf',
      );
    });

    it('trusts an accepted MIME over a misleading extension (real PDF named .txt)', () => {
      expect(resolveMediaType(makeFile('report.txt', 'application/pdf'))).toBe(
        'application/pdf',
      );
    });
  });

  describe('kindForMediaType', () => {
    it('maps media types to kinds', () => {
      expect(kindForMediaType('application/pdf')).toBe('pdf');
      expect(kindForMediaType('image/jpeg')).toBe('image');
      expect(kindForMediaType('text/csv')).toBe('text');
    });
  });

  describe('validateFile', () => {
    it('accepts a supported, in-size file', () => {
      expect(validateFile(makeFile('a.png', 'image/png'))).toBeNull();
    });

    it('rejects an unsupported type', () => {
      expect(validateFile(makeFile('a.exe', 'application/octet-stream'))).toEqual({
        key: 'chat.errors.unsupportedType',
        values: { filename: 'a.exe' },
      });
    });

    it('rejects a file over the per-file size limit', () => {
      const big = makeFile('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1);
      expect(validateFile(big)?.key).toBe('chat.errors.fileTooLarge');
    });
  });

  describe('validateAddition', () => {
    it('rejects exceeding the count limit', () => {
      const current = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
        id: String(i),
        kind: 'image',
        mediaType: 'image/png',
        filename: `f${i}.png`,
        data: '',
        size: 1,
      })) as ChatAttachment[];
      expect(validateAddition(current, [makeFile('x.png', 'image/png')])?.key).toBe(
        'chat.errors.tooManyAttachments',
      );
    });

    it('rejects exceeding the total size limit', () => {
      const current = [
        {
          id: '1',
          kind: 'image',
          mediaType: 'image/png',
          filename: 'a.png',
          data: '',
          size: MAX_TOTAL_ATTACHMENT_BYTES - 1024,
        },
      ] as ChatAttachment[];
      const incoming = makeFile('b.png', 'image/png', 4096);
      expect(validateAddition(current, [incoming])?.key).toBe(
        'chat.errors.totalTooLarge',
      );
    });

    it('allows an addition within limits', () => {
      expect(validateAddition([], [makeFile('a.png', 'image/png')])).toBeNull();
    });
  });

  // The share review screen shows its "Send to AI Assistant" row from this
  // answer, so every refusal below is a row that must not appear: an offer the
  // chat would then refuse costs the user the press and the share.
  describe('assistantAcceptsFiles', () => {
    it('accepts every attachment type a share can carry', () => {
      expect(
        assistantAcceptsFiles([
          makeFile('receipt.jpg', 'image/jpeg'),
          makeFile('bill.pdf', 'application/pdf'),
          makeFile('statement.csv', 'text/csv'),
        ]),
      ).toBe(true);
    });

    it('refuses the whole set when one file is a type it cannot read', () => {
      expect(
        assistantAcceptsFiles([
          makeFile('statement.csv', 'text/csv'),
          makeFile('statement.qif', 'application/x-qw'),
        ]),
      ).toBe(false);
    });

    // The share stash allows 10 files at 10 MB each; the assistant allows 5 at
    // 5 MB. A share inside the stash's caps can still be outside these.
    it('refuses more files than the assistant takes at once', () => {
      const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) =>
        makeFile(`page-${i}.png`, 'image/png'),
      );
      expect(assistantAcceptsFiles(files)).toBe(false);
    });

    it('refuses a file over the per-file cap', () => {
      expect(
        assistantAcceptsFiles([
          makeFile('huge.png', 'image/png', MAX_ATTACHMENT_BYTES + 1),
        ]),
      ).toBe(false);
    });

    it('refuses a set over the total cap', () => {
      const half = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 2);
      expect(
        assistantAcceptsFiles([
          makeFile('a.png', 'image/png', half),
          makeFile('b.png', 'image/png', half),
        ]),
      ).toBe(false);
    });

    it('refuses an empty set: there is nothing to send', () => {
      expect(assistantAcceptsFiles([])).toBe(false);
    });
  });

  describe('fileToAttachment', () => {
    it('encodes an image to base64, derives kind, and sets a preview', async () => {
      const file = new File([new Uint8Array([1, 2, 3])], 'r.png', {
        type: 'image/png',
      });
      const att = await fileToAttachment(file);
      expect(att.kind).toBe('image');
      expect(att.mediaType).toBe('image/png');
      expect(att.filename).toBe('r.png');
      // base64 of bytes [1,2,3] is "AQID"; the data-URL prefix is stripped.
      expect(att.data).toBe('AQID');
      expect(att.previewUrl).toBe('blob:mock');
      expect(att.size).toBe(3);
    });

    it('does not create a preview URL for non-image files', async () => {
      const file = new File(['date,amount\n'], 't.csv', { type: 'text/csv' });
      const att = await fileToAttachment(file);
      expect(att.kind).toBe('text');
      expect(att.previewUrl).toBeUndefined();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
  });
});
