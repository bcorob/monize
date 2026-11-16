import { Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { EmailReceipt } from "../entities/email-receipt.entity";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";
import { orderFromStructuredData } from "../parsing/schema-org-order";
import { EmailReceiptTradeLinkService } from "./email-receipt-trade-link.service";
import {
  EmailReceiptPipelineService,
  RECEIPT_ENRICHED_BY_OTHER_REASON,
} from "../pipeline/email-receipt-pipeline.service";
import { ReceiptSourceLines } from "../pipeline/receipt-source-lines";
import {
  deleteLockedReceipt,
  ignoreLockedReceipt,
  lockReceipt,
  receiptApplied,
  receiptAppliedConflict,
  receiptNotFound,
  receiptSkippedConflict,
} from "./receipt-disposal";
import {
  EMAIL_RECEIPT_PROCESSABLE_STATUSES,
  EMAIL_RECEIPTS_BULK_REPROCESS_DEFAULT_LIMIT,
  EMAIL_RECEIPTS_BULK_REPROCESS_MAX_LIMIT,
  EMAIL_RECEIPTS_DEFAULT_BATCH_LIMIT,
  EMAIL_RECEIPTS_DEFAULT_LIST_LIMIT,
  EMAIL_RECEIPTS_MAX_BATCH_LIMIT,
  EMAIL_RECEIPTS_MAX_LIST_LIMIT,
  EMAIL_RECEIPTS_MAX_LIST_OFFSET,
} from "./dto/email-receipts.dto";
import { describeFailure } from "../pipeline/receipt-failure";
import { RECEIPT_TRADE_CHAT_INSTRUCTIONS } from "../pipeline/receipt-instructions";
import { TRADE_ROW_AMOUNT_SQL } from "../../ai-review/trade-ledger";
import { readTradeProposal } from "./email-receipt-trade-proposal";
import { bulkActOnReceipts, refuseTooManyIds } from "./receipt-bulk";
import {
  approvableRequests,
  countSelected,
  reprocessCandidates,
  reprocessRemaining,
  reprocessSince,
} from "./receipt-bulk-queries";
import type { ReceiptBulkResult, ReceiptBulkTarget } from "./receipt-bulk";
import type { ReceiptSelectionFilter } from "./receipt-filter";
import { appliedComponentRereadClause } from "../linking/component-reread";
import {
  readEnrichedBy,
  readLinkedComponents,
  readLinkedSettlements,
} from "./receipt-links-view";
import {
  receiptDomainClause,
  receiptDomainParams,
  receiptSearchClause,
  receiptSearchParams,
  type ReceiptSearchFilter,
} from "./receipt-filter";
import type { EmailReceiptBulkAction } from "./dto/email-receipts.dto";
import type {
  EmailReceiptCandidateSummary,
  EmailReceiptDetail,
  EmailReceiptDisplayState,
  EmailReceiptDomainCount,
  EmailReceiptListItem,
  EmailReceiptsOverview,
  EmailReceiptStatusCounts,
} from "./email-receipt.view";

/** At most this many sender domains are listed for the filter. */
export const EMAIL_RECEIPTS_MAX_DOMAINS = 200;
/** The overview names at most this many sender domains no profile covers. */
export const EMAIL_RECEIPTS_OVERVIEW_DOMAINS = 10;
/**
 * AI category questions one bulk call may ask (each is a provider call, so a
 * batch of 200 emails does not become 200 calls): past it, the receipts that
 * need one are queued for an agent instead (design 5.6).
 */
export const EMAIL_RECEIPTS_BATCH_AI_CATEGORY_CALLS = 25;

/** A sender domain no approved profile covers (the profile wizard's cloud). */
export interface UncoveredDomain {
  domain: string;
  count: number;
  /** The newest draft profile naming the domain, or null. */
  draftParserId: string | null;
  /**
   * The open request (`pending` or claimed by an agent, unexpired) that asks for
   * a profile for this domain, or null: the wizard waits on it. A request an
   * agent has answered is no longer waiting; its draft is `draftParserId`.
   */
  pendingRequestId: string | null;
  pendingRequestStatus: "pending" | "claimed" | null;
}

/** What "process in bulk" did (design 8): the emails it ran, where they ended and what is left. */
export interface ProcessBatchResult {
  /** Emails the pipeline acted on in this call. */
  processed: number;
  /** Where the processed emails ended, by their new status. */
  byOutcome: Partial<Record<EmailReceiptStatus, number>>;
  /** Processed emails that are gone: their profile deletes every email it matches. */
  deleted: number;
  /** Emails that raised an error and were passed over (they are not retried by this run). */
  failed: number;
  /** Matching emails this run has not touched yet; 0 ends the run. */
  remaining: number;
  /** Send this back as `since` in the next call of the same run. */
  since: string;
}

/** The request a receipt points at, as far as the derived state needs it. */
export interface ReceiptRequestFacts {
  status: string;
  /** The request's life has run out, whatever its stored status still says. */
  expired: boolean;
}

/**
 * The shown state of a `review` receipt, derived from its request (design
 * section 6). Null for every other status: only a receipt that stands behind a
 * request has a request's state to show.
 */
export function deriveDisplayState(
  status: EmailReceiptStatus,
  request: ReceiptRequestFacts | null,
): EmailReceiptDisplayState | null {
  if (status !== "review") return null;
  if (request === null) return "request_missing";
  switch (request.status) {
    case "applied":
      return "applied";
    case "rejected":
      return "dismissed";
    case "expired":
      return "expired";
    case "proposed":
      return request.expired ? "expired" : "proposed";
    default:
      // pending, claimed
      return request.expired ? "expired" : "pending_ai";
  }
}

interface ItemRow {
  id: string;
  from_address: string;
  from_domain: string;
  subject: string;
  received_at: Date | string;
  forwarded_by: string | null;
  original_sent_at: Date | string | null;
  created_at: Date | string;
  status: EmailReceiptStatus;
  status_reason: string | null;
  match_kind: EmailReceiptListItem["matchKind"];
  parser_id: string | null;
  parser_name: string | null;
  link_key?: string | null;
  ai_review_request_id: string | null;
  is_trade?: boolean;
  trade_source?: "profile" | "ai" | null;
  request_status: string | null;
  request_expired: boolean | null;
  request_note: string | null;
  transaction_id: string | null;
  tx_date: string | null;
  tx_amount: string | number | null;
  tx_currency: string | null;
  tx_payee: string | null;
  inv_id?: string | null;
  inv_date?: string | null;
  inv_action?: string | null;
  inv_symbol?: string | null;
  inv_quantity?: string | number | null;
  inv_total?: string | number | null;
  inv_currency?: string | null;
}

interface DetailRow extends ItemRow {
  body_text: string;
  body_html: string | null;
  parsed: Record<string, unknown> | null;
  trade: Record<string, unknown> | null;
  trade_proposal: unknown;
  trade_request_source: "profile" | "ai" | null;
  candidate_transaction_ids: string[];
}

const ITEM_COLUMNS = `r.id, r.from_address, r.from_domain, r.subject, r.received_at,
       r.forwarded_by, r.original_sent_at, r.created_at, r.status, r.status_reason, r.match_kind, r.parser_id,
       p.name AS parser_name, r.link_key, r.ai_review_request_id,
       -- A trade is read by a trade profile (its reading in r.trade) or, with
       -- none, by the AI the email's email_trade request hands it to.
       (r.trade IS NOT NULL OR rq.kind = 'email_trade') AS is_trade,
       CASE WHEN r.trade IS NOT NULL THEN 'profile'
            WHEN rq.kind = 'email_trade' THEN 'ai' END AS trade_source,
       rq.status AS request_status,
       (rq.expires_at <= CURRENT_TIMESTAMP) AS request_expired,
       rq.proposal #>> '{agentNote,reason}' AS request_note,
       r.transaction_id,
       TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
       t.amount AS tx_amount, t.currency_code AS tx_currency,
       t.payee_name AS tx_payee,
       it.id AS inv_id,
       TO_CHAR(it.transaction_date, 'YYYY-MM-DD') AS inv_date,
       it.action AS inv_action, its.symbol AS inv_symbol,
       it.quantity AS inv_quantity, ${TRADE_ROW_AMOUNT_SQL} AS inv_total,
       its.currency_code AS inv_currency`;

const ITEM_JOINS = `FROM email_receipts r
       LEFT JOIN email_receipt_parsers p
              ON p.id = r.parser_id AND p.user_id = r.user_id
       LEFT JOIN ai_review_requests rq
              ON rq.id = r.ai_review_request_id AND rq.user_id = r.user_id
       LEFT JOIN transactions t
              ON t.id = r.transaction_id AND t.user_id = r.user_id
       LEFT JOIN investment_transactions it
              ON it.id = r.investment_transaction_id AND it.user_id = r.user_id
       LEFT JOIN securities its
              ON its.id = it.security_id`;

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

function toListItem(row: ItemRow): EmailReceiptListItem {
  return {
    id: row.id,
    fromAddress: row.from_address,
    fromDomain: row.from_domain,
    subject: row.subject,
    receivedAt: iso(row.received_at),
    forwardedBy: row.forwarded_by ?? null,
    originalSentAt: row.original_sent_at ? iso(row.original_sent_at) : null,
    effectiveDate: iso(row.original_sent_at ?? row.received_at),
    status: row.status,
    statusReason: row.status_reason,
    matchKind: row.match_kind,
    parserId: row.parser_id,
    parserName: row.parser_name,
    linkKey: row.link_key ?? null,
    aiReviewRequestId: row.ai_review_request_id,
    isTrade: row.is_trade === true,
    tradeSource: row.trade_source ?? null,
    displayState: deriveDisplayState(
      row.status,
      row.request_status === null
        ? null
        : {
            status: row.request_status,
            expired: row.request_expired === true,
          },
    ),
    requestNote: row.request_note,
    transaction:
      row.transaction_id !== null && row.tx_date !== null
        ? {
            id: row.transaction_id,
            date: row.tx_date,
            amount: Number(row.tx_amount),
            currencyCode: row.tx_currency as string,
            payeeName: row.tx_payee,
          }
        : null,
    investmentTransaction:
      row.inv_id && row.inv_date
        ? {
            id: row.inv_id,
            date: row.inv_date,
            action: row.inv_action ?? "",
            symbol: row.inv_symbol ?? "",
            quantity: Number(row.inv_quantity ?? 0),
            totalAmount: Number(row.inv_total ?? 0),
            currencyCode: row.inv_currency ?? "",
          }
        : null,
    createdAt: iso(row.created_at),
  };
}

/**
 * The receipts page's API over the stored emails (design sections 6 and 8): the
 * list, one email with its text, and the person's commands on it. Every method
 * is keyed on the JWT's user. A command that can refuse (an applied proposal, an
 * ignored or skipped email, a transaction that is not the user's) refuses inside
 * the transaction that would write, under the receipt's row lock, so a
 * rejection has written nothing.
 */
@Injectable()
export class EmailReceiptsService {
  private readonly logger = new Logger(EmailReceiptsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pipeline: EmailReceiptPipelineService,
    private readonly tradeLinks: EmailReceiptTradeLinkService,
  ) {}

  /**
   * The sender domains of the user's emails (the shop's, after forward
   * detection), each with its count: most emails first, then by name, at most
   * 200. What the receipts page's domain filter offers. With `status` the
   * domains and the counts are those of the emails in that state only, so the
   * filter never offers a domain the chosen state has no email from. The
   * search options (`search`, `searchIn`, `dateFrom`, `dateTo`) narrow the
   * counted emails the same way as in the list.
   */
  async listDomains(
    userId: string,
    options: { status?: EmailReceiptStatus } & ReceiptSearchFilter = {},
  ): Promise<EmailReceiptDomainCount[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{
        domain: string;
        count: string | number;
        processable: string | number;
      }>(
        await m.query(
          `SELECT r.from_domain AS domain,
                  COUNT(*)::int AS count,
                  (COUNT(*) FILTER (WHERE r.status = ANY($3::varchar[])))::int
                    AS processable
             FROM email_receipts r
            WHERE r.user_id = $1
              AND r.from_domain <> ''
              AND ($4::varchar IS NULL OR r.status = $4::varchar)
              AND ${receiptSearchClause(5)}
            GROUP BY r.from_domain
            ORDER BY count DESC, r.from_domain ASC
            LIMIT $2`,
          [
            userId,
            EMAIL_RECEIPTS_MAX_DOMAINS,
            [...EMAIL_RECEIPT_PROCESSABLE_STATUSES],
            options.status ?? null,
            ...receiptSearchParams(options),
          ],
        ),
      ),
    );
    return rows.map((row) => ({
      domain: row.domain,
      count: Number(row.count),
      processable: Number(row.processable),
    }));
  }

  /**
   * The sender domains of the user's stored emails that no APPROVED profile
   * covers (a profile covers its domains and their sub-domains, as the pipeline
   * reads them; a draft reads no mail), each with its count and the id of the
   * newest draft profile naming it, if any: what the profile wizard offers.
   * Most emails first, then by name, at most 200. One statement.
   */
  async listUncoveredDomains(userId: string): Promise<UncoveredDomain[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{
        domain: string;
        count: string | number;
        draft_parser_id: string | null;
        request_id: string | null;
        request_status: "pending" | "claimed" | null;
      }>(
        await m.query(
          `SELECT d.domain, d.count,
                  (SELECT p.id
                     FROM email_receipt_parsers p,
                          unnest(p.from_domains) AS pd(domain)
                    WHERE p.user_id = $1
                      AND p.status = 'draft'
                      AND (d.domain = pd.domain
                           OR right(d.domain, length(pd.domain) + 1)
                              = '.' || pd.domain)
                    ORDER BY p.updated_at DESC, p.id DESC
                    LIMIT 1) AS draft_parser_id,
                  req.id AS request_id, req.status AS request_status
             FROM (SELECT r.from_domain AS domain, COUNT(*)::int AS count
                     FROM email_receipts r
                    WHERE r.user_id = $1
                      AND r.from_domain <> ''
                      AND NOT EXISTS (
                            SELECT 1
                              FROM email_receipt_parsers p,
                                   unnest(p.from_domains) AS pd(domain)
                             WHERE p.user_id = r.user_id
                               AND p.status = 'approved'
                               AND (r.from_domain = pd.domain
                                    OR right(r.from_domain, length(pd.domain) + 1)
                                       = '.' || pd.domain))
                    GROUP BY r.from_domain) d
             LEFT JOIN LATERAL (
                    SELECT q.id, q.status
                      FROM ai_review_requests q
                     WHERE q.user_id = $1
                       AND q.kind = 'email_parser_draft'
                       AND q.parser_domain = d.domain
                       AND q.status IN ('pending', 'claimed')
                       AND q.expires_at > CURRENT_TIMESTAMP
                     ORDER BY q.created_at DESC, q.id DESC
                     LIMIT 1) req ON true
            ORDER BY d.count DESC, d.domain ASC
            LIMIT $2`,
          [userId, EMAIL_RECEIPTS_MAX_DOMAINS],
        ),
      ),
    );
    return rows.map((row) => ({
      domain: row.domain,
      count: Number(row.count),
      draftParserId: row.draft_parser_id,
      pendingRequestId: row.request_id,
      pendingRequestStatus: row.request_status,
    }));
  }

  /**
   * How many of the user's emails are in each state, optionally only those from
   * one sender domain (or a sub-domain of it, as the list's filter reads it):
   * what the status tabs show next to their names. A state with no email is
   * absent from `byStatus`; `total` is their sum. The search options
   * (`search`, `searchIn`, `dateFrom`, `dateTo`) narrow the counted emails the
   * same way as in the list.
   */
  async statusCounts(
    userId: string,
    options: { domain?: string } & ReceiptSearchFilter = {},
  ): Promise<EmailReceiptStatusCounts> {
    const { domain, domainLike } = receiptDomainParams(options.domain);
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ status: EmailReceiptStatus; count: string | number }>(
        await m.query(
          `SELECT r.status, COUNT(*)::int AS count
             FROM email_receipts r
            WHERE r.user_id = $1
              AND ${receiptDomainClause(2, 3)}
              AND ${receiptSearchClause(4)}
            GROUP BY r.status`,
          [userId, domain, domainLike, ...receiptSearchParams(options)],
        ),
      ),
    );
    const byStatus: EmailReceiptStatusCounts["byStatus"] = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count);
      byStatus[row.status] = count;
      total += count;
    }
    return { total, byStatus };
  }

  /**
   * Everything the hub's Overview shows, in ONE statement (design 9): the mailbox,
   * the emails by status, the profiles by status, the proposals waiting for
   * approval and the sender domains no profile covers. Counts and names only.
   */
  async overview(userId: string): Promise<EmailReceiptsOverview> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{
        mailbox: {
          enabled: boolean;
          auth_method: "password" | "oauth2";
          ai_mode: "off" | "on_demand" | "automatic";
          connected: boolean;
          last_polled_at: string | null;
          last_success_at: string | null;
          last_error: string | null;
          last_error_at: string | null;
        } | null;
        by_status: Record<string, number> | null;
        to_approve: number;
        parsers: { approved: number; draft: number };
        uncovered: Array<{ domain: string; count: number }> | null;
      }>(
        await m.query(
          `SELECT
             (SELECT json_build_object(
                       'enabled', mb.enabled,
                       'auth_method', mb.auth_method,
                       'ai_mode', mb.ai_mode,
                       'connected', (mb.auth_method = 'password'
                                     OR mb.oauth_refresh_token_enc IS NOT NULL),
                       'last_polled_at', mb.last_polled_at,
                       'last_success_at', mb.last_success_at,
                       'last_error', mb.last_error,
                       'last_error_at', mb.last_error_at)
                FROM email_receipt_mailboxes mb
               WHERE mb.user_id = $1) AS mailbox,
             (SELECT json_object_agg(s.status, s.n)
                FROM (SELECT status, COUNT(*)::int AS n
                        FROM email_receipts
                       WHERE user_id = $1
                       GROUP BY status) s) AS by_status,
             (SELECT COUNT(*)::int
                FROM ai_review_requests rq
               WHERE rq.user_id = $1
                 AND rq.kind IN ('email_receipt', 'email_trade')
                 AND rq.status = 'proposed'
                 AND rq.expires_at > CURRENT_TIMESTAMP) AS to_approve,
             (SELECT json_build_object(
                       'approved', COUNT(*) FILTER (WHERE p.status = 'approved')::int,
                       'draft', COUNT(*) FILTER (WHERE p.status = 'draft')::int)
                FROM email_receipt_parsers p
               WHERE p.user_id = $1) AS parsers,
             (SELECT json_agg(json_build_object('domain', d.from_domain, 'count', d.n)
                              ORDER BY d.n DESC, d.from_domain ASC)
                FROM (SELECT r.from_domain, COUNT(*)::int AS n
                        FROM email_receipts r
                       WHERE r.user_id = $1
                         AND r.status = 'no_parser'
                         AND r.from_domain <> ''
                         AND NOT EXISTS (
                               SELECT 1
                                 FROM email_receipt_parsers p,
                                      unnest(p.from_domains) AS pd(domain)
                                WHERE p.user_id = r.user_id
                                  AND (r.from_domain = pd.domain
                                       OR right(r.from_domain, length(pd.domain) + 1)
                                          = '.' || pd.domain))
                       GROUP BY r.from_domain
                       ORDER BY n DESC, r.from_domain ASC
                       LIMIT $2) d) AS uncovered`,
          [userId, EMAIL_RECEIPTS_OVERVIEW_DOMAINS],
        ),
      ),
    );
    const row = rows[0];
    const byStatus = (row?.by_status ?? {}) as Record<string, number>;
    const emailsByStatus: EmailReceiptsOverview["emailsByStatus"] = {};
    for (const [status, count] of Object.entries(byStatus)) {
      emailsByStatus[status as EmailReceiptStatus] = Number(count);
    }
    const mailbox = row?.mailbox ?? null;
    return {
      mailbox: mailbox
        ? {
            enabled: mailbox.enabled,
            authMethod: mailbox.auth_method,
            aiMode: mailbox.ai_mode,
            connected: mailbox.connected,
            lastPolledAt: mailbox.last_polled_at
              ? iso(mailbox.last_polled_at)
              : null,
            lastSuccessAt: mailbox.last_success_at
              ? iso(mailbox.last_success_at)
              : null,
            lastError: mailbox.last_error,
            lastErrorAt: mailbox.last_error_at
              ? iso(mailbox.last_error_at)
              : null,
          }
        : null,
      emailsByStatus,
      processable: EMAIL_RECEIPT_PROCESSABLE_STATUSES.reduce(
        (sum, status) => sum + (emailsByStatus[status] ?? 0),
        0,
      ),
      proposalsToApprove: Number(row?.to_approve ?? 0),
      parsers: {
        approved: Number(row?.parsers?.approved ?? 0),
        draft: Number(row?.parsers?.draft ?? 0),
      },
      domainsWithoutProfile: (row?.uncovered ?? []).map((entry) => ({
        domain: entry.domain,
        count: Number(entry.count),
      })),
    };
  }

  /**
   * "Process in bulk" (design 8): run the pipeline over up to `limit` emails in
   * the given statuses (every processable one by default), oldest first, one after
   * the other, each in its own transaction exactly as `process` always runs (a
   * failure of one email never rolls back another). Returns where they ended and
   * how many matching emails this run has not touched yet.
   *
   * What makes a loop of calls end: an email that stays in a selected status after
   * processing (still unmatched, say) would match the filter forever, so the run
   * takes only emails not UPDATED since the run began. `since` is that instant (the
   * database's clock, the first call's start; later calls send it back), and every
   * email the pipeline processes is written, so it leaves the candidates; one that
   * raised an error is touched on purpose, so it cannot starve the rest.
   */
  async processBatch(
    userId: string,
    options: {
      domain?: string;
      statuses?: readonly EmailReceiptStatus[];
      limit?: number;
      since?: string;
    } = {},
  ): Promise<ProcessBatchResult> {
    const explicitStatuses = Boolean(
      options.statuses && options.statuses.length > 0,
    );
    const statuses = [
      ...(options.statuses && options.statuses.length > 0
        ? options.statuses
        : EMAIL_RECEIPT_PROCESSABLE_STATUSES),
    ] as EmailReceiptStatus[];
    // With no statuses named, an applied email that a component profile covers
    // is read again too (linked receipts spec 9); no other `review` one is.
    const statusClause = explicitStatuses
      ? "r.status = ANY($2::varchar[])"
      : `(r.status = ANY($2::varchar[]) OR ${appliedComponentRereadClause("r")})`;
    const limit = Math.min(
      Math.max(
        Math.trunc(options.limit ?? EMAIL_RECEIPTS_DEFAULT_BATCH_LIMIT),
        1,
      ),
      EMAIL_RECEIPTS_MAX_BATCH_LIMIT,
    );
    const { domain, domainLike } = receiptDomainParams(options.domain);

    const selected = await withScopedDb(this.dataSource, async (m) => {
      const [stamp] = returnedRows<{ since: string }>(
        await m.query(
          `SELECT TO_CHAR(
                    LEAST(COALESCE($1::timestamptz, CURRENT_TIMESTAMP),
                          CURRENT_TIMESTAMP) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since`,
          [options.since ?? null],
        ),
      );
      const ids = returnedRows<{ id: string; reread: boolean }>(
        await m.query(
          `SELECT r.id, (r.status = 'review') AS reread
             FROM email_receipts r
            WHERE r.user_id = $1
              AND ${statusClause}
              AND ${receiptDomainClause(3, 4)}
              AND r.updated_at < $5::timestamptz
            ORDER BY r.received_at ASC, r.id ASC
            LIMIT $6`,
          [userId, statuses, domain, domainLike, stamp.since, limit],
        ),
      );
      return { since: stamp.since, rows: ids };
    });

    const byOutcome: ProcessBatchResult["byOutcome"] = {};
    let processed = 0;
    let deleted = 0;
    let failed = 0;
    const budget = { remaining: EMAIL_RECEIPTS_BATCH_AI_CATEGORY_CALLS };
    for (const { id, reread } of selected.rows) {
      try {
        const result = await this.pipeline.process(userId, id, {
          // `review` is allowed for the applied emails only (spec 9).
          onlyWhenStatusIn: reread ? [...statuses, "review"] : statuses,
          aiCategoryBudget: budget,
        });
        if (result.deleted) {
          processed++;
          deleted++;
        } else if (!result.unchanged) {
          processed++;
          byOutcome[result.status] = (byOutcome[result.status] ?? 0) + 1;
        } else if (reread) {
          // An applied email its profile does not read as a component stays as
          // it is; passed over, so the run does not select it again.
          await this.touch(userId, id);
        }
      } catch (error) {
        failed++;
        this.logger.warn(
          `Bulk processing could not process email ${id} (${describeFailure(error)})`,
        );
        await this.touch(userId, id);
      }
    }

    const [left] = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ remaining: number | string }>(
        await m.query(
          `SELECT COUNT(*)::int AS remaining
             FROM email_receipts r
            WHERE r.user_id = $1
              AND ${statusClause}
              AND ${receiptDomainClause(3, 4)}
              AND r.updated_at < $5::timestamptz`,
          [userId, statuses, domain, domainLike, selected.since],
        ),
      ),
    );
    return {
      processed,
      byOutcome,
      deleted,
      failed,
      remaining: Number(left?.remaining ?? 0),
      since: selected.since,
    };
  }

  /** Move an email's `updated_at` so a bulk run does not take it again; best effort. */
  private async touch(userId: string, id: string): Promise<void> {
    try {
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `UPDATE email_receipts SET status_reason = status_reason
            WHERE id = $1 AND user_id = $2`,
          [id, userId],
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Could not mark email ${id} as passed over (${describeFailure(error)})`,
      );
    }
  }

  /**
   * The user's emails, newest first by the day the shop sent the order
   * (`original_sent_at`, else `received_at`: the list's `effectiveDate`), without their text. `domain` keeps the
   * emails from exactly that sender domain or one of its sub-domains; it
   * combines with `status`. `search` keeps the emails whose subject, sender or
   * body text holds the text (`searchIn` picks which), and `dateFrom` / `dateTo`
   * the emails whose effective date falls on those UTC days, inclusive.
   */
  async list(
    userId: string,
    options: {
      status?: EmailReceiptStatus;
      domain?: string;
      limit?: number;
      offset?: number;
    } & ReceiptSearchFilter = {},
  ): Promise<EmailReceiptListItem[]> {
    const limit = Math.min(
      Math.max(
        Math.trunc(options.limit ?? EMAIL_RECEIPTS_DEFAULT_LIST_LIMIT),
        1,
      ),
      EMAIL_RECEIPTS_MAX_LIST_LIMIT,
    );
    const offset = Math.min(
      Math.max(Math.trunc(options.offset ?? 0), 0),
      EMAIL_RECEIPTS_MAX_LIST_OFFSET,
    );
    const { domain, domainLike } = receiptDomainParams(options.domain);
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<ItemRow>(
        await m.query(
          `SELECT ${ITEM_COLUMNS}
             ${ITEM_JOINS}
            WHERE r.user_id = $1
              AND ($2::varchar IS NULL OR r.status = $2::varchar)
              AND ${receiptDomainClause(3, 4)}
              AND ${receiptSearchClause(7)}
            ORDER BY COALESCE(r.original_sent_at, r.received_at) DESC, r.id DESC
            LIMIT $5 OFFSET $6`,
          [
            userId,
            options.status ?? null,
            domain,
            domainLike,
            limit,
            offset,
            ...receiptSearchParams(options),
          ],
        ),
      ),
    );
    return rows.map(toListItem);
  }

  /** One of the user's emails with its text, parse result and candidates. */
  async get(userId: string, id: string): Promise<EmailReceiptDetail> {
    const detail = await withScopedDb(this.dataSource, (m) =>
      this.readDetail(m, userId, id),
    );
    if (!detail) throw receiptNotFound(id);
    return detail;
  }

  /**
   * Back to the top of the pipeline (design section 6); a closed request is not
   * reopened. Null when the email is gone: its profile deletes every email it
   * matches.
   */
  async reprocess(
    userId: string,
    id: string,
  ): Promise<EmailReceiptDetail | null> {
    const result = await this.pipeline.process(userId, id);
    return result.deleted ? null : this.get(userId, id);
  }

  /**
   * A person names the transaction the email paid for (match kind `manual`) and
   * the pipeline proposes from it. Ownership, transfer and VOID are checked by
   * the pipeline inside the transaction that stores the link.
   */
  async link(
    userId: string,
    id: string,
    transactionId: string,
  ): Promise<EmailReceiptDetail> {
    // A trade email is linked to the investment transaction it reports.
    const isTrade = await withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{ is_trade: boolean }>(
        await m.query(
          `SELECT (trade IS NOT NULL) AS is_trade
             FROM email_receipts
            WHERE id = $1 AND user_id = $2`,
          [id, userId],
        ),
      );
      return rows[0]?.is_trade === true;
    });
    if (isTrade) {
      await this.tradeLinks.link(userId, id, transactionId);
    } else {
      await this.pipeline.process(userId, id, { link: { transactionId } });
    }
    return this.get(userId, id);
  }

  /** Stop the email proposing anything: its open request is dismissed with it. */
  async ignore(userId: string, id: string): Promise<EmailReceiptDetail> {
    await withScopedDb(this.dataSource, async (m) => {
      const receipt = await this.lockReceipt(m, userId, id);
      if (receipt.status === "ignored") return;
      if (receipt.status === "skipped") throw receiptSkippedConflict();
      if (await receiptApplied(m, userId, receipt)) {
        throw receiptAppliedConflict();
      }
      await ignoreLockedReceipt(m, userId, receipt);
    });
    return this.get(userId, id);
  }

  /** Delete the stored email; its open request is dismissed in the same transaction. */
  async remove(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const receipt = await this.lockReceipt(m, userId, id);
      await deleteLockedReceipt(m, userId, receipt);
    });
  }

  /**
   * Delete or ignore many emails at once, by id or by the list's filter, in ONE
   * transaction that refuses before it writes (`bulkActOnReceipts`): a count that
   * differs from `expectedCount` is a 409 and nothing was changed. Emails linked
   * to a transaction are never touched.
   */
  async bulk(
    userId: string,
    action: EmailReceiptBulkAction,
    target: ReceiptBulkTarget,
    expectedCount: number,
  ): Promise<ReceiptBulkResult> {
    return withScopedDb(this.dataSource, (m) =>
      bulkActOnReceipts(m, userId, action, target, expectedCount),
    );
  }

  /**
   * How many emails a filter selects, through the predicate the bulk commands
   * lock their rows with. Capped at `EMAIL_RECEIPTS_BULK_MAX_MATCHES + 1`.
   */
  async countSelection(
    userId: string,
    filter: ReceiptSelectionFilter,
  ): Promise<{ count: number }> {
    const count = await withScopedDb(this.dataSource, (m) =>
      countSelected(m, userId, filter),
    );
    return { count };
  }

  /**
   * One chunk of "reprocess the selection": at most `limit` eligible emails
   * (not `skipped`, not `pending`, no applied request; in `onlyStatuses` when
   * given), oldest first, each once per run (`updated_at < since`, as
   * `processBatch`). With `onlyStatuses` the pipeline leaves an email whose state
   * changed since it was read alone (`onlyWhenStatusIn`); without it the command
   * is the row action's. The client calls again until `remaining` is 0.
   */
  async reprocessSelection(
    userId: string,
    target: ReceiptBulkTarget,
    options: {
      onlyStatuses?: readonly EmailReceiptStatus[];
      since?: string;
      limit?: number;
    } = {},
  ): Promise<ProcessBatchResult> {
    refuseTooManyIds(target);
    const onlyStatuses = options.onlyStatuses ?? [];
    const limit = Math.min(
      Math.max(
        Math.trunc(
          options.limit ?? EMAIL_RECEIPTS_BULK_REPROCESS_DEFAULT_LIMIT,
        ),
        1,
      ),
      EMAIL_RECEIPTS_BULK_REPROCESS_MAX_LIMIT,
    );
    const selected = await withScopedDb(this.dataSource, async (m) => {
      const since = await reprocessSince(m, options.since);
      const ids = await reprocessCandidates(m, userId, target, {
        onlyStatuses,
        since,
        limit,
      });
      return { since, ids };
    });

    const byOutcome: ProcessBatchResult["byOutcome"] = {};
    let processed = 0;
    let deleted = 0;
    let failed = 0;
    const budget = { remaining: EMAIL_RECEIPTS_BATCH_AI_CATEGORY_CALLS };
    for (const id of selected.ids) {
      try {
        const result = await this.pipeline.process(userId, id, {
          ...(onlyStatuses.length > 0
            ? { onlyWhenStatusIn: onlyStatuses }
            : {}),
          aiCategoryBudget: budget,
        });
        if (result.deleted) {
          processed++;
          deleted++;
        } else if (result.unchanged) {
          // Left alone, so not written: touch it or the run would take it again.
          await this.touch(userId, id);
        } else {
          processed++;
          byOutcome[result.status] = (byOutcome[result.status] ?? 0) + 1;
        }
      } catch (error) {
        failed++;
        this.logger.warn(
          `Bulk reprocessing could not process email ${id} (${describeFailure(error)})`,
        );
        await this.touch(userId, id);
      }
    }

    const remaining = await withScopedDb(this.dataSource, (m) =>
      reprocessRemaining(m, userId, target, {
        onlyStatuses,
        since: selected.since,
      }),
    );
    return {
      processed,
      byOutcome,
      deleted,
      failed,
      remaining,
      since: selected.since,
    };
  }

  /**
   * The proposals a bulk approval would send to `approve-batch`: the request ids
   * of the selected non-trade emails in `review` with a proposed request, and how
   * many trade emails were left out. Refuses before anything is read for the
   * client to act on when more than 2,000 match.
   */
  async approvableSelection(
    userId: string,
    target: ReceiptBulkTarget,
  ): Promise<{ requestIds: string[]; trades: number }> {
    refuseTooManyIds(target);
    return withScopedDb(this.dataSource, (m) =>
      approvableRequests(m, userId, target),
    );
  }

  // ---------------------------------------------------------------------

  private async lockReceipt(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<EmailReceipt> {
    const receipt = await lockReceipt(m, userId, id);
    if (!receipt) throw receiptNotFound(id);
    return receipt;
  }

  private async readDetail(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<EmailReceiptDetail | null> {
    const rows = returnedRows<DetailRow>(
      await m.query(
        `SELECT ${ITEM_COLUMNS},
                r.body_text, r.body_html, r.parsed, r.trade, r.candidate_transaction_ids,
                CASE WHEN rq.kind = 'email_trade'
                      AND rq.status = 'proposed'
                      AND rq.expires_at > CURRENT_TIMESTAMP
                     THEN rq.proposal END AS trade_proposal,
                -- Who reads the trade the request asks about: the profile's
                -- own request, or the one "Recognize as a trade" queued for
                -- the AI (told apart by its fixed instruction).
                CASE WHEN rq.kind = 'email_trade'
                     THEN CASE WHEN rq.instruction = ANY($3::text[]) THEN 'ai' ELSE 'profile' END
                END AS trade_request_source
           ${ITEM_JOINS}
          WHERE r.user_id = $1
            AND r.id = $2`,
        [userId, id, [...RECEIPT_TRADE_CHAT_INSTRUCTIONS]],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    const sources = new ReceiptSourceLines({
      bodyText: row.body_text,
      bodyHtml: row.body_html,
    });
    const structured = sources.structured();
    return {
      ...toListItem(row),
      bodyText: row.body_text,
      bodyHtml: row.body_html,
      lines: { text: sources.text(), html: sources.html() },
      structuredOrder:
        structured === null ? null : orderFromStructuredData(structured),
      parsed: row.parsed,
      trade: row.trade ?? null,
      tradeProposal: readTradeProposal(row.trade_proposal),
      tradeRequestSource: row.trade_request_source ?? null,
      candidates: row.trade
        ? await this.tradeLinks.candidates(
            m,
            userId,
            row.trade,
            iso(row.original_sent_at ?? row.received_at),
            row.id,
          )
        : await this.readCandidates(
            m,
            userId,
            row.candidate_transaction_ids ?? [],
          ),
      linkedComponents: await readLinkedComponents(m, userId, row.id),
      linkedSettlements:
        row.status === "component"
          ? await readLinkedSettlements(m, userId, row.id)
          : [],
      enrichedBy:
        row.status === "review_conflict" &&
        row.status_reason === RECEIPT_ENRICHED_BY_OTHER_REASON &&
        row.candidate_transaction_ids?.[0]
          ? await readEnrichedBy(m, userId, row.candidate_transaction_ids[0])
          : null,
    };
  }

  /** The candidates of an ambiguous email, in the stored order (closest date first). */
  private async readCandidates(
    m: EntityManager,
    userId: string,
    ids: readonly string[],
  ): Promise<EmailReceiptCandidateSummary[]> {
    if (ids.length === 0) return [];
    const rows = returnedRows<{
      id: string;
      date: string;
      amount: string | number;
      currency_code: string;
      payee_name: string | null;
      description: string | null;
    }>(
      await m.query(
        `SELECT t.id, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date,
                t.amount, t.currency_code, t.payee_name, t.description
           FROM transactions t
          WHERE t.user_id = $1
            AND t.id = ANY($2::uuid[])`,
        [userId, [...ids]],
      ),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [
            {
              id: row.id,
              date: row.date,
              amount: Number(row.amount),
              currencyCode: row.currency_code,
              payeeName: row.payee_name,
              description: row.description,
            },
          ]
        : [];
    });
  }
}
