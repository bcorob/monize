import type {
  EmailReceiptDetail,
  EmailReceiptListItem,
  EmailReceiptMailbox,
  EmailReceiptParser,
  EmailReceiptsOverview,
} from '@/types/email-receipts';

/** A password mailbox as `GET /email-receipts/mailbox` answers it; `overrides` win. */
export function makeMailbox(overrides: Partial<EmailReceiptMailbox> = {}): EmailReceiptMailbox {
  return {
    id: 'mb-1',
    host: 'imap.example.com',
    port: 993,
    security: 'tls',
    username: 'receipts@example.com',
    folder: 'INBOX',
    enabled: true,
    aiMode: 'off',
    autoApply: false,
    profileProposalsCountTowardAiLimit: true,
    passwordSet: true,
    encryptionConfigured: true,
    authMethod: 'password',
    oauthProvider: null,
    oauthConnected: false,
    lastPolledAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** An OAuth mailbox: the host, port and security are the provider's own. */
export function makeOAuthMailbox(overrides: Partial<EmailReceiptMailbox> = {}): EmailReceiptMailbox {
  return makeMailbox({
    host: 'imap.gmail.com',
    username: 'me@gmail.com',
    passwordSet: false,
    authMethod: 'oauth2',
    oauthProvider: 'google',
    oauthConnected: true,
    ...overrides,
  });
}

export function makeParser(overrides: Partial<EmailReceiptParser> = {}): EmailReceiptParser {
  return {
    id: 'p-1',
    name: 'Allegro parser',
    payeeId: 'payee-1',
    fromDomains: ['allegro.pl'],
    subjectContains: [],
    definition: { version: 2, total: ['Total {amount}'] },
    definitionValid: true,
    definitionErrors: [],
    status: 'approved',
    source: 'manual',
    approvedAt: '2026-09-02T10:00:00.000Z',
    revision: 2,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    ...overrides,
  };
}

/** One stored email as `GET /email-receipts` answers it, every field the server always sends included; `overrides` win. */
export function makeReceipt(overrides: Partial<EmailReceiptListItem> = {}): EmailReceiptListItem {
  return {
    id: 'r-1',
    fromAddress: 'orders@allegro.pl',
    fromDomain: 'allegro.pl',
    subject: 'Your order 123',
    receivedAt: '2026-09-01T10:00:00.000Z',
    forwardedBy: null,
    originalSentAt: null,
    effectiveDate: '2026-09-01T10:00:00.000Z',
    status: 'unmatched',
    statusReason: null,
    matchKind: null,
    parserId: null,
    parserName: null,
    linkKey: null,
    aiReviewRequestId: null,
    isTrade: false,
    tradeSource: null,
    displayState: null,
    requestNote: null,
    transaction: null,
    investmentTransaction: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<EmailReceiptDetail> = {}): EmailReceiptDetail {
  return {
    ...makeReceipt(),
    bodyText: 'Thank you for your order.\nTotal 25.00',
    bodyHtml: null,
    lines: { text: ['Thank you for your order.', 'Total 25.00'], html: null },
    structuredOrder: null,
    parsed: null,
    trade: null,
    tradeProposal: null,
    candidates: [],
    linkedComponents: [],
    linkedSettlements: [],
    enrichedBy: null,
    ...overrides,
  };
}

/** A `ParsedReceipt` as the API stores it: amounts in 1/10000 units. */
export const PARSED_RECEIPT = {
  orderId: '123',
  total: 250_000,
  shipping: 50_000,
  discount: null,
  items: [
    { name: 'USB-C cable', qty: 2, amount: 199_800, categoryId: 'cat-1' },
    { name: 'Mystery item', qty: 1, amount: 0, categoryId: null },
  ],
  shippingCategoryId: null,
  discountCategoryId: null,
  complete: false,
  reason: 'items_unbalanced',
};

/** What `GET /email-receipts/overview` answers for a connected mailbox with no emails and no profile; `overrides` win. */
export function makeOverview(overrides: Partial<EmailReceiptsOverview> = {}): EmailReceiptsOverview {
  return {
    mailbox: {
      enabled: true,
      authMethod: 'password',
      aiMode: 'off',
      connected: true,
      lastPolledAt: '2026-10-04T09:00:00.000Z',
      lastSuccessAt: '2026-10-04T09:00:00.000Z',
      lastError: null,
      lastErrorAt: null,
    },
    emailsByStatus: {},
    processable: 0,
    proposalsToApprove: 0,
    parsers: { approved: 0, draft: 0 },
    domainsWithoutProfile: [],
    ...overrides,
  };
}

/** A `ParsedTrade` as the API stores it: the total in 1/10000 units. */
export const PARSED_TRADE = {
  action: 'BUY',
  symbol: 'XCNS',
  quantity: 75.9878,
  total: 20_000_000,
  price: 263_200,
  commission: null,
  currency: null,
  date: '2026-10-15',
  accountText: 'RRSP',
  accountId: 'acc-rrsp',
  complete: true,
  consistent: true,
  reason: null,
};

/**
 * A cash dividend as the API stores it: the email states only the amount paid
 * (12.34, in 1/10000 units), so there is no share count, no price and nothing
 * to cross-check, and the reading is still complete.
 */
export const PARSED_DIVIDEND = {
  ...PARSED_TRADE,
  action: 'DIVIDEND',
  quantity: null,
  total: 123_400,
  price: null,
  consistent: null,
};
