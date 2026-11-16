import { describe, it, expect } from 'vitest';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, resolveMediaType } from './ai-attachments';
import {
  buildParserDraftAttachments,
  buildReceiptAttachment,
  maxBodyChars,
  receiptAttachmentName,
} from './email-receipt-chat';

const email = {
  fromAddress: 'orders@shop.example.com',
  subject: 'Your order ABCD1234',
  receivedAt: '2026-09-10T10:00:00.000Z',
  bodyText: 'Widget 12.00\nOrder total: 15.00',
};

describe('receiptAttachmentName', () => {
  it('is order-email-YYYY-MM-DD.txt from the day the email arrived', () => {
    expect(receiptAttachmentName('2026-09-10T23:59:59.000Z')).toBe('order-email-2026-09-10.txt');
  });
});

describe('buildReceiptAttachment', () => {
  it('is a text/plain file the chat accepts, holding From, Subject, Date and the body', async () => {
    const file = buildReceiptAttachment(email);
    expect(file.name).toBe('order-email-2026-09-10.txt');
    expect(file.type).toBe('text/plain');
    expect(resolveMediaType(file)).toBe('text/plain');
    expect(await file.text()).toBe(
      [
        'From: orders@shop.example.com',
        'Subject: Your order ABCD1234',
        'Date: 2026-09-10T10:00:00.000Z',
        '',
        'Widget 12.00\nOrder total: 15.00',
        '',
      ].join('\n'),
    );
  });

  it('cuts a body so the file stays within the attachment limit, even in 4-byte characters', () => {
    const file = buildReceiptAttachment({ ...email, bodyText: '\u{1F600}'.repeat(2_000_000) });
    expect(file.size).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
    expect(file.size).toBeGreaterThan(MAX_ATTACHMENT_BYTES / 4);
  });
});

describe('a forwarded email', () => {
  const forwarded = {
    ...email,
    id: 'r-1',
    forwardedBy: 'alice.example@gmail.example.com',
    effectiveDate: '2026-08-10T08:15:00.000Z',
  };

  it('is dated by the shop\'s day, in the name and in the header', async () => {
    const file = buildReceiptAttachment(forwarded);
    expect(file.name).toBe('order-email-2026-08-10.txt');
    expect(await file.text()).toContain('Date: 2026-08-10T08:15:00.000Z');
  });
});

describe('buildParserDraftAttachments', () => {
  const emails = Array.from({ length: 5 }, (_, index) => ({
    ...email,
    id: `r-${index + 1}`,
    subject: `Order ${index + 1}`,
    bodyText: `Item ${index + 1} 12.00`,
  }));

  it('makes one text file per email, named by position and day, each carrying the email id', async () => {
    const files = buildParserDraftAttachments(emails.slice(0, 2));
    expect(files.map((file) => file.name)).toEqual(['order-email-1-2026-09-10.txt', 'order-email-2-2026-09-10.txt']);
    for (const file of files) {
      expect(file.type).toBe('text/plain');
      expect(resolveMediaType(file)).toBe('text/plain');
    }
    expect(await files[1].text()).toBe(
      [
        'Id: r-2',
        'From: orders@shop.example.com',
        'Subject: Order 2',
        'Date: 2026-09-10T10:00:00.000Z',
        '',
        'Item 2 12.00',
        '',
      ].join('\n'),
    );
  });

  it('says who forwarded an email and dates it by the shop\'s day', async () => {
    const [file] = buildParserDraftAttachments([
      { ...emails[0], forwardedBy: 'alice.example@gmail.example.com', effectiveDate: '2026-08-10T08:15:00.000Z' },
    ]);
    const text = await file.text();
    expect(text).toContain('Forwarded by: alice.example@gmail.example.com');
    expect(text).toContain('Date: 2026-08-10T08:15:00.000Z');
    expect(file.name).toBe('order-email-1-2026-08-10.txt');
  });

  it('never attaches more than the chat takes', () => {
    const six = [...emails, { ...emails[0], id: 'r-6' }];
    expect(buildParserDraftAttachments(six)).toHaveLength(MAX_ATTACHMENTS);
  });

  it('keeps five of the biggest emails within the per-file and the total cap, in 4-byte characters', () => {
    const big = emails.map((e) => ({ ...e, bodyText: '\u{1F600}'.repeat(1_000_000) }));
    const files = buildParserDraftAttachments(big);
    for (const file of files) expect(file.size).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
    expect(files.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(MAX_TOTAL_ATTACHMENT_BYTES);
  });

  it('lets one email use up to the per-file cap', () => {
    expect(maxBodyChars(1) * 4).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
    expect(maxBodyChars(5) * 4 * 5).toBeLessThanOrEqual(MAX_TOTAL_ATTACHMENT_BYTES);
    expect(maxBodyChars(1)).toBeGreaterThan(maxBodyChars(5));
  });

  it('has nothing to attach for no emails', () => {
    expect(buildParserDraftAttachments([])).toEqual([]);
  });
});
