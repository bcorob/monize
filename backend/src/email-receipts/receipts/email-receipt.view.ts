import type { TradeAction } from "../../ai-review/trade-action";
import type { EmailReceiptMatchKind } from "../entities/email-receipt.entity";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";
import type { SchemaOrgOrder } from "../parsing/schema-org-order";

/**
 * What a `review` receipt's request says about it (design section 6): `proposed`
 * waits for approval, `applied` was written, `dismissed` was rejected (by the
 * person, or by a refusal whose reason is `requestNote`), `expired` ran out,
 * `pending_ai` waits for the AI (or an agent), and `request_missing` means the
 * request row is gone (a restore), which the next poll repairs. Null for every
 * other status.
 */
export type EmailReceiptDisplayState =
  | "proposed"
  | "applied"
  | "dismissed"
  | "expired"
  | "pending_ai"
  | "request_missing";

/** The linked transaction, as far as the receipts page needs it. */
export interface EmailReceiptTransactionSummary {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amount: number;
  currencyCode: string;
  payeeName: string | null;
}

/** A candidate of an ambiguous receipt: the summary plus the text that helps choose. */
export interface EmailReceiptCandidateSummary extends EmailReceiptTransactionSummary {
  description: string | null;
  /** A trade email's candidate (an investment transaction): its share count; absent for a bank transaction. */
  quantity?: number;
}

/** The investment transaction a trade email accounts for (`investment_transaction_id`). */
export interface EmailReceiptInvestmentSummary {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  action: string;
  symbol: string;
  quantity: number;
  /** In the security's currency. */
  totalAmount: number;
  currencyCode: string;
}

/**
 * The investment transaction an email's open `email_trade` request proposes:
 * the review card's own preview (the total the commit stores and the price it
 * derives from it, INV-TRADE-001), never a figure recomputed here.
 */
export interface EmailReceiptTradeProposal {
  accountName: string;
  /** `YYYY-MM-DD`. */
  date: string;
  action: TradeAction;
  symbol: string;
  securityName: string | null;
  /** Null only for a cash dividend that states no share count. */
  quantity: number | null;
  /** Per share, in the security's currency; null only for a cash dividend. */
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
   * confirmation (`fromAddress`, `fromDomain` and `subject` are then the
   * shop's), else null.
   */
  forwardedBy: string | null;
  /** When the shop sent the order, read from a forwarded header block; else null. */
  originalSentAt: string | null;
  /**
   * The day the match window is centred on: `originalSentAt` when known, else
   * `receivedAt` (an ISO timestamp either way).
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
  /**
   * The email is a brokerage trade confirmation (`tradeSource` says who reads
   * it): it proposes an investment transaction to create, so bank-transaction
   * actions do not apply.
   */
  isTrade: boolean;
  /**
   * Who reads the trade: `profile` (a trade profile's reading is in `trade`),
   * `ai` (the email stands behind an `email_trade` request with no profile
   * reading: "Recognize as a trade"), or null for an email that is no trade.
   */
  tradeSource: "profile" | "ai" | null;
  displayState: EmailReceiptDisplayState | null;
  /** Why the request was closed without being applied, when it says. */
  requestNote: string | null;
  transaction: EmailReceiptTransactionSummary | null;
  /** A trade email's ledger row: the one its approval booked, a person linked, or already there; else null. */
  investmentTransaction: EmailReceiptInvestmentSummary | null;
  createdAt: string;
}

/** One stored email with its text, what the parser read and the candidates. */
export interface EmailReceiptDetail extends EmailReceiptListItem {
  bodyText: string;
  /**
   * The HTML part as the sender wrote it, for display in a sandboxed frame that
   * runs nothing and loads nothing; null when the email has none. Only the
   * detail carries it, never the list.
   */
  bodyHtml: string | null;
  /**
   * The lines a parser reads, per source (design 5.1, "Lines source"): what its
   * patterns match against, numbered from 1 as a trace says. `html` is null when
   * the email has no HTML part. Each list holds at most `MAX_PARSE_LINES` lines;
   * only the detail carries them, never the list.
   */
  lines: { text: string[]; html: string[] | null };
  /**
   * The schema.org `Order` or `Invoice` found in the HTML part (JSON-LD or
   * microdata), in 1/10000 units, or null when there is none: what the pipeline
   * reads when no parser does (spec "Structured data").
   */
  structuredOrder: SchemaOrgOrder | null;
  parsed: Record<string, unknown> | null;
  /**
   * What a profile with a `trade` section read (`ParsedTrade`), or null: such an
   * email proposes an investment transaction to create, not a split of a bank
   * transaction, so `parsed` and `candidates` are empty for it.
   */
  trade: Record<string, unknown> | null;
  /**
   * What the email's `email_trade` request proposes while that proposal waits
   * for approval (not expired); null otherwise, and for every other email.
   */
  tradeProposal: EmailReceiptTradeProposal | null;
  /**
   * Who answers the email's `email_trade` request: `profile` for the one a
   * trade profile queued, `ai` for the one "Recognize as a trade" handed to
   * the assistant; null when the email's request is not a trade request.
   */
  tradeRequestSource: "profile" | "ai" | null;
  candidates: EmailReceiptCandidateSummary[];
  /** A settlement: the components its parts joined, by part; empty for every other email. */
  linkedComponents: EmailReceiptLinkedComponent[];
  /** A component: the settlements whose parts name it, newest first, at most 20; empty for every other email. */
  linkedSettlements: EmailReceiptLinkedSettlement[];
  /** A `review_conflict` with reason `enriched_by_other`: the email that enriched the candidate transaction; null otherwise or when it is gone. */
  enrichedBy: EmailReceiptEnrichedBy | null;
}

/** One sender domain of the user's stored emails, with how many there are (`GET /email-receipts/domains`). */
export interface EmailReceiptDomainCount {
  domain: string;
  count: number;
  /**
   * How many of them "process in bulk" would run again (the six statuses a new
   * profile or a new transaction can change): what "Process the N stored emails
   * now?" counts after a profile is approved.
   */
  processable: number;
}

/** The emails by state (`GET /email-receipts/status-counts`); a state with no email is absent. */
export interface EmailReceiptStatusCounts {
  total: number;
  byStatus: Partial<Record<EmailReceiptStatus, number>>;
}

/**
 * What the hub's Overview cards show, from ONE query (`GET
 * /email-receipts/overview`, design 9): the mailbox's state, the stored emails
 * by status, the profiles by status, the proposals waiting for approval and the
 * sender domains no profile covers. Counts only: no email text, no secret.
 */
export interface EmailReceiptsOverview {
  /** Null when the user has no mailbox yet (the first-run wizard's cue). */
  mailbox: {
    enabled: boolean;
    authMethod: "password" | "oauth2";
    aiMode: "off" | "on_demand" | "automatic";
    /** An OAuth2 mailbox that was disconnected or revoked cannot read mail until it is connected again. */
    connected: boolean;
    lastPolledAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  } | null;
  /** Stored emails by status; a status with none is absent. */
  emailsByStatus: Partial<Record<EmailReceiptStatus, number>>;
  /** Emails "Process all" would run: the statuses the pipeline can act on again. */
  processable: number;
  /** Proposals of kind `email_receipt` waiting for the person's approval (not expired). */
  proposalsToApprove: number;
  parsers: { approved: number; draft: number };
  /** Sender domains of `no_parser` emails that no profile (of any status) covers, most emails first, at most ten. */
  domainsWithoutProfile: Array<
    Pick<EmailReceiptDomainCount, "domain" | "count">
  >;
}
