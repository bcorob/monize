import { describe, it, expect } from 'vitest';
import {
  canDraftParser,
  canLinkTradeEmail,
  canReprocessReceipt,
  distinctSenderDomains,
  draftBlock,
  senderDomainCounts,
  dominantSenderDomain,
  fromReceiptUnits,
  looksLikeHtml,
  canRecognizeWithAi,
  isReceiptActionable,
  normalizeDomainFilter,
  parserDraftKind,
  processableForDomains,
  readParsedReceipt,
  senderDomain,
  shownReceiptState,
} from './email-receipts-format';

describe('fromReceiptUnits', () => {
  it('divides 1/10000 units once', () => {
    expect(fromReceiptUnits(199_800)).toBe(19.98);
    expect(fromReceiptUnits(0)).toBe(0);
    expect(fromReceiptUnits(5)).toBe(0.0005);
  });
});

describe('readParsedReceipt', () => {
  it('is null when the email has not been parsed', () => {
    expect(readParsedReceipt(null)).toBeNull();
    expect(readParsedReceipt('x')).toBeNull();
    expect(readParsedReceipt([])).toBeNull();
  });

  it('keeps a stated zero and treats a missing or non-numeric amount as unknown', () => {
    const parsed = readParsedReceipt({ total: 0, shipping: '5', discount: null, complete: true });
    expect(parsed).toMatchObject({ total: 0, shipping: null, discount: null, complete: true, orderId: null });
  });

  it('reads items defensively and drops the ones that are not items', () => {
    const parsed = readParsedReceipt({
      items: [
        { name: 'Cable', qty: 2, amount: 199_800, categoryId: 'c-1' },
        { name: 'No amount' },
        { amount: 5 },
        'junk',
        { name: 'Bad qty', qty: 'x', amount: 10, categoryId: '' },
      ],
      reason: 'items_unbalanced',
    });
    expect(parsed?.items).toEqual([
      { name: 'Cable', qty: 2, amount: 199_800, categoryId: 'c-1' },
      { name: 'Bad qty', qty: 1, amount: 10, categoryId: null },
    ]);
    expect(parsed?.reason).toBe('items_unbalanced');
    expect(parsed?.complete).toBe(false);
  });

  it('ignores a reason it does not know and an items field that is not a list', () => {
    const parsed = readParsedReceipt({ items: 'x', reason: 'something_new' });
    expect(parsed?.items).toEqual([]);
    expect(parsed?.reason).toBeNull();
  });
});

describe('senderDomain', () => {
  it('returns the lower-cased domain of an address', () => {
    expect(senderDomain('Orders@Shop.Example.com')).toBe('shop.example.com');
    expect(senderDomain('a@b@c.example')).toBe('c.example');
  });

  it('is empty when there is no domain', () => {
    expect(senderDomain('no-at-sign')).toBe('');
  });
});

describe('shownReceiptState', () => {
  it('is the status for every status but review', () => {
    expect(shownReceiptState({ status: 'unmatched', displayState: null })).toBe('unmatched');
    expect(shownReceiptState({ status: 'ignored', displayState: null })).toBe('ignored');
  });

  it('is what the request says for a review email', () => {
    expect(shownReceiptState({ status: 'review', displayState: 'applied' })).toBe('applied');
    expect(shownReceiptState({ status: 'review', displayState: 'pending_ai' })).toBe('pending_ai');
  });

  it('never shows a review email with no display state as waiting for approval', () => {
    expect(shownReceiptState({ status: 'review', displayState: null })).toBe('request_missing');
  });
});

describe('isReceiptActionable', () => {
  it.each([
    ['skipped', null, false],
    ['ignored', null, false],
    ['review', 'applied', false],
    ['review', 'proposed', true],
    ['unmatched', null, true],
    // A component is read again after its profile changes (the server allows it).
    ['component', null, true],
  ] as const)('%s / %s is %s', (status, displayState, expected) => {
    expect(isReceiptActionable({ status, displayState })).toBe(expected);
  });
});

describe('canRecognizeWithAi', () => {
  it.each([
    ['no_parser', null, true],
    ['parse_failed', null, true],
    ['unmatched', null, true],
    ['ambiguous', null, true],
    ['review_conflict', null, true],
    ['review', 'dismissed', true],
    ['review', 'expired', true],
    ['review', 'request_missing', true],
    ['review', null, true],
    ['review', 'proposed', false],
    ['review', 'pending_ai', false],
    ['review', 'applied', false],
    ['ignored', null, false],
    ['skipped', null, false],
    ['pending', null, false],
    ['component', null, false],
  ] as const)('%s / %s is %s', (status, displayState, expected) => {
    expect(canRecognizeWithAi({ status, displayState })).toBe(expected);
  });
});

