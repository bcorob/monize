import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { EmailReceiptMailbox } from "./email-receipt-mailbox.entity";
import { EmailReceiptParser } from "./email-receipt-parser.entity";

/** Where a stored email stands in the pipeline (design section 6). */
export type EmailReceiptStatus =
  | "pending"
  | "skipped"
  | "no_parser"
  | "parse_failed"
  | "unmatched"
  | "ambiguous"
  | "review_conflict"
  | "review"
  | "ignored"
  | "component";

export const EMAIL_RECEIPT_STATUSES: readonly EmailReceiptStatus[] = [
  "pending",
  "skipped",
  "no_parser",
  "parse_failed",
  "unmatched",
  "ambiguous",
  "review_conflict",
  "review",
  "ignored",
  "component",
];

/**
 * How the receipt was tied to its transaction (the schema's match_kind CHECK):
 * the name of the profile strategy that found it (`reference`, `order_id`,
 * `amount_payee`, `amount_date`) or `manual`. `amount_only` is what a row matched
 * before the strategies were configurable carries: it is read, never written (the
 * same rule is now `amount_date`).
 */
export type EmailReceiptMatchKind =
  | "order_id"
  | "reference"
  | "amount_payee"
  | "amount_date"
  | "amount_only"
  | "manual";

export const EMAIL_RECEIPT_MATCH_KINDS: readonly EmailReceiptMatchKind[] = [
  "order_id",
  "reference",
  "amount_payee",
  "amount_date",
  "amount_only",
  "manual",
];

/** The schema's bounds on a stored email and on the candidate list. */
export const EMAIL_RECEIPT_MAX_BODY_CHARS = 100_000;
export const EMAIL_RECEIPT_MAX_HTML_CHARS = 1_000_000;
export const EMAIL_RECEIPT_MAX_CANDIDATES = 10;

/**
 * One stored order-confirmation email (design sections 3.9, 4 and 6). The raw
 * MIME source is not stored: `bodyText` is the text every parser and prompt
 * reads, and `bodyHtml` is the HTML part kept for display only.
 *
 * A forwarded email (the user forwards from their own address) is stored with
 * the ORIGINAL sender, subject and date read from the forwarded header block:
 * `fromAddress` / `fromDomain` / `subject` are the shop's, `forwardedBy` is the
 * mailbox's own From, and `originalSentAt` is the day the shop sent the order.
 * The match window is centred on `originalSentAt ?? receivedAt`.
 * `(mailboxId, uidValidity, uid)` is the ingestion idempotency, and
 * `aiReviewRequestId` carries no foreign key because `ai_review_requests`
 * references this table.
 *
 * `uidValidity` and `uid` are bigint columns, so strings here. Column defaults
 * mirror `database/migrations/*_add_email_receipts.sql`: the RLS spec builds
 * its schema from these entities.
 */
@Entity("email_receipts")
@Unique("uq_email_receipts_message", ["mailboxId", "uidValidity", "uid"])
@Index("idx_email_receipts_user_status", ["userId", "status", "receivedAt"])
export class EmailReceipt {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "mailbox_id" })
  mailboxId: string;

  @ManyToOne(() => EmailReceiptMailbox, { onDelete: "CASCADE" })
  @JoinColumn({ name: "mailbox_id" })
  mailbox?: EmailReceiptMailbox;

  @Column({ type: "bigint", name: "uid_validity" })
  uidValidity: string;

  @Column({ type: "bigint" })
  uid: string;

  @Column({ type: "varchar", length: 500, name: "message_id", nullable: true })
  messageId: string | null;

  @Column({ type: "varchar", length: 320, name: "from_address" })
  fromAddress: string;

  @Column({ type: "varchar", length: 255, name: "from_domain" })
  fromDomain: string;

  @Column({ type: "varchar", length: 500 })
  subject: string;

  @Column({ type: "timestamptz", name: "received_at" })
  receivedAt: Date;

  @Column({ type: "text", name: "body_text" })
  bodyText: string;

  /** The HTML part as the sender wrote it (display only, never parsed); null when there is none. */
  @Column({ type: "text", name: "body_html", nullable: true })
  bodyHtml: string | null;

  /** The mailbox's From when the message was a forward of an order confirmation, else null. */
  @Column({
    type: "varchar",
    length: 320,
    name: "forwarded_by",
    nullable: true,
  })
  forwardedBy: string | null;

  /** When the shop sent the order, read from the forwarded header block; null when unknown. */
  @Column({ type: "timestamptz", name: "original_sent_at", nullable: true })
  originalSentAt: Date | null;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: EmailReceiptStatus;

  @Column({
    type: "varchar",
    length: 40,
    name: "status_reason",
    nullable: true,
  })
  statusReason: string | null;

  @Column({ type: "uuid", name: "parser_id", nullable: true })
  parserId: string | null;

  @ManyToOne(() => EmailReceiptParser, {
    onDelete: "SET NULL",
    nullable: true,
  })
  @JoinColumn({ name: "parser_id" })
  parser?: EmailReceiptParser | null;

  /** The parser's `ParsedReceipt` (design 5.3), or null before a parse. */
  @Column({ type: "jsonb", nullable: true })
  parsed: Record<string, unknown> | null;

  /**
   * A trade profile's reading (`ParsedTrade`, design "Trade confirmations"), or
   * null for every email read as a receipt.
   */
  @Column({ type: "jsonb", nullable: true })
  trade: Record<string, unknown> | null;

  /**
   * The investment transaction a trade email accounts for: the row its approved
   * proposal created, the row a person linked it to, or the row already in the
   * ledger when it arrived (`trade_exists`). A matching row no email accounts for
   * is what makes a second email a duplicate; null for every other email.
   */
  @Column({ type: "uuid", name: "investment_transaction_id", nullable: true })
  investmentTransactionId: string | null;

  @Column({ type: "uuid", name: "transaction_id", nullable: true })
  transactionId: string | null;

  @ManyToOne(() => Transaction, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction | null;

  @Column({
    type: "uuid",
    array: true,
    name: "candidate_transaction_ids",
    default: () => "'{}'::uuid[]",
  })
  candidateTransactionIds: string[];

  @Column({
    type: "varchar",
    length: 20,
    name: "match_kind",
    nullable: true,
  })
  matchKind: EmailReceiptMatchKind | null;

  @Column({ type: "uuid", name: "ai_review_request_id", nullable: true })
  aiReviewRequestId: string | null;

  /** A `component` receipt's link value (linked receipts spec section 5); null for every other receipt. */
  @Column({ type: "varchar", length: 100, name: "link_key", nullable: true })
  linkKey: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
