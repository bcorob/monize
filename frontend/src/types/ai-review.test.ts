import { describe, it, expect } from 'vitest';
import { makeReviewItem, makeTradeItem, PROPOSED_ACTION, TRADE_ACTION } from '@/components/ai-review/ai-review-fixtures';
import { isApprovable, parseKindFilter, reviewItemLabel } from './ai-review';

describe('parseKindFilter', () => {
  it.each([
    ['email_receipt', 'email_receipt'],
    ['transaction_review', 'transaction_review'],
    ['all', 'all'],
    [null, 'all'],
    ['', 'all'],
    ['email_parser_draft', 'all'],
    ['<script>', 'all'],
  ])('reads %j as %s', (value, expected) => {
    expect(parseKindFilter(value)).toBe(expected);
  });
});

describe('isApprovable', () => {
  it('is true for a proposed request with a card', () => {
    expect(isApprovable(makeReviewItem({ status: 'proposed', proposal: { action: PROPOSED_ACTION } }))).toBe(true);
  });

  it('is false for a proposal that could not be rebuilt, however it is proposed', () => {
    expect(isApprovable(makeReviewItem({ status: 'proposed', proposal: { error: 'no longer adds up' } }))).toBe(false);
  });

  it.each(['pending', 'claimed', 'applied', 'rejected', 'expired'] as const)('is false for a %s request', (status) => {
    expect(isApprovable(makeReviewItem({ status, proposal: { action: PROPOSED_ACTION } }))).toBe(false);
  });

  it('is false without a proposal', () => {
    expect(isApprovable(makeReviewItem({ status: 'proposed' }))).toBe(false);
  });
});

describe('reviewItemLabel', () => {
  const none = { parserDraft: null, emailReceipt: null, ruleName: null, transaction: null };

  it('names a parser draft by its sender domain, first', () => {
    expect(
      reviewItemLabel(makeReviewItem({ ...none, parserDraft: { domain: 'shop.example', emailCount: 2, parserId: null } })),
    ).toBe('shop.example');
  });

  it('prefers the email subject, then the payee, then the rule', () => {
    const base = makeReviewItem();
    const receipt = {
      id: 'r',
      subject: 'Order 1',
      fromAddress: 'a@b.c',
      forwardedBy: null,
      receivedAt: '2026-09-01T10:00:00.000Z',
    };
    expect(reviewItemLabel({ ...base, emailReceipt: receipt })).toBe('Order 1');
    expect(reviewItemLabel(base)).toBe('Allegro');
    expect(reviewItemLabel({ ...base, transaction: null })).toBe('Allegro orders');
  });

  it('is null when nothing names it', () => {
    expect(reviewItemLabel(makeReviewItem({ ...none }))).toBeNull();
  });
});

describe('a trade confirmation', () => {
  it('is named by its ticker', () => {
    expect(reviewItemLabel(makeTradeItem())).toBe('XCNS');
  });

  it('is approvable once proposed with a card, though it has no transaction', () => {
    expect(isApprovable(makeTradeItem({ proposal: { action: TRADE_ACTION } }))).toBe(true);
    expect(isApprovable(makeTradeItem())).toBe(false);
  });
});
