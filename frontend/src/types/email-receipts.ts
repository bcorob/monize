/**
 * Email receipts as the API answers them. Mirrors
 * `backend/src/email-receipts/` (mailbox view and DTOs, receipts view, parsers
 * view and DTOs, `parsing/receipt-parser.types.ts`). The value lists are
 * `as const` arrays with the unions derived from them, so a control can
 * enumerate what the type allows.
 *
 * Amounts inside a `ParsedReceipt` are integers in 1/10000 units (the parser
 * reads text, never floats); a transaction summary's `amount` is an ordinary
 * currency amount. `fromReceiptUnits` (`lib/email-receipts-format.ts`) is the
 * one conversion between the two.
 */

export const EMAIL_RECEIPT_MAILBOX_SECURITIES = ['tls', 'starttls'] as const;
export type EmailReceiptMailboxSecurity = (typeof EMAIL_RECEIPT_MAILBOX_SECURITIES)[number];

export const EMAIL_RECEIPT_AI_MODES = ['off', 'on_demand', 'automatic'] as const;
export type EmailReceiptAiMode = (typeof EMAIL_RECEIPT_AI_MODES)[number];

export const EMAIL_RECEIPT_AUTH_METHODS = ['password', 'oauth2'] as const;
export type EmailReceiptAuthMethod = (typeof EMAIL_RECEIPT_AUTH_METHODS)[number];

export const EMAIL_RECEIPT_OAUTH_PROVIDERS = ['google', 'microsoft'] as const;
export type EmailReceiptOAuthProvider = (typeof EMAIL_RECEIPT_OAUTH_PROVIDERS)[number];

export const EMAIL_RECEIPT_STATUSES = [
  'pending',
  'skipped',
  'no_parser',
  'parse_failed',
  'unmatched',
  'ambiguous',
  'review_conflict',
  'review',
  'ignored',
  // The purchase email of a linked receipt: stored, never matched, waits for its settlement.
  'component',
] as const;
export type EmailReceiptStatus = (typeof EMAIL_RECEIPT_STATUSES)[number];

/**
 * How an email was tied to its transaction: the profile strategy that found it
 * (`reference`, `order_id`, `amount_payee`, `amount_date`) or `manual`.
 * `amount_only` is what an email matched before the strategies were configurable
 * carries: it is shown, never produced.
 */
export const EMAIL_RECEIPT_MATCH_KINDS = [
  'order_id',
  'reference',
  'amount_payee',
  'amount_date',
  'amount_only',
  'manual',
] as const;
export type EmailReceiptMatchKind = (typeof EMAIL_RECEIPT_MATCH_KINDS)[number];

/** What a `review` receipt's request says about it; null for every other status. */
export const EMAIL_RECEIPT_DISPLAY_STATES = [
  'proposed',
  'applied',
  'dismissed',
  'expired',
  'pending_ai',
  'request_missing',
] as const;
export type EmailReceiptDisplayState = (typeof EMAIL_RECEIPT_DISPLAY_STATES)[number];

export const EMAIL_RECEIPT_PARSER_STATUSES = ['draft', 'approved'] as const;
export type EmailReceiptParserStatus = (typeof EMAIL_RECEIPT_PARSER_STATUSES)[number];

export const EMAIL_RECEIPT_PARSER_SOURCES = ['manual', 'ai'] as const;
export type EmailReceiptParserSource = (typeof EMAIL_RECEIPT_PARSER_SOURCES)[number];

/** Why a parse is not complete (`ParsedReceipt.reason`). */
export const PARSED_RECEIPT_REASONS = [
  'no_total',
  'no_items',
  'item_amount_missing',
  'items_unbalanced',
  'items_uncategorized',
  'shipping_uncategorized',
] as const;
export type ParsedReceiptReason = (typeof PARSED_RECEIPT_REASONS)[number];

/** Why a trade reading is not complete (`ParsedTrade.reason`): the first thing missing. */
export const PARSED_TRADE_REASONS = [
  'trade_no_action',
  'trade_no_symbol',
  'trade_no_quantity',
  'trade_no_amount',
  'trade_no_account',
  'trade_no_currency',
] as const;
export type ParsedTradeReason = (typeof PARSED_TRADE_REASONS)[number];

/**
 * Where a trade's currency came from: the amount text named it (`US$`, `CAD`),
 * a currency marker of the profile matched a line, or the user's security for
 * the ticker has it. Tried in that order; the first that yields wins.
 */
export const TRADE_CURRENCY_SOURCES = ['amount', 'marker', 'security'] as const;
export type TradeCurrencySource = (typeof TRADE_CURRENCY_SOURCES)[number];

/**
 * What a trade-confirmation email reports (`PARSED_TRADE_ACTIONS` in
 * `backend/src/email-receipts/parsing/receipt-parser.types.ts`): a buy, a sell,
 * a cash dividend (no shares move, so no share count is needed) and a
 * reinvested dividend (shares bought with the distribution).
 */
export const TRADE_ACTIONS = ['BUY', 'SELL', 'DIVIDEND', 'REINVEST'] as const;
export type TradeAction = (typeof TRADE_ACTIONS)[number];

/** The trade action a value names (a stored reading, a booked row's action), else null. */
export function tradeActionOf(value: unknown): TradeAction | null {
  return TRADE_ACTIONS.find((action) => action === value) ?? null;
}

/** Whether a trade action moves shares, so its reading needs a share count; a cash dividend does not. */
export const tradeActionMovesShares = (action: TradeAction): boolean => action !== 'DIVIDEND';

/** What a profile's emails are for (linked receipts); absent is `standalone`. */
export const RECEIPT_PARSER_ROLES = ['standalone', 'component', 'settlement'] as const;
export type ReceiptParserRole = (typeof RECEIPT_PARSER_ROLES)[number];

/** What a split line is: an `item` (absent reads as one), or the `shipping`, a `fee` or the `discount` of a joined component. */
export const RECEIPT_LINE_KINDS = ['item', 'shipping', 'fee', 'discount'] as const;
export type ReceiptLineKind = (typeof RECEIPT_LINE_KINDS)[number];

/** What a settlement part became (`ParsedReceipt.links[].outcome`). */
export const RECEIPT_LINK_OUTCOMES = [
  'no_link',
  'not_found',
  'component_incomplete',
  'component_used',
  'joined',
  'scaled',
  'amount_exceeds',
] as const;
export type ReceiptLinkOutcome = (typeof RECEIPT_LINK_OUTCOMES)[number];