describe('readParsedReceipt source', () => {
  it('keeps who read the email, and leaves it absent when the server did not say', () => {
    expect(readParsedReceipt({ source: 'ai', items: [] })?.source).toBe('ai');
    expect(readParsedReceipt({ source: 'parser', items: [] })?.source).toBe('parser');
    expect(readParsedReceipt({ source: 'schema_org', items: [] })?.source).toBe('schema_org');
    expect(readParsedReceipt({ items: [] })).not.toHaveProperty('source');
    expect(readParsedReceipt({ source: 'robot', items: [] })).not.toHaveProperty('source');
  });
});

describe('readParsedReceipt linked receipts', () => {
  it('keeps a line kind, a link, an instalment, the link key and the part reports', () => {
    const read = readParsedReceipt({
      items: [
        { name: 'Part', amount: 100000, link: 'abc-1', instalment: '2/10' },
        { name: 'Delivery', amount: 50000, kind: 'shipping' },
        { name: 'Odd', amount: 1, kind: 'gift' },
      ],
      linkKey: 'abc-1',
      links: [
        { partIndex: 0, link: 'abc-1', partAmount: 100000, outcome: 'scaled', componentReceiptId: 'r-1', componentNet: 300000, taken: 100000 },
        { partIndex: 1, link: null, partAmount: 5, outcome: 'no_link', componentReceiptId: null },
        { partIndex: 2, link: 'x', partAmount: 5, outcome: 'invented', componentReceiptId: null },
      ],
    });
    expect(read?.items[0]).toMatchObject({ link: 'abc-1', instalment: '2/10' });
    expect(read?.items[0]).not.toHaveProperty('kind');
    expect(read?.items[1].kind).toBe('shipping');
    expect(read?.items[2]).not.toHaveProperty('kind');
    expect(read?.linkKey).toBe('abc-1');
    expect(read?.links).toHaveLength(2);
    expect(read?.links?.[0]).toMatchObject({ outcome: 'scaled', componentNet: 300000, taken: 100000 });
    expect(read?.links?.[1]).toMatchObject({ link: null, componentReceiptId: null });
  });

  it('leaves them absent on a receipt that has none, and keeps a component without a key as null', () => {
    const plain = readParsedReceipt({ items: [] });
    expect(plain).not.toHaveProperty('linkKey');
    expect(plain).not.toHaveProperty('links');
    expect(readParsedReceipt({ items: [], linkKey: null })?.linkKey).toBeNull();
  });
});

describe('canDraftParser', () => {
  it.each([
    ['no_parser', null, true],
    ['parse_failed', null, true],
    ['component', null, true],
    ['unmatched', null, false],
    ['ambiguous', null, false],
    ['skipped', null, false],
    ['ignored', null, false],
    ['pending', null, false],
    ['review', 'proposed', false],
    ['review', 'dismissed', false],
  ] as const)('%s (%s) is %s', (status, displayState, expected) => {
    expect(canDraftParser({ status, displayState })).toBe(expected);
  });
});

describe('distinctSenderDomains', () => {
  it('lists each domain once, in the order they first appear', () => {
    expect(
      distinctSenderDomains([
        { fromDomain: 'shop.example.com', fromAddress: 'a@shop.example.com' },
        { fromDomain: 'other.example.org', fromAddress: 'b@other.example.org' },
        { fromDomain: 'shop.example.com', fromAddress: 'c@shop.example.com' },
      ]),
    ).toEqual(['shop.example.com', 'other.example.org']);
  });

  it('reads the address when the domain column is empty, and leaves out an email with neither', () => {
    expect(
      distinctSenderDomains([
        { fromDomain: '', fromAddress: 'a@shop.example.com' },
        { fromDomain: '', fromAddress: '' },
      ]),
    ).toEqual(['shop.example.com']);
  });

  it('is empty for no emails', () => {
    expect(distinctSenderDomains([])).toEqual([]);
  });
});

