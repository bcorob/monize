import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  emailDayOfUser,
  findTradeInLedger,
} from "../../ai-review/trade-ledger";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { roundMoney } from "../../common/round.util";
import { tr } from "../../i18n/translate";
import { Payee } from "../../payees/entities/payee.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { receiptMatchAmount } from "../matching/match-receipt";
import type { ReceiptOutcome } from "../parsing/parse-receipt";
import { tradeExecutedTotalUnits } from "../parsing/parse-trade";
import type {
  ParsedReceiptReason,
  ParsedTrade,
  ParsedTradeAction,
  ParsedTradeReason,
} from "../parsing/receipt-parser.types";
import { validateReceiptParserDefinition } from "../parsing/receipt-parser.validation";
import type { PreviewEmailReceiptParserDto } from "./dto/email-receipt-parser.dto";
import { invalidDefinitionError } from "./parser-references.util";
import {
  compareWithExpected,
  dryRunReceipt,
  loadTransactionSummaries,
  summarizeTransaction,
  type DryRunReceipt,
  type DryRunPayee,
  type TransactionSummary,
} from "./receipt-dry-run";
import type { ReceiptParserDefinition } from "../parsing/receipt-parser.types";

/** The preview lists at most this many of the domain's other emails, newest first. */
export const PARSER_PREVIEW_MAX_OTHERS = 100;
const MONEY_UNITS = 10_000;

/**
 * What the commit would do with one email: the guard that stops the pipeline
 * reading it (`not_applicable`, `skip_line`, `wait_line`, `no_html`), a read
 * that is not complete (`parse_failed`, with `statusReason`), or, for a
 * complete read, what the matcher found. A component email read with a link
 * value is `component` (and `parse_failed` with `no_link_key` without one). A trade profile's complete read is
 * `trade`: it creates an investment transaction, so there is nothing to match.
 */
export type ParserPreviewOutcome =
  | Exclude<ReceiptOutcome, "read">
  | "parse_failed"
  | "matched"
  | "ambiguous"
  | "unmatched"
  /** A component profile's email (linked receipts spec 2.1): stored, never matched to a transaction. */
  | "component"
  | "trade"
  /** A complete trade the ledger already holds: the pipeline ignores the email (`trade_exists`). */
  | "trade_exists";

export interface ParserPreviewItem {
  receiptId: string;
  subject: string;
  /** ISO timestamp the email arrived. */
  receivedAt: string;
  /** ISO timestamp to show: when the shop sent the email if a forward carried it (`original_sent_at`), else `receivedAt`. */
  effectiveDate: string;
  outcome: ParserPreviewOutcome;
  /** Why a read is incomplete (`ParsedReceiptReason`, `ParsedTradeReason` for a trade profile, or `no_link_key` for a component that read no link value); null otherwise. */
  statusReason: ParsedReceiptReason | ParsedTradeReason | "no_link_key" | null;
  /** What was read, in decimal units; null when a guard stopped the read. */
  parsed: {
    /** `YYYY-MM-DD`: the day the shop sent the order, or the day the email arrived. */
    date: string;
    /** The amount paid, else the total; null when the email states neither. */
    total: number | null;
    /** The currency of the expected or matched transaction, or the one a trade's reading decided; null when there is none. */
    currency: string | null;
    lineCount: number;
  } | null;
  /** For a trade profile: the trade it read (shares, ticker, direction); null for a receipt or when a guard stopped the read. */
  trade: {
    action: ParsedTradeAction | null;
    symbol: string | null;
    quantity: number | null;
    /** Shares times price agrees with the total; null when the email states no price. */
    consistent: boolean | null;
    /** The account the rules chose, so two accounts printed alike can be checked apart. */
    accountId: string | null;
    currency: string | null;
  } | null;
  match: { transactionId: string; summary: string } | null;
  expected: { transactionId: string; summary: string } | null;
  /** Date and total agree with `expected`; null when the email has none. */
  agrees: boolean | null;
}

export interface ParserPreviewResult {
  selected: ParserPreviewItem[];
  others: ParserPreviewItem[];
  /** All of the domain's other emails, of which `others` shows the newest. */
  othersTotal: number;
}

interface PreviewRow extends DryRunReceipt {
  inDomain: boolean;
}

interface RawRow {
  id: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  received_at: Date | string;
  original_sent_at: Date | string | null;
  in_domain: boolean;
}

/**
 * An email `r` is from one of the domains in `$2` (`text[]`), or one of their
 * sub-domains: the preview's emails, and the emails a profile's bulk actions
 * look at before asking which profile reads each one.
 */
export const DOMAIN_MATCH_SQL = `EXISTS (
        SELECT 1
          FROM unnest($2::text[]) AS pd(domain)
         WHERE r.from_domain = pd.domain
            OR right(r.from_domain, length(pd.domain) + 1) = '.' || pd.domain)`;

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