// ---------------------------------------------------------------- mailbox

/** The user's mailbox. The password is never here: `passwordSet` says whether one is stored. */
export interface EmailReceiptMailbox {
  id: string;
  host: string;
  port: number;
  security: EmailReceiptMailboxSecurity;
  username: string;
  folder: string;
  enabled: boolean;
  aiMode: EmailReceiptAiMode;
  autoApply: boolean;
  /**
   * Whether a proposal a saved profile built counts toward the daily AI write
   * limit when it is confirmed. The user's own switch; an AI-built proposal always counts.
   */
  profileProposalsCountTowardAiLimit: boolean;
  passwordSet: boolean;
  encryptionConfigured: boolean;
  authMethod: EmailReceiptAuthMethod;
  oauthProvider: EmailReceiptOAuthProvider | null;
  oauthConnected: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `PUT /email-receipts/mailbox`: the whole configuration. `password` only when typed. */
export interface UpsertEmailReceiptMailboxPayload {
  host: string;
  port: number;
  security: EmailReceiptMailboxSecurity;
  username: string;
  password?: string;
  folder?: string;
  enabled: boolean;
  aiMode: EmailReceiptAiMode;
  autoApply: boolean;
  /** Omit to keep the stored value. */
  profileProposalsCountTowardAiLimit?: boolean;
}

/** `PATCH /email-receipts/mailbox/settings`: the settings an OAuth mailbox has. */
export interface UpdateEmailReceiptMailboxSettingsPayload {
  folder?: string;
  enabled?: boolean;
  aiMode?: EmailReceiptAiMode;
  autoApply?: boolean;
  profileProposalsCountTowardAiLimit?: boolean;
}

/** `POST /email-receipts/mailbox/test`: a draft; a field left out is read from the stored mailbox. */
export interface TestEmailReceiptMailboxPayload {
  host?: string;
  port?: number;
  security?: EmailReceiptMailboxSecurity;
  username?: string;
  password?: string;
  folder?: string;
}

export type EmailReceiptMailboxTestResult =
  | { ok: true; messages: number }
  | { ok: false; error: string };

export interface EmailReceiptPollResult {
  ok: boolean;
  busy?: boolean;
  /** Emails stored by this poll. */
  fetched: number;
  /** Messages stored as skipped (too large or undecodable). */
  skipped: number;
  /** Stored emails the pipeline acted on. */
  processed: number;
  error?: string;
}

/** Why one uploaded archive file was refused; `null` on a file that was read. */
export type EmailReceiptImportFileError =
  | 'unsupported_format'
  | 'invalid_archive'
  | 'archive_too_large'
  | 'empty';

/** What the import did with one uploaded file. */
export interface EmailReceiptImportFileResult {
  name: string;
  /** `null` when the file was refused. */
  format: 'eml' | 'mbox' | 'msg' | 'zip' | null;
  /** Messages found in the file. */
  messages: number;
  /** New rows, stored as pending. */
  stored: number;
  /** Messages that were already imported. */
  duplicates: number;
  /** Messages stored as skipped (too large or undecodable). */
  skipped: number;
  /** ZIP entries that are not mail files; 0 for any other format. */
  ignoredEntries: number;
  error: EmailReceiptImportFileError | null;
}

export interface EmailReceiptImportResult {
  files: EmailReceiptImportFileResult[];
  /** Messages not read because of the per-request message cap. */
  truncated: number;
  /** Stored emails the run took through the pipeline. */
  processed: number;
  /** The poll lease was held: nothing was processed, the rows wait for the next read. */
  busy: boolean;
}

/** Which OAuth providers the operator configured, and the redirect URI to register. */
export interface EmailReceiptOAuthProviders {
  google: boolean;
  microsoft: boolean;
  redirectUri: string;
}

// --------------------------------------------------------------- receipts

export interface EmailReceiptTransactionSummary {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
  currencyCode: string;
  payeeName: string | null;
}

export interface EmailReceiptCandidateSummary extends EmailReceiptTransactionSummary {
  description: string | null;
  /** A trade email's candidate (an investment transaction): its share count; absent for a bank transaction. */
  quantity?: number;
}

/** The investment transaction a trade email accounts for: the one its approval booked, a person linked, or already in the ledger. */
export interface EmailReceiptInvestmentSummary {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  action: string;
  symbol: string;
  quantity: number;
  /** In the security's currency. */
  totalAmount: number;
  currencyCode: string;
}

/** The investment transaction an email's open `email_trade` request proposes: the review card's own preview. */
export interface EmailReceiptTradeProposal {
  accountName: string;
  /** YYYY-MM-DD. */
  date: string;
  action: TradeAction;
  symbol: string;
  securityName: string | null;
  /** Null only for a cash dividend paid as one amount. */
  quantity: number | null;
  /** Per share, in the security's currency; null only for a cash dividend paid as one amount. */
  price: number | null;
  commission: number;
  /** In the security's currency. */
  totalAmount: number;
  currencyCode: string;
}

/** A component a settlement's part joined (linked receipts spec 5). */
export interface EmailReceiptLinkedComponent {
  /** The settlement's item index the component paid for. */
  partIndex: number;
  receiptId: string;
  subject: string;
  /** ISO timestamp: `original_sent_at ?? received_at` of the component. */
  effectiveDate: string;
}

/** A settlement part that names a component, seen from the component. */
export interface EmailReceiptLinkedSettlement {
  receiptId: string;
  subject: string;
  /** ISO timestamp: `original_sent_at ?? received_at` of the settlement. */
  effectiveDate: string;
  /** The part's amount, a decimal number. */
  partAmount: number;
  /** What the join did with the part (`ReceiptLinkOutcome`). */
  outcome: string;
  /** The transaction the settlement is matched to, when it is. */
  transactionId: string | null;
}

/** The email that enriched the transaction a settlement stopped at. */
export interface EmailReceiptEnrichedBy {
  receiptId: string;
  subject: string;
}

/** One stored email in the list: never its text. */
export interface EmailReceiptListItem {
  id: string;
  fromAddress: string;
  fromDomain: string;
  subject: string;
  receivedAt: string;
  /**
   * The mailbox's own From when the email was a forward of an order
   * confirmation; `fromAddress`, `fromDomain` and `subject` are then the shop's.
   */
  forwardedBy: string | null;
  /** When the shop sent the order (a forward's original date), else null. ISO timestamp. */
  originalSentAt: string | null;
  /**
   * The day the match window is centred on: `originalSentAt` when known, else
   * `receivedAt`. The transaction picker's default range is built from this.
   */
  effectiveDate: string;
  status: EmailReceiptStatus;
  statusReason: string | null;
  matchKind: EmailReceiptMatchKind | null;
  parserId: string | null;
  parserName: string | null;
  /** A `component` email's link value; null for every other email. */
  linkKey: string | null;
  aiReviewRequestId: string | null;
  /** A brokerage trade confirmation (`tradeSource` says who reads it): it proposes an investment transaction to create, so the bank-transaction actions do not apply. */
  isTrade: boolean;
  /**
   * Who reads the trade: `profile` (its reading is the detail's `trade`), `ai`
   * (handed to the AI as a trade, with no profile reading), null for no trade.
   * Absent from a server that predates it.
   */
  tradeSource?: 'profile' | 'ai' | null;
  displayState: EmailReceiptDisplayState | null;
  /** Why the request was closed without being applied, when it says. */
  requestNote: string | null;
  transaction: EmailReceiptTransactionSummary | null;
  /** A trade email's ledger row; null for every other email and for a trade email that accounts for none yet. Absent from a server that predates it. */
  investmentTransaction?: EmailReceiptInvestmentSummary | null;
  createdAt: string;
}

/** One line of a schema.org order: the line total is the unit price times the quantity; either is `null` when the markup states none. */
export interface SchemaOrgOrderItem {
  name: string;
  qty: number;
  /** In 1/10000 units. */
  amount: number | null;
  /** In 1/10000 units. */
  unitPrice: number | null;
}

/** The schema.org `Order` or `Invoice` the email carries as markup (JSON-LD or microdata). Amounts are in 1/10000 units. */
export interface SchemaOrgOrder {
  orderNumber: string | null;
  seller: string | null;
  currency: string | null;
  orderDate: string | null;
  total: number | null;
  discount: number | null;
  items: SchemaOrgOrderItem[];
}

/** The lines a parser's patterns are matched against, per `source`; `html` is `null` when the email has no HTML part. */
export interface EmailReceiptLines {
  text: string[];
  html: string[] | null;
}

/** One sender domain of the user's stored emails with how many there are (`GET /email-receipts/domains`). */
export interface EmailReceiptDomainCount {
  domain: string;
  count: number;
  /**
   * How many of them "Process all" would run again (not yet read, or in a state
   * a new profile or transaction can change). Absent from a server that predates it.
   */
  processable?: number;
}

/** How many stored emails are in each state (`GET /email-receipts/status-counts`); a state with none may be absent. */
export type EmailReceiptStatusCounts = Partial<Record<EmailReceiptStatus, number>>;

/** The statuses "Process all" acts on: the pipeline can run them again; `review` stands behind a proposal a person decides. */
export const EMAIL_RECEIPT_PROCESSABLE_STATUSES = [
  'pending',
  'no_parser',
  'parse_failed',
  'unmatched',
  'ambiguous',
  'review_conflict',
] as const;
export type EmailReceiptProcessableStatus = (typeof EMAIL_RECEIPT_PROCESSABLE_STATUSES)[number];

/** What `POST /email-receipts/profile-batch` does with the emails a profile matches: `count` writes nothing. */
export type ProfileBatchAction = 'count' | 'ignore' | 'delete';

/** `POST /email-receipts/profile-batch`. */
export interface ProfileBatchPayload {
  parserId: string;
  action: ProfileBatchAction;
  /** The `next` the previous call answered; omit on the first call. */
  after?: string;
}

/** What one page of a profile's bulk action found and did. */
export interface ProfileBatchResult {
  /** Emails of the page the profile matches (as the pipeline chooses the profile). */
  matched: number;
  /** Of those, the ones whose proposal was already applied: kept by both actions. */
  applied: number;
  /** Of those, the ones that could not be read: kept by `ignore`. */
  unreadable: number;
  /** Of those, the ones already ignored. */
  ignored: number;
  /** Emails this call ignored or deleted (0 for `count`). */
  done: number;
  /** Send back as `after`; null ends the scan. */
  next: string | null;
}

/** `POST /email-receipts/process-batch`. */
export interface ProcessEmailReceiptsPayload {
  domain?: string;
  statuses?: readonly EmailReceiptProcessableStatus[];
  limit?: number;
  /** The `since` the previous call of the same run answered; omit on the first call. */
  since?: string;
}

/** What one call of "process in bulk" did and what is left of the run. */
export interface ProcessEmailReceiptsResult {
  processed: number;
  /** Where the processed emails ended, by their new status (a status with none is absent). */
  byOutcome: Partial<Record<EmailReceiptStatus, number>>;
  /** Processed emails that are gone: their profile deletes every email it matches. Absent from a server that predates it. */
  deleted?: number;
  /** Emails that raised an error and were passed over. */
  failed: number;
  /** Matching emails this run has not touched yet; 0 ends the run. */
  remaining: number;
  /** Send back as `since` in the next call of the same run. */
  since: string;
}

/** `GET /email-receipts/overview`: what the hub's Overview cards show. */
export interface EmailReceiptsOverview {
  /** Null when the user has no mailbox yet. */
  mailbox: {
    enabled: boolean;
    authMethod: EmailReceiptAuthMethod;
    aiMode: EmailReceiptAiMode;
    /** False for an OAuth mailbox that was disconnected or revoked. */
    connected: boolean;
    lastPolledAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  } | null;
  /** Stored emails by status; a status with none is absent. */
  emailsByStatus: Partial<Record<EmailReceiptStatus, number>>;
  /** Emails "Process all" would run. */
  processable: number;
  /** Proposals of the email-receipt kind waiting for approval. */
  proposalsToApprove: number;
  parsers: { approved: number; draft: number };
  /** Sender domains of emails no profile covers, most emails first (at most ten). */
  domainsWithoutProfile: Array<{ domain: string; count: number }>;
}

export interface EmailReceiptDetail extends EmailReceiptListItem {
  bodyText: string;
  /**
   * The HTML part as the sender wrote it, for a sandboxed frame that runs and
   * loads nothing (`EmailHtmlFrame`); `null` when the email has none. Never in the list.
   */
  bodyHtml: string | null;
  /**
   * The numbered lines each source gives (at most 2,000 each): exactly what a
   * parser's patterns match against. Only the detail carries them.
   */
  lines: EmailReceiptLines;
  /** The schema.org order found in the HTML part, or `null` when there is none. */
  structuredOrder: SchemaOrgOrder | null;
  /** The stored `ParsedReceipt`; read it through `readParsedReceipt`. */
  parsed: Record<string, unknown> | null;
  /** What a profile with a `trade` section read (`ParsedTrade`); read it through `readParsedTrade`. Null for every other email. */
  trade: Record<string, unknown> | null;
  /** What the email's `email_trade` request proposes while it waits for approval; null otherwise. Absent from a server that predates it. */
  tradeProposal?: EmailReceiptTradeProposal | null;
  /** Who answers the email's `email_trade` request: its trade profile, or the AI ("Recognize as a trade"); null when it has none. Absent from a server that predates it. */
  tradeRequestSource?: 'profile' | 'ai' | null;
  candidates: EmailReceiptCandidateSummary[];
  /** A settlement: the components its parts joined, by part; empty for every other email. */
  linkedComponents: EmailReceiptLinkedComponent[];
  /** A component: the settlements whose parts name it, newest first, at most 20; empty for every other email. */
  linkedSettlements: EmailReceiptLinkedSettlement[];
  /** A `review_conflict` with reason `enriched_by_other`: the email that enriched the candidate transaction; null otherwise or when it is gone. */
  enrichedBy: EmailReceiptEnrichedBy | null;
}

/**
 * What a profile with a `trade` section read from a brokerage trade confirmation
 * (`ParsedTrade` in `backend/src/email-receipts/parsing/receipt-parser.types.ts`).
 * `quantity` is a share count; `total`, `price` and `commission` are in 1/10000
 * units (convert once with `fromReceiptUnits`); `date` is `YYYY-MM-DD`. A value
 * the email did not state is `null`. A cash dividend (`DIVIDEND`) needs no
 * share count, so a complete dividend may carry a null `quantity` and `price`.
 */
export interface ParsedTrade {
  action: TradeAction | null;
  symbol: string | null;
  quantity: number | null;
  total: number | null;
  price: number | null;
  commission: number | null;
  /**
   * The trade's currency ("USD"): the one the amounts name, else a currency
   * marker's, else (only when an account rule needs it) the security's; null
   * when none of them says, or from a server that predates it.
   */
  currency: string | null;
  /** Which of the three decided `currency`; null with it. Absent from a server that predates it. */
  currencySource?: TradeCurrencySource | null;
  date: string | null;
  accountText: string | null;
  accountId: string | null;
  complete: boolean;
  /** Whether shares times price agrees with the total; null when the email does not state all three to check. */
  consistent: boolean | null;
  reason: string | null;
}

const isNullableNumber = (value: unknown): value is number | null => value === null || typeof value === 'number';
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** The stored trade as a typed object, or null when it is absent or not the shape this client reads. */
export function readParsedTrade(value: Record<string, unknown> | null | undefined): ParsedTrade | null {
  if (!value) return null;
  const { action, symbol, quantity, total, price, commission, date, accountText, accountId, complete, consistent, reason } =
    value;
  const currency = value.currency ?? null;
  // A source this client does not know is no source, not a reason to drop the reading.
  const currencySource = TRADE_CURRENCY_SOURCES.find((source) => source === value.currencySource) ?? null;
  const tradeAction = tradeActionOf(action);
  if (
    (tradeAction === null && action !== null) ||
    !isNullableString(symbol) ||
    !isNullableNumber(quantity) ||
    !isNullableNumber(total) ||
    !isNullableNumber(price) ||
    !isNullableNumber(commission) ||
    !isNullableString(date) ||
    !isNullableString(accountText) ||
    !isNullableString(accountId) ||
    typeof complete !== 'boolean' ||
    (consistent !== null && typeof consistent !== 'boolean') ||
    !isNullableString(reason) ||
    !isNullableString(currency)
  ) {
    return null;
  }
  return {
    action: tradeAction,
    symbol,
    quantity,
    total,
    price,
    commission,
    currency,
    currencySource,
    date,
    accountText,
    accountId,
    complete,
    consistent,
    reason,
  };
}

/**
 * `POST /email-receipts/:id/ask-ai`: the request now waits, pending, in the AI
 * review inbox for whoever claims it by id (the assistant in the chat, or an
 * MCP agent). Nothing has answered it yet.
 */
export interface EmailReceiptAskAiResult {
  ok: true;
  requestId: string;
  /** The transaction the request is about; null for a trade, which creates one. */
  transactionId: string | null;
}

/**
 * `POST /email-receipt-parsers/draft-with-ai`: the request now waits, pending,
 * in the AI review inbox for whoever claims it by id (the assistant in the
 * chat, or an MCP agent). No provider was called.
 */
export interface EmailReceiptParserDraftRequestResult {
  ok: true;
  requestId: string;
}

/** Most emails of one sender domain one "Draft parser with AI" request names (the server's bound). */
export const MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN = 5;

/** Most sender domains one "Draft parser with AI" request spans (the server's bound); a trade draft takes one. */
export const MAX_PARSER_DRAFT_DOMAINS = 5;

/** What a bulk command does to the emails it names. */
export type EmailReceiptBulkAction = 'delete' | 'ignore';

/** Where the list's free-text search looks: every field, or one of them ("sender" is the address, the domain and the forwarder). */
export const EMAIL_RECEIPT_SEARCH_FIELDS = ['all', 'subject', 'sender', 'body'] as const;
export type EmailReceiptSearchField = (typeof EMAIL_RECEIPT_SEARCH_FIELDS)[number];

/** Longest search text the server accepts. */
export const EMAIL_RECEIPT_SEARCH_MAX_LENGTH = 200;

/**
 * The list's search as the server takes it (`GET /email-receipts` and its
 * `status-counts` and `domains`, and a bulk filter). A field left out is not
 * applied; `searchIn` is left out for "all" and when there is no `search`.
 * `dateFrom` and `dateTo` are `YYYY-MM-DD`, inclusive, on the UTC day of the
 * email's `effectiveDate` (the date the list shows), not of `receivedAt`.
 */
export interface EmailReceiptSearch {
  search?: string;
  searchIn?: EmailReceiptSearchField;
  dateFrom?: string;
  dateTo?: string;
}

/** The list's own filter (state, sender domain and search), as a bulk command names its emails. */
export interface EmailReceiptBulkFilter extends EmailReceiptSearch {
  status?: EmailReceiptStatus;
  domain?: string;
  /** States taken out of the selection (the server takes each state once). */
  excludeStatuses?: EmailReceiptStatus[];
  /** Sender domains taken out of the selection, each with its sub-domains (the server's bound is 50). */
  excludeDomains?: string[];
  /** `YYYY-MM-DD`, inclusive, on the UTC day of `receivedAt`: earlier emails are out of the selection. */
  receivedFrom?: string;
  /** `YYYY-MM-DD`, inclusive, on the UTC day of `receivedAt`: later emails are out of the selection. */
  receivedTo?: string;
}

/** The emails a bulk command names: the ticked rows' ids, or the list's (narrowed) filter. */
export type EmailReceiptBulkScope = { ids: string[] } | { filter: EmailReceiptBulkFilter };

/** Body of `POST /email-receipts/bulk/reprocess`: one call runs at most `limit` emails; send the answer's `since` back to continue. */
export type EmailReceiptBulkReprocessPayload = EmailReceiptBulkScope & {
  onlyStatuses?: EmailReceiptStatus[];
  since?: string;
  limit?: number;
};

/** What one reprocess call did, and how many eligible emails are left in the run. */
export interface EmailReceiptBulkReprocessResult {
  processed: number;
  failed: number;
  byOutcome: Record<string, number>;
  remaining: number;
  since: string;
}

/** `POST /email-receipts/bulk/approvable`: the proposals a selection can approve and the trade emails left out. */
export interface EmailReceiptBulkApprovable {
  requestIds: string[];
  trades: number;
}

/** What approving many proposals did. */
export interface EmailReceiptApproveResult {
  approved: number;
  failed: number;
}

/** Most review requests one `approve-batch` call takes (the server's bound). */
export const AI_REVIEW_APPROVE_BATCH_MAX = 100;

/**
 * Body of `POST /email-receipts/bulk`: the emails by id, or by the list's
 * filter, and how many the person was told. A different count is refused (409).
 */
export type EmailReceiptBulkPayload = {
  action: EmailReceiptBulkAction;
  expectedCount: number;
} & ({ ids: string[] } | { filter: EmailReceiptBulkFilter });

/** What a bulk command did; the four counts partition the matching emails. */
export interface EmailReceiptBulkResult {
  /** Deleted, or turned to ignored. */
  affected: number;
  /** Linked to a transaction: a bulk command never touches them. */
  skippedLinked: number;
  /** Ignore only: already ignored. */
  unchanged: number;
  /** Ignore only: unreadable, or a proposal already applied. */
  notIgnorable: number;
}

/** Most emails one bulk request may name by id (the server's bound). */
export const EMAIL_RECEIPT_BULK_MAX_IDS = 500;

// ---------------------------------------------------------------- parsers

/** Bounds the server's validator enforces (`receipt-parser.types.ts`), mirrored so the form says so first. */
export const RECEIPT_PARSER_LIMITS = {
  maxPatternsPerField: 10,
  maxPatternLength: 200,
  /** Consecutive lines one multi-line pattern (parts joined by `\n`) may span. */
  maxPatternLines: 5,
  maxCategoryRules: 50,
  maxSectionMarkerLength: 100,
  maxSkipLines: 10,
  maxRecordSteps: 6,
  maxLabelWithin: 10,
  maxStepAlternatives: 5,
  maxLineGuards: 10,
  maxNameLength: 100,
  maxFromDomains: 10,
  /** `link.daysBefore` of a settlement profile (0 to this). */
  maxLinkDaysBefore: 365,
  maxSubjectWords: 10,
  maxSubjectWordLength: 100,
  maxTagLength: 50,
  maxMatchStrategies: 4,
  maxDaysBefore: 60,
  maxDaysAfter: 90,
  /** The largest amount tolerance, in whole currency units (`"5.00"`). */
  maxAmountTolerance: 5,
  /** A trade section's account rules (`MAX_TRADE_ACCOUNT_RULES`) and its currency markers. */
  maxTradeAccountRules: 20,
  maxTradeCurrencyMarkers: 20,
} as const;

/** The days of the window and the amount tolerance a profile that says nothing uses. */
export const DEFAULT_MATCH_DAYS_BEFORE = 3;
export const DEFAULT_MATCH_DAYS_AFTER = 14;

/** Items read one per line. */
export interface ReceiptItemsDefinition {
  startAfter?: string;
  stopAt?: string;
  patterns: string[];
  /** A line no pattern reads is held (the last three) and put in front of the next line. */
  joinWrapped?: boolean;
}

/** An entry of a field that finds its value on a line near a label line. */
export interface ReceiptLabelledPattern {
  label: string;
  value: string;
  within?: number;
}

/** A field entry: a line pattern or a labelled one. Entries are tried in array order. */
export type ReceiptFieldEntry = string | ReceiptLabelledPattern;

export interface ReceiptRecordStep {
  /** A glob, or up to five alternative globs tried in order. */
  line: string | string[];
  optional?: boolean;
}

/** Items that span several lines: lines to drop, then a record read from a cursor. */
export interface ReceiptBlockItemsDefinition {
  startAfter?: string;
  stopAt?: string;
  skipLines?: string[];
  record: ReceiptRecordStep[];
}

export interface ReceiptCategoryRule {
  match: string;
  categoryId: string;
  /** What the glob is matched against: the item's name (default), the parsed payee or any line. */
  field?: 'item' | 'payee' | 'line';
}

/** One item for the whole email: its name from the first line the glob reads. */
export interface ReceiptSingleItemsDefinition {
  startAfter?: string;
  stopAt?: string;
  single: { name: string };
}

/** How a profile identifies the bank transaction an email paid for, tried in the profile's order. */
export const RECEIPT_MATCH_STRATEGIES = ['reference', 'orderId', 'amount_payee', 'amount_date'] as const;
export type ReceiptMatchStrategy = (typeof RECEIPT_MATCH_STRATEGIES)[number];

/** The strategies tried when a profile names none: the matching a profile without a `match` section always had. */
export const DEFAULT_MATCH_BY: readonly ReceiptMatchStrategy[] = ['orderId', 'amount_payee', 'amount_date'];

/** The transaction fields `reference` and `orderId` are looked for in. */
export const RECEIPT_MATCH_TEXT_FIELDS = ['description', 'payee', 'referenceNumber'] as const;
export type ReceiptMatchTextField = (typeof RECEIPT_MATCH_TEXT_FIELDS)[number];

/** The `match` section of a profile; every key is optional. `amountTolerance` is a decimal string ("0.00" to "5.00"). */
export interface ReceiptMatchDefinition {
  by?: ReceiptMatchStrategy[];
  referenceIn?: ReceiptMatchTextField[];
  daysBefore?: number;
  daysAfter?: number;
  amountTolerance?: string;
}

/** Which lines a parser reads: the email's text (the default) or the lines of its HTML part. */
export const RECEIPT_LINES_SOURCES = ['text', 'html'] as const;
export type ReceiptLinesSource = (typeof RECEIPT_LINES_SOURCES)[number];

/**
 * Which brokerage account a trade email is for. Rules are tried in order
 * against the account text the `account` entries read (the empty text when the
 * email prints none, so only a `*` rule matches it). A rule with no `currency`
 * wins when its glob matches; one with a `currency` wins only when the trade's
 * currency is that one, is skipped when it is another, and fails the reading
 * (`trade_no_currency`) when the currency cannot be told: it never guesses.
 */
export interface ReceiptTradeAccountRule {
  match: string;
  /** An open INVESTMENT account of the user's that is not the cash sleeve. */
  accountId: string;
  /** A 3-letter uppercase code; absent applies to any currency. */
  currency?: string;
}

/** A glob tested against every line of the email (no captures): the first that matches names the trade's currency. */
export interface ReceiptTradeCurrencyMarker {
  match: string;
  currency: string;
}

/**
 * The `trade` section of a profile: the email is read as one investment
 * transaction to create. Each field is a list of entries read like a receipt
 * field; the capture each takes is `{action}`, `{symbol}`, `{quantity}`,
 * `{amount}` (total, price, commission), `{date}` and `{account}`. `action`,
 * `symbol` and one of `total`/`price` are required; `quantity` is optional in
 * the definition, but a buy, a sell or a reinvested dividend read without one
 * is `trade_no_quantity` (a cash dividend needs none).
 */
export interface ReceiptTradeDefinition {
  action: ReceiptFieldEntry[];
  symbol: ReceiptFieldEntry[];
  quantity?: ReceiptFieldEntry[];
  total?: ReceiptFieldEntry[];
  price?: ReceiptFieldEntry[];
  commission?: ReceiptFieldEntry[];
  date?: ReceiptFieldEntry[];
  account?: ReceiptFieldEntry[];
  accountRules?: ReceiptTradeAccountRule[];
  defaultAccountId?: string;
  currencyMarkers?: ReceiptTradeCurrencyMarker[];
}

/** The `link` section of a settlement profile: where its parts look for their components. */
export interface ReceiptLinkDefinition {
  /** 1 to 10 sender domains the search is limited to; absent means any sender. */
  fromDomains?: string[];
  /** 0 to 365 (default 120): how many days before the settlement's date a component may be dated. */
  daysBefore?: number;
}

/** A parser definition, version 2 (`definition` of an `email_receipt_parsers` row). */
/** What a profile does with the emails it matches instead of reading them: ignore them, or delete them. */
export const RECEIPT_DISCARD_MODES = ['ignore', 'delete'] as const;
export type ReceiptDiscardMode = (typeof RECEIPT_DISCARD_MODES)[number];

export interface ReceiptParserDefinition {
  version: 2;
  /** The lines the patterns read: the email's text (default) or its HTML part. */
  source?: ReceiptLinesSource;
  orderId?: ReceiptFieldEntry[];
  total?: ReceiptFieldEntry[];
  paid?: ReceiptFieldEntry[];
  shipping?: ReceiptFieldEntry[];
  discount?: ReceiptFieldEntry[];
  payee?: ReceiptFieldEntry[];
  /** An identifier the shop or the payment gateway puts into the bank operation. Capture `{reference}`. */
  reference?: ReceiptFieldEntry[];
  match?: ReceiptMatchDefinition;
  /** What the profile's emails are for; absent is `standalone`. */
  role?: ReceiptParserRole;
  /** A `component` only: the key that ties the email to a settlement. Capture `{link}`. */
  linkKey?: ReceiptFieldEntry[];
  /** A `settlement` only: where its parts look for their components. */
  link?: ReceiptLinkDefinition;
  /** A tag the proposal adds to every transaction the profile categorises. */
  tag?: string;
  /** Ask the user's AI for the category of an item no rule matched. */
  aiCategories?: boolean;
  items?: ReceiptItemsDefinition | ReceiptBlockItemsDefinition | ReceiptSingleItemsDefinition;
  /** Fees of the order (a payment or handling charge), read like `shipping`. Capture `{amount}`. */
  fees?: ReceiptFieldEntry[];
  /** How far the items may differ from the bank amount before the proposal is not balanced; a decimal string. */
  balanceTolerance?: string;
  /** Advanced, edited as JSON only: rules in order, the first whose glob matches an item's name wins. */
  categoryRules?: ReceiptCategoryRule[];
  /** Categories are named, not identified: the full name as the category list shows it (`Parent: Child`). */
  defaultCategory?: string;
  shippingCategory?: string;
  feesCategory?: string;
  /**
   * A brokerage trade confirmation. A profile with this section holds no
   * receipt field, item, category or match section (`trade_conflict`): only
   * `source` and the three line guards beside it.
   */
  trade?: ReceiptTradeDefinition;
  requireLine?: string[];
  skipIfLine?: string[];
  waitIfLine?: string[];
  /** What the profile does with every email it matches instead of reading it; absent: it reads them. */
  discard?: ReceiptDiscardMode;
}

/** One problem the server's validator found: where, and a machine-readable code. */
export interface ReceiptParserValidationError {
  path: string;
  code: string;
}

export interface EmailReceiptParser {
  id: string;
  name: string;
  payeeId: string | null;
  fromDomains: string[];
  subjectContains: string[];
  definition: Record<string, unknown>;
  definitionValid: boolean;
  definitionErrors: ReceiptParserValidationError[];
  status: EmailReceiptParserStatus;
  source: EmailReceiptParserSource;
  approvedAt: string | null;
  revision: number;
  /**
   * Stored emails of the profile's domains, in a processable state, last processed
   * before the profile's last change. Absent from a server that predates it.
   */
  reprocessableCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmailReceiptParserPayload {
  name: string;
  payeeId?: string | null;
  fromDomains: string[];
  subjectContains?: string[];
  definition: ReceiptParserDefinition;
}

export interface UpdateEmailReceiptParserPayload extends Partial<CreateEmailReceiptParserPayload> {
  expectedRevision: number;
}

export interface TestEmailReceiptParserPayload {
  definition: ReceiptParserDefinition;
  receiptId: string;
  payeeId?: string | null;
}

export interface ParsedReceiptItem {
  name: string;
  qty: number;
  /** The line total, in 1/10000 units. */
  amount: number;
  categoryId: string | null;
  /** `"ai"` when the AI chose this item's category. */
  categorySource?: 'ai';
  /** What the line is; absent is `item`. Only a joined component's lines carry another kind. */
  kind?: ReceiptLineKind;
  /** A settlement part's link value; absent otherwise. */
  link?: string;
  /** A settlement part's instalment text; absent otherwise. */
  instalment?: string;
}

/** The report of one settlement part (`ParsedReceipt.links`). Amounts are in 1/10000 units. */
export interface ReceiptLinkReport {
  partIndex: number;
  /** The part's link value; null when it captured none. */
  link: string | null;
  partAmount: number;
  outcome: ReceiptLinkOutcome;
  /** The component found; null when none was. */
  componentReceiptId: string | null;
  /** The component's net (its lines, discount subtracted). */
  componentNet?: number;
  /** What other settlements already took from the component. */
  taken?: number;
  /** How many components the link found (more than one: a resend). */
  several?: number;
  /** Why an incomplete component is incomplete. */
  componentReason?: ParsedReceiptReason | null;
}

/** What a parser read from one email. Every amount is in 1/10000 units; null means the email did not state it. */
export interface ParsedReceipt {
  orderId: string | null;
  total: number | null;
  /** What was actually charged, when the email states it separately. Absent on a receipt stored before the field existed. */
  paid?: number | null;
  /** The merchant the email names (a payment gateway's notice). Absent on a receipt stored before the field existed. */
  payee?: string | null;
  /** The identifier the profile's `reference` field read. Absent on a receipt stored before the field existed. */
  reference?: string | null;
  /** A component's link value; null when its email holds none. Absent on every other receipt. */
  linkKey?: string | null;
  shipping: number | null;
  discount: number | null;
  items: ParsedReceiptItem[];
  shippingCategoryId: string | null;
  discountCategoryId: string | null;
  /** A joined settlement only: one report per part. */
  links?: ReceiptLinkReport[];
  complete: boolean;
  reason: ParsedReceiptReason | null;
  /** Who read the email: a saved parser, the AI, or the email's own schema.org markup. Absent on a receipt stored before the field existed. */
  source?: 'parser' | 'ai' | 'schema_org';
}

export type ReceiptMatchResult =
  | { kind: 'matched'; transactionId: string; matchKind: Exclude<EmailReceiptMatchKind, 'manual' | 'amount_only'> }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'unmatched' };

/** A transaction a matching strategy kept. */
export interface ReceiptMatchTraceTransaction {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
  payeeName: string | null;
}

/** What one strategy kept: how many candidates, and the first ten. */
export interface ReceiptMatchTraceAttempt {
  strategy: ReceiptMatchStrategy;
  count: number;
  transactions: ReceiptMatchTraceTransaction[];
}

/** What the matcher looked at: the window, the strategies in order, and what each kept. */
export interface ReceiptMatchTrace {
  window: { from: string; to: string };
  daysBefore: number;
  daysAfter: number;
  /** In 1/10000 units. */
  toleranceUnits: number;
  referenceIn: ReceiptMatchTextField[];
  by: ReceiptMatchStrategy[];
  /** Candidates inside the window. */
  considered: number;
  /** The strategies tried, up to and including the one that decided. */
  attempts: ReceiptMatchTraceAttempt[];
  /** The strategy that matched or found several candidates; null when none did. */
  decidedBy: ReceiptMatchStrategy | null;
}

/** A line a trace points at: its 1-based number (0 is the subject) and its text. */
export interface ReceiptTraceLine {
  line: number;
  text: string;
}

/** What found one value: the entry index of the field, its glob and the line that produced it. */
export interface ReceiptTraceHit {
  entry: number;
  /** The line glob; for a labelled entry, its `value` glob. */
  pattern: string;
  /** A labelled entry's label glob and the line it matched. */
  label?: string;
  labelLine?: ReceiptTraceLine;
  /** The line the value was read from; for a multi-line pattern, the first line it matched. */
  line: ReceiptTraceLine;
  /** A multi-line pattern: every line it matched, first to last (absent for a one-line match). */
  lines?: ReceiptTraceLine[];
}

export interface ReceiptTraceItem {
  mode: 'patterns' | 'record' | 'single';
  patterns: string[];
  lines: ReceiptTraceLine[];
}

/** The fields a trace names, in the order the panel lists them. */
export const RECEIPT_TRACE_FIELDS = [
  'orderId',
  'reference',
  'total',
  'paid',
  'shipping',
  'discount',
  'payee',
  'requireLine',
  'skipIfLine',
  'waitIfLine',
  'linkKey',
] as const;
export type ReceiptTraceField = (typeof RECEIPT_TRACE_FIELDS)[number];

/** `linkKey` is the line a component's link value was read from; absent from a profile that is not a component and from a server that predates it. */
export type ReceiptTrace = Record<Exclude<ReceiptTraceField, 'linkKey'>, ReceiptTraceHit | null> & {
  linkKey?: ReceiptTraceHit | null;
  items: ReceiptTraceItem[];
};

/** The fields a trade trace names, in the order the panel lists them. */
export const RECEIPT_TRADE_TRACE_FIELDS = [
  'action',
  'symbol',
  'quantity',
  'total',
  'price',
  'commission',
  'date',
  'account',
  'currency',
] as const;
export type ReceiptTradeTraceField = (typeof RECEIPT_TRADE_TRACE_FIELDS)[number];
/** `currency` is the currency marker that named the currency (`entry` is its index in `currencyMarkers`); absent from a server that predates it. */
export type ReceiptTradeTrace = Record<Exclude<ReceiptTradeTraceField, 'currency'>, ReceiptTraceHit | null> & {
  currency?: ReceiptTraceHit | null;
};

/** What the pipeline would do with the email under this parser (`no_html`: it reads the HTML part and the email has none). */
export type ReceiptOutcome =
  | 'read'
  | 'not_applicable'
  | 'skip_line'
  | 'wait_line'
  | 'discard_ignore'
  | 'discard_delete'
  | 'no_html';

/** A settlement waiting for a component's link key (`WaitingSettlement`). */
export interface ParserTestWaitingSettlement {
  id: string;
  subject: string;
  /** `YYYY-MM-DD` (UTC): `original_sent_at ?? received_at`. */
  effectiveDate: string;
}

/** One part of a settlement as the test's join read it. Amounts are in 1/10000 units; `componentNet` and `taken` are null without a complete component. */
export interface ParserTestLink {
  partIndex: number;
  /** The part's link value; null when it captured none. */
  link: string | null;
  /** The component the link found (the newest of several); null when none. */
  component: {
    id: string;
    subject: string;
    /** `YYYY-MM-DD`. */
    effectiveDate: string;
    /** The name of the component's profile; null when it has none. */
    profileName: string | null;
  } | null;
  partAmount: number;
  componentNet: number | null;
  taken: number | null;
  outcome: ReceiptLinkOutcome;
  /** How many components the link found: 0, 1 or more. */
  several: number;
}

export interface EmailReceiptParserTestResult {
  /**
   * For a `component` profile: the link value it read and the settlements
   * waiting for it (newest first, at most 20). Such an email is not matched to
   * a bank transaction, so `match` is empty.
   */
  component?: { linkKey: string | null; waitingSettlements: ParserTestWaitingSettlement[] };
  /** For a `settlement` profile: one entry per part. `parsed` is then the JOINED reading. */
  links?: ParserTestLink[];
  /**
   * For a profile with a `trade` section: what it read, and which entry and
   * line read each value (`trace`, absent from a server that predates it).
   * Such a profile is not matched to a bank transaction, so `parsed` and
   * `match` are then empty.
   */
  trade?: { parsed: ParsedTrade; trace?: ReceiptTradeTrace };
  parsed: ParsedReceipt;
  /** Which entry and which line read each value. Absent from a server that predates it. */
  trace?: ReceiptTrace;
  outcome?: ReceiptOutcome;
  match: ReceiptMatchResult;
  /** What the matcher looked at, by strategy. Absent from a server that predates it. */
  matchTrace?: ReceiptMatchTrace;
  /** Candidate transactions the matcher was given. */
  candidateCount: number;
  /** The matched transaction, when there is one (an ordinary amount, no currency). */
  transaction: { id: string; date: string; amount: number; payeeName: string | null } | null;
}

/** One sender domain with stored emails and no approved profile (`GET /email-receipts/domains/uncovered`). */
export interface UncoveredDomain {
  domain: string;
  count: number;
  /** A draft profile already written for the domain, or null. */
  draftParserId: string | null;
  /** The request in the AI inbox that asks the user's agent for a profile for this domain, or null. */
  pendingRequestId: string | null;
  /** `pending` until an agent takes the request, `claimed` while it works; null without a request. */
  pendingRequestStatus: 'pending' | 'claimed' | null;
}

/** One email of the domain paired with the transaction it paid for (a wizard sample). */
export interface ParserSamplePair {
  receiptId: string;
  transactionId: string;
}

/** `POST /email-receipt-parsers/generate-with-ai`: 1 to 5 samples; `parserId` and `feedback` revise an existing draft. */
export interface GenerateParserWithAiPayload {
  domain: string;
  /** What the profile reads: an order email (default) or a brokerage trade confirmation. */
  kind?: 'receipt' | 'trade';
  /** kind receipt: each email with the transaction it paid for. */
  samples?: ParserSamplePair[];
  /** kind trade: the confirmation emails (a trade pays no bank transaction). */
  tradeReceiptIds?: string[];
  parserId?: string;
  feedback?: string;
}

/** The assistant ran now and saved a draft. */
export interface GenerateParserSavedResult {
  status: 'saved';
  parserId: string;
  revision: number;
  /** What the assistant said about its work. */
  answer: string;
}

/** The user's own agent (the MCP relay) answers: the request waits in the AI inbox. */
export interface GenerateParserQueuedResult {
  status: 'queued';
  requestId: string;
}

export type GenerateParserWithAiResult = GenerateParserSavedResult | GenerateParserQueuedResult;

/** `POST /email-receipt-parsers/:id/preview`. */
export interface PreviewEmailReceiptParserPayload {
  selectedReceiptIds: string[];
  expected?: ParserSamplePair[];
}

export interface ParserPreviewTransaction {
  transactionId: string;
  summary: string;
}

export const PARSER_PREVIEW_OUTCOMES = [
  'matched',
  'ambiguous',
  'unmatched',
  'parse_failed',
  'not_applicable',
  'skip_line',
  'wait_line',
  'discard_ignore',
  'discard_delete',
  'no_html',
  'trade',
  'trade_exists',
  'component',
] as const;
export type ParserPreviewOutcome = (typeof PARSER_PREVIEW_OUTCOMES)[number];

export interface ParserPreviewItem {
  receiptId: string;
  subject: string;
  receivedAt: string;
  /** The date to show: when the shop sent the email if a forward carried it, else when it arrived (ISO). */
  effectiveDate: string;
  /** How the draft would read the email; the server's `ParserPreviewOutcome`. */
  outcome: ParserPreviewOutcome;
  statusReason: string | null;
  /** For a trade profile: what it read (shares, ticker, direction); null for a receipt or when a guard stopped the read. */
  trade: {
    action: TradeAction | null;
    symbol: string | null;
    /** Null when the email stated none; a cash dividend needs none. */
    quantity: number | null;
    consistent: boolean | null;
    /** The account the reading books to; null when none was found. Absent from a server that predates it. */
    accountId?: string | null;
    /** The trade's currency (as `parsed.currency`); null when it could not be told. Absent from a server that predates it. */
    currency?: string | null;
  } | null;
  /** For a trade item, `currency` is the trade's currency. */
  parsed: { date: string | null; total: number | null; currency: string | null; lineCount: number } | null;
  match: ParserPreviewTransaction | null;
  expected: ParserPreviewTransaction | null;
  /** Whether the parsed date and total agree with the expected transaction; null without an expectation. */
  agrees: boolean | null;
}

export interface ParserPreviewResult {
  selected: ParserPreviewItem[];
  others: ParserPreviewItem[];
  /** How many other emails the domain has; `others` holds the newest 100. */
  othersTotal: number;
}