describe('looksLikeHtml', () => {
  it.each([
    ['<html><body>Hello</body></html>'],
    ['  \n<!DOCTYPE html><p>x</p>'],
    ['<HTML>'],
    ['<p>One</p><p>Two</p><br><b>Three</b>'],
    ['Order <b>12</b> and <i>13</i> from <a href="https://shop.example.com">shop</a>'],
  ])('takes %j for HTML', (text) => {
    expect(looksLikeHtml(text)).toBe(true);
  });

  it.each([
    ['Order total: 15.00'],
    ['Widget 12.00 < 13.00 and 14.00 > 12.00'],
    ['Only one <b>tag</b>'],
    ['Reply to <a@example.com>, <b@example.com>, <c@example.com>, <d@example.com>, <e@example.com> or <f@example.com>'],
    [''],
    ['<<<<<<<<<<<<<<<<<<<<<<<<'],
    ['a < b > c < d > e'],
  ])('does not take %j for HTML', (text) => {
    expect(looksLikeHtml(text)).toBe(false);
  });

  it('is linear on a hostile text of angle brackets', () => {
    const started = Date.now();
    expect(looksLikeHtml('<a'.repeat(500_000))).toBe(false);
    expect(looksLikeHtml(`<${'x'.repeat(400_000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('dominantSenderDomain', () => {
  const r = (fromDomain: string) => ({ fromDomain, fromAddress: `x@${fromDomain}` });

  it('is the most common domain, the first named winning a tie', () => {
    expect(dominantSenderDomain([r('a.example.com'), r('b.example.com'), r('b.example.com')])).toBe('b.example.com');
    expect(dominantSenderDomain([r('a.example.com'), r('b.example.com')])).toBe('a.example.com');
  });

  it('is empty when no email has a domain', () => {
    expect(dominantSenderDomain([{ fromDomain: '', fromAddress: '' }])).toBe('');
    expect(dominantSenderDomain([])).toBe('');
  });
});

describe('processableForDomains', () => {
  const domains = [
    { domain: 'amazon.com', count: 9, processable: 4 },
    { domain: 'mail.amazon.com', count: 3, processable: 3 },
    { domain: 'notamazon.com', count: 5, processable: 5 },
    { domain: 'old.example', count: 2 },
  ];

  it('sums the processable emails of the domain and its sub-domains, and of no look-alike', () => {
    expect(processableForDomains(domains, ['amazon.com'])).toBe(7);
  });

  it('sums several domains, ignoring case and blanks', () => {
    expect(processableForDomains(domains, ['Amazon.com', ' ', 'old.example'])).toBe(9);
  });

  it('reads a server that sends no processable as all of the emails, never zero', () => {
    expect(processableForDomains(domains, ['old.example'])).toBe(2);
  });

  it('is zero for a sender with no stored email', () => {
    expect(processableForDomains(domains, ['nowhere.example'])).toBe(0);
  });
});

describe('normalizeDomainFilter', () => {
  it('trims and lower-cases a host name, and drops a leading @ and a trailing dot', () => {
    expect(normalizeDomainFilter('shop.example.com')).toBe('shop.example.com');
    expect(normalizeDomainFilter('  @Shop.Example.COM. ')).toBe('shop.example.com');
  });

  it.each([null, undefined, '', '   ', 'nodots', 'a b.example.com', 'a%.example.com', 'a_b.example.com', 'x.com/y', '<script>.com', `${'a'.repeat(250)}.com`])(
    'is no filter for %j',
    (raw) => {
      expect(normalizeDomainFilter(raw as string | null | undefined)).toBe('');
    },
  );
});

describe('canLinkTradeEmail', () => {
  const trade = (over: Partial<Parameters<typeof canLinkTradeEmail>[0]> = {}) => ({
    isTrade: true,
    tradeSource: 'profile' as const,
    status: 'review' as const,
    statusReason: null,
    displayState: 'proposed' as const,
    investmentTransaction: null,
    ...over,
  });
  const booked = { id: 'it-1', date: '2026-10-15', action: 'BUY', symbol: 'XCNS', quantity: 1, totalAmount: 1, currencyCode: 'CAD' };

  it('links a trade whose proposal waits or was refused, and one the ledger already held', () => {
    expect(canLinkTradeEmail(trade())).toBe(true);
    expect(canLinkTradeEmail(trade({ status: 'review_conflict', displayState: null }))).toBe(true);
    expect(
      canLinkTradeEmail(
        trade({ status: 'ignored', statusReason: 'trade_exists', displayState: null, investmentTransaction: booked }),
      ),
    ).toBe(true);
  });

  // The server refuses no more than these, so every candidate it lists can be linked.
  it('links what the server links: a partial reading and an email a person ignored', () => {
    expect(canLinkTradeEmail(trade({ status: 'parse_failed', statusReason: 'trade_no_account', displayState: null }))).toBe(true);
    // A person's ignore writes no reason (`status_reason` null).
    expect(canLinkTradeEmail(trade({ status: 'ignored', statusReason: null, displayState: null }))).toBe(true);
    // A proposal that was dismissed or expired was never applied.
    expect(canLinkTradeEmail(trade({ displayState: 'dismissed' }))).toBe(true);
  });

  it('never links an email twice, an applied one, a skipped one or a non-trade', () => {
    expect(canLinkTradeEmail(trade({ status: 'ignored', statusReason: 'trade_linked', displayState: null, investmentTransaction: booked }))).toBe(false);
    expect(canLinkTradeEmail(trade({ displayState: 'applied', investmentTransaction: booked }))).toBe(false);
    expect(canLinkTradeEmail(trade({ investmentTransaction: booked }))).toBe(false);
    expect(canLinkTradeEmail(trade({ status: 'skipped', displayState: null }))).toBe(false);
    expect(canLinkTradeEmail(trade({ isTrade: false, tradeSource: null }))).toBe(false);
  });

  it('takes a linked email from a server that sends no ledger row as accounting for one', () => {
    expect(canLinkTradeEmail(trade({ status: 'ignored', statusReason: 'trade_linked', displayState: null, investmentTransaction: undefined }))).toBe(false);
  });

  it('is false for an email the AI reads as a trade: its candidates come from a profile\'s reading', () => {
    expect(canLinkTradeEmail(trade({ tradeSource: 'ai' }))).toBe(false);
    expect(canLinkTradeEmail(trade({ tradeSource: 'profile' }))).toBe(true);
  });
});

describe('canReprocessReceipt', () => {
  it.each([
    ['unmatched', null, null, true],
    ['review', null, 'proposed', true],
    ['pending', null, null, false],
    ['skipped', null, null, false],
    ['review', null, 'applied', false],
    // An email a person ignored stays closed; one the ledger already held is read again.
    ['ignored', null, null, false],
    ['ignored', 'trade_linked', null, false],
    ['ignored', 'trade_exists', null, true],
  ] as const)('%s (%s) / %s is %s', (status, statusReason, displayState, expected) => {
    expect(canReprocessReceipt({ status, statusReason, displayState })).toBe(expected);
  });
});

describe('parserDraftKind', () => {
  it('drafts a trade profile from trade confirmations only, a receipt profile from order emails only, and neither from a mix', () => {
    expect(parserDraftKind([{ isTrade: true }, { isTrade: true }])).toBe('trade');
    expect(parserDraftKind([{ isTrade: false }])).toBe('receipt');
    expect(parserDraftKind([{ isTrade: true }, { isTrade: false }])).toBe('mixed');
  });
});

describe('draftBlock', () => {
  const mail = (domain: string, status: 'no_parser' | 'skipped' = 'no_parser', isTrade = false) => ({
    status,
    fromDomain: domain,
    fromAddress: `a@${domain}`,
    isTrade,
  });

  it('is off for a mix of trade confirmations and order emails', () => {
    expect(draftBlock([mail('a.com'), mail('a.com', 'no_parser', true)], false)).toBe('mixedKinds');
    expect(draftBlock([mail('a.com', 'no_parser', true)], false)).toBeNull();
  });

  it('is on for one to five emails of each of one to five senders', () => {
    expect(draftBlock([mail('a.com')], false)).toBeNull();
    expect(draftBlock([1, 2, 3, 4, 5].map(() => mail('a.com')), false)).toBeNull();
    expect(draftBlock([mail('a.com'), mail('b.com')], false)).toBeNull();
    const fiveByFive = [1, 2, 3, 4, 5].flatMap((d) => [1, 2, 3, 4, 5].map(() => mail(`d${d}.com`)));
    expect(fiveByFive).toHaveLength(25);
    expect(draftBlock(fiveByFive, false)).toBeNull();
  });

  it('is off above five emails of one sender, even when other senders are within the limit', () => {
    expect(draftBlock([1, 2, 3, 4, 5, 6].map(() => mail('a.com')), false)).toBe('tooManyPerDomain');
    expect(draftBlock([...[1, 2, 3, 4, 5, 6].map(() => mail('a.com')), mail('b.com')], false)).toBe('tooManyPerDomain');
  });

  it('is off above five senders', () => {
    expect(draftBlock([1, 2, 3, 4, 5, 6].map((n) => mail(`d${n}.com`)), false)).toBe('tooManyDomains');
  });

  it('is off for trade confirmations of more than one sender', () => {
    expect(draftBlock([mail('a.com', 'no_parser', true), mail('b.com', 'no_parser', true)], false)).toBe('tradeOneDomain');
    expect(draftBlock([mail('a.com', 'no_parser', true), mail('a.com', 'no_parser', true)], false)).toBeNull();
  });

  it('is off for an unreadable email', () => {
    expect(draftBlock([mail('a.com'), mail('a.com', 'skipped')], false)).toBe('skipped');
  });

  it('is off for a selection by filter, whatever its size', () => {
    expect(draftBlock([mail('a.com')], true)).toBe('allMatching');
  });
});

describe('senderDomainCounts', () => {
  it('counts emails per sender domain in first-seen order, falling back to the address', () => {
    expect(
      senderDomainCounts([
        { fromDomain: 'a.com', fromAddress: 'x@a.com' },
        { fromDomain: '', fromAddress: 'y@b.com' },
        { fromDomain: 'a.com', fromAddress: 'z@a.com' },
      ]),
    ).toEqual([
      { domain: 'a.com', count: 2 },
      { domain: 'b.com', count: 1 },
    ]);
  });
});
