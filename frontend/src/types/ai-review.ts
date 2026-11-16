import type { PendingAction } from '@/types/ai';
import type { TradeAction } from '@/types/email-receipts';

/**
 * The AI review inbox as `GET /ai-review-requests` answers it. Mirrors
 * `backend/src/ai-review/ai-review-work.types.ts` (`AiReviewInboxItem`).
 */
export const AI_REVIEW_STATUSES = [
  'pending',
  'claimed',
  'proposed',
  'applied',
  'rejected',
  'expired',
] as const;

export type AiReviewStatus = (typeof AI_REVIEW_STATUSES)[number];

/**
 * What raised a request: a rule or a person (`transaction_review`), a stored
 * order-confirmation email (`email_receipt`), or a person asking for a receipt
 * parser to be written from up to five stored emails (`email_parser_draft`,
 * which is about emails and has no transaction), or a brokerage's trade
 * confirmation email read by a profile (`email_trade`: the proposal is to
 * CREATE an investment transaction, so it has no transaction yet).
 */
export const AI_REVIEW_KINDS = ['transaction_review', 'email_receipt', 'email_parser_draft', 'email_trade'] as const;

export type AiReviewKind = (typeof AI_REVIEW_KINDS)[number];

/** The trade a request of kind `email_trade` proposes (`AiReviewTradeInput`); the card is rebuilt from it. */
export interface AiReviewTrade {
  accountId: string;
  action: TradeAction;
  symbol: string;
  /** Shares; null only for a cash dividend whose email states none. */
  quantity: number | null;
  /** The executed total (a dividend's amount paid), in the security's currency. */
  totalAmount: number;
  commission: number;
  /** YYYY-MM-DD. */
  date: string;
  description: string | null;
  /** The currency the email's amounts named, when they named one. */
  currency?: string | null;
}

/** The email a request of kind `email_receipt` was raised for (`AiReviewInboxEmailReceipt`). */
export interface AiReviewEmailReceipt {
  id: string;
  /** The sender the email is read as: the shop's or broker's for a forward. */
  fromAddress: string;
  /** Who actually sent it when it was the owner's forward, else null; the card names them. */
  forwardedBy: string | null;
  subject: string;
  /** ISO timestamp. */
  receivedAt: string;
}

/** The reviewed transaction as the inbox shows it (not a raw row). */
export interface AiReviewTransactionSummary {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
  currencyCode: string;
  payeeName: string | null;
  description: string | null;
  accountId: string;
  accountName: string | null;
  categoryName: string | null;
  isSplit: boolean;
}

/**
 * A proposal is the confirmation card rebuilt against the transaction as it is
 * now, or the reason it can no longer be built. The card is committed through
 * `POST /ai/actions/confirm`, never here.
 */
export type AiReviewProposal =
  | { action: Omit<PendingAction, 'status'> }
  | { error: string };

/** What an inbox row of kind `email_parser_draft` says (`AiReviewInboxParserDraft`). */
export interface AiReviewParserDraft {
  /** The sender domain the draft is for. */
  domain: string;
  /** How many emails the request names. */
  emailCount: number;
  /** The draft parser an agent saved for it, once `proposed`; else null. */
  parserId: string | null;
  /** Every draft parser saved for it, in save order (one per domain of the request); absent on an older payload. */
  parserIds?: string[];
}

/** The draft parsers a parser-draft row names: every id of `parserIds` when present, else the single `parserId`. */
export function draftParserIds(draft: Pick<AiReviewParserDraft, 'parserId' | 'parserIds'>): string[] {
  if (draft.parserIds && draft.parserIds.length > 0) return draft.parserIds;
  return draft.parserId ? [draft.parserId] : [];
}

/** The fixed instructions the email receipt pipeline writes (`receipt-instructions.ts`). */
export type AiReviewInstructionKey = 'automatic' | 'chat' | 'categorize' | 'parsed' | 'trade' | 'tradeChat';

export interface AiReviewItem {
  id: string;
  kind: AiReviewKind;
  status: AiReviewStatus;
  instruction: string;
  /**
   * Which fixed English instruction an `email_receipt` request carries, so the
   * inbox shows it translated; null for any other instruction (a rule's own words).
   */
  instructionKey: AiReviewInstructionKey | null;
  /** Null for a request of kind `email_parser_draft` or `email_trade`. */
  transactionId: string | null;
  ruleId: string | null;
  ruleName: string | null;
  /** Null unless the request is of kind `email_receipt` and its email still exists. */
  emailReceipt: AiReviewEmailReceipt | null;
  /** Null unless the request is of kind `email_parser_draft`. */
  parserDraft: AiReviewParserDraft | null;
  /** Null unless the request is of kind `email_trade`. */
  trade: AiReviewTrade | null;
  createdAt: string;
  expiresAt: string;
  /** Null when the transaction no longer exists. */
  transaction: AiReviewTransactionSummary | null;
  agentNote?: { reason: string; at: string };
  proposal?: AiReviewProposal;
}

/**
 * The inbox's kind filter: every request, the order-email proposals, or the
 * rules' (and a person's) transaction reviews. A parser-draft request has no card
 * to approve and is listed under "all" only. `?kind=` carries the filter in the URL.
 */
export const AI_REVIEW_KIND_FILTERS = ['all', 'email_receipt', 'transaction_review'] as const;
export type AiReviewKindFilter = (typeof AI_REVIEW_KIND_FILTERS)[number];

/** `?kind=` if it names a filter, else "all". */
export function parseKindFilter(value: string | null): AiReviewKindFilter {
  return AI_REVIEW_KIND_FILTERS.find((filter) => filter === value) ?? 'all';
}

/** A request a person can approve from the list: proposed, with a card that could still be built. */
export function isApprovable(item: AiReviewItem): boolean {
  return item.status === 'proposed' && item.proposal !== undefined && 'action' in item.proposal;
}

/** Whether a request still waits for an agent, so it can be handed to the assistant. */
export function isSendableToAssistant(item: AiReviewItem): boolean {
  return item.status === 'pending';
}

/**
 * What names a request in a list or a message: the sender domain of a parser
 * draft, the email's subject, the transaction's payee or the rule, in that order;
 * `null` when it has none of them.
 */
export function reviewItemLabel(item: AiReviewItem): string | null {
  return (
    item.parserDraft?.domain ??
    item.trade?.symbol ??
    item.emailReceipt?.subject ??
    item.transaction?.payeeName ??
    item.ruleName ??
    null
  );
}

/** What happened to one request of a bulk approval. */
export interface AiReviewApproveBatchItemResult {
  id: string;
  ok: boolean;
  /** Why it was not approved; absent when `ok`. */
  error?: string;
}

/** `POST /ai-review-requests/approve-batch`. */
export interface AiReviewApproveBatchResult {
  results: AiReviewApproveBatchItemResult[];
  approved: number;
  failed: number;
}

/** Most requests one bulk approval names (the server's bound). */
export const AI_REVIEW_APPROVE_BATCH_MAX = 100;

/** The inbox's default view (no status sent): everything waiting, plus expired. */
export type AiReviewFilter = 'open' | AiReviewStatus;