function toPreviewRow(row: RawRow): PreviewRow {
  return {
    id: row.id,
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    receivedAt: toDate(row.received_at),
    originalSentAt: row.original_sent_at ? toDate(row.original_sent_at) : null,
    inDomain: row.in_domain,
  };
}

/**
 * "Preview a profile over its domain" (the profile wizard, step 3): run a
 * parser's definition, draft or approved, over the stored emails of its sender
 * domains and say what the pipeline would do with each, without writing
 * anything. The read and the match are `dryRunReceipt`, the code behind the test
 * endpoint and the assistant's `test`, so the preview shows what the commit
 * will do. One read-only transaction.
 */
@Injectable()
export class EmailReceiptParserPreviewService {
  constructor(private readonly dataSource: DataSource) {}

  async preview(
    userId: string,
    parserId: string,
    dto: PreviewEmailReceiptParserDto,
  ): Promise<ParserPreviewResult> {
    const selectedIds = dto.selectedReceiptIds;
    const expectedPairs = dto.expected ?? [];
    for (const pair of expectedPairs) {
      if (!selectedIds.includes(pair.receiptId)) {
        throw new BadRequestException(
          tr(
            "errors.emailReceipts.previewExpectedNotSelected",
            "An expected transaction was named for an email that is not among the selected ones.",
          ),
        );
      }
    }
    return withScopedDb(this.dataSource, async (m) => {
      const parser = await m
        .getRepository(EmailReceiptParser)
        .findOne({ where: { id: parserId, userId } });
      if (!parser) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.parserNotFound",
            `Receipt parser ${parserId} not found`,
            { id: parserId },
          ),
        );
      }
      const validation = validateReceiptParserDefinition(parser.definition);
      if (!validation.ok) throw invalidDefinitionError(validation.errors);
      const definition = validation.definition;
      const payee: DryRunPayee | null = parser.payeeId
        ? await m.getRepository(Payee).findOne({
            where: { id: parser.payeeId, userId },
            select: { id: true, defaultCategoryId: true },
          })
        : null;

      const selectedRows = await this.readRows(m, userId, parser.fromDomains, {
        ids: selectedIds,
      });
      const byId = new Map(selectedRows.map((row) => [row.id, row]));
      for (const id of selectedIds) {
        const row = byId.get(id);
        if (!row) {
          throw new NotFoundException(
            tr(
              "errors.emailReceipts.receiptNotFound",
              `Email ${id} not found`,
              {
                id,
              },
            ),
          );
        }
        if (!row.inDomain) {
          throw new BadRequestException(
            tr(
              "errors.emailReceipts.previewReceiptOutsideDomain",
              "An email is not from a sender domain of this parser.",
            ),
          );
        }
      }
      const transactions = await loadTransactionSummaries(
        m,
        userId,
        expectedPairs.map((pair) => pair.transactionId),
      );
      const expectedByReceipt = new Map<string, TransactionSummary>();
      for (const pair of expectedPairs) {
        const tx = transactions.get(pair.transactionId);
        if (!tx) {
          throw new NotFoundException(
            tr(
              "errors.emailReceipts.transactionNotFound",
              "That transaction was not found.",
            ),
          );
        }
        expectedByReceipt.set(pair.receiptId, tx);
      }

      const otherRows = await this.readRows(m, userId, parser.fromDomains, {
        excludeIds: selectedIds,
        limit: PARSER_PREVIEW_MAX_OTHERS,
      });
      const [{ n }] = returnedRows<{ n: number | string }>(
        await m.query(
          `SELECT COUNT(*)::int AS n
             FROM email_receipts r
            WHERE r.user_id = $1
              AND r.status <> 'skipped'
              AND NOT (r.id = ANY($3::uuid[]))
              AND ${DOMAIN_MATCH_SQL}`,
          [userId, parser.fromDomains, selectedIds],
        ),
      );

      const item = (
        row: PreviewRow,
        expected: TransactionSummary | undefined,
      ) => this.previewOne(m, userId, definition, payee, row, expected);
      const selected: ParserPreviewItem[] = [];
      for (const id of selectedIds) {
        selected.push(
          await item(byId.get(id) as PreviewRow, expectedByReceipt.get(id)),
        );
      }
      const others: ParserPreviewItem[] = [];
      for (const row of otherRows) others.push(await item(row, undefined));
      return { selected, others, othersTotal: Number(n) };
    });
  }

  /**
   * The user's stored emails: those named by `ids` (any domain, flagged
   * `inDomain`), or the domain's emails except `excludeIds` and `skipped` ones
   * (nothing was read from those), newest first by the day the shop sent them.
   */
  private async readRows(
    m: EntityManager,
    userId: string,
    domains: readonly string[],
    options: {
      ids?: readonly string[];
      excludeIds?: readonly string[];
      limit?: number;
    },
  ): Promise<PreviewRow[]> {
    const byIds = options.ids !== undefined;
    const rows = returnedRows<RawRow>(
      await m.query(
        `SELECT r.id, r.subject, r.body_text, r.body_html, r.received_at,
                r.original_sent_at, (${DOMAIN_MATCH_SQL}) AS in_domain
           FROM email_receipts r
          WHERE r.user_id = $1
            AND ${
              byIds
                ? "r.id = ANY($3::uuid[])"
                : `r.status <> 'skipped'
            AND NOT (r.id = ANY($3::uuid[]))
            AND ${DOMAIN_MATCH_SQL}`
            }
          ORDER BY COALESCE(r.original_sent_at, r.received_at) DESC, r.id DESC
          LIMIT $4`,
        [
          userId,
          [...domains],
          byIds ? [...(options.ids ?? [])] : [...(options.excludeIds ?? [])],
          options.limit ?? 1000,
        ],
      ),
    );
    return rows.map(toPreviewRow);
  }

  /** Whether the pipeline would find this complete trade already in the ledger (and ignore the email). */
  private async tradeAlreadyBooked(
    m: EntityManager,
    userId: string,
    trade: ParsedTrade,
    row: PreviewRow,
  ): Promise<boolean> {
    const date =
      trade.date ??
      (await emailDayOfUser(m, userId, row.originalSentAt ?? row.receivedAt));
    const ledger = await findTradeInLedger(
      m,
      userId,
      {
        accountId: trade.accountId as string,
        action: trade.action as ParsedTradeAction,
        symbol: trade.symbol as string,
        quantity: trade.quantity,
        totalAmount: roundMoney(
          (tradeExecutedTotalUnits(trade) as number) / MONEY_UNITS,
        ),
        date,
      },
      row.id,
    );
    return ledger.unclaimedId !== null;
  }

  private async previewOne(
    m: EntityManager,
    userId: string,
    definition: ReceiptParserDefinition,
    payee: DryRunPayee | null,
    row: PreviewRow,
    expected: TransactionSummary | undefined,
  ): Promise<ParserPreviewItem> {
    const run = await dryRunReceipt(m, userId, definition, row, payee);
    const { parsed, outcome } = run;
    const read = outcome === "read";
    const tradeRead = read ? (run.trade?.parsed ?? null) : null;
    // A trade the email does not date is dated the day it was sent in the
    // user's timezone, as the pipeline dates it.
    const tradeDay =
      tradeRead === null
        ? null
        : (tradeRead.date ??
          (await emailDayOfUser(
            m,
            userId,
            row.originalSentAt ?? row.receivedAt,
          )));
    const paid = receiptMatchAmount(parsed);
    let itemOutcome: ParserPreviewOutcome;
    if (!read) itemOutcome = outcome;
    else if (run.trade) {
      itemOutcome = !run.trade.parsed.complete
        ? "parse_failed"
        : (await this.tradeAlreadyBooked(m, userId, run.trade.parsed, row))
          ? "trade_exists"
          : "trade";
    } else if (run.component) {
      itemOutcome =
        run.component.linkKey === null ? "parse_failed" : "component";
    } else if (!parsed.complete) itemOutcome = "parse_failed";
    else itemOutcome = run.match.kind;
    return {
      receiptId: row.id,
      subject: row.subject,
      receivedAt: row.receivedAt.toISOString(),
      effectiveDate: (row.originalSentAt ?? row.receivedAt).toISOString(),
      outcome: itemOutcome,
      statusReason: !read
        ? null
        : run.trade
          ? run.trade.parsed.reason
          : run.component
            ? run.component.linkKey === null
              ? "no_link_key"
              : null
            : !parsed.complete
              ? parsed.reason
              : null,
      parsed: read
        ? {
            date: tradeDay ?? run.purchaseDate,
            total:
              tradeRead !== null
                ? (() => {
                    const units = tradeExecutedTotalUnits(tradeRead);
                    return units === null
                      ? null
                      : roundMoney(units / MONEY_UNITS);
                  })()
                : paid === null
                  ? null
                  : roundMoney(paid / MONEY_UNITS),
            currency: tradeRead?.currency ?? expected?.currencyCode ?? null,
            lineCount: parsed.items.length,
          }
        : null,
      trade: tradeRead
        ? {
            action: tradeRead.action,
            symbol: tradeRead.symbol,
            quantity: tradeRead.quantity,
            consistent: tradeRead.consistent,
            accountId: tradeRead.accountId,
            currency: tradeRead.currency ?? null,
          }
        : null,
      match: run.hit
        ? {
            transactionId: run.hit.id,
            summary: summarizeTransaction({
              date: run.hit.transactionDate,
              amount: run.hit.amount,
              payeeName: run.hit.payeeName,
            }),
          }
        : null,
      expected: expected
        ? {
            transactionId: expected.id,
            summary: summarizeTransaction(expected),
          }
        : null,
      agrees: expected
        ? compareWithExpected(
            parsed,
            run.purchaseDate,
            run.matchConfig,
            expected,
          ).agrees
        : null,
    };
  }
}
