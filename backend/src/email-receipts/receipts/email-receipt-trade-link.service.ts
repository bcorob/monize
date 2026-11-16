import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  tradeActionOf,
  tradeInvestmentAction,
} from "../../ai-review/trade-action";
import {
  emailDayOfUser,
  TRADE_ROW_AMOUNT_SQL,
} from "../../ai-review/trade-ledger";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import { escapeLikePattern } from "../../transactions/transaction-search.util";
import { EmailReceipt } from "../entities/email-receipt.entity";
import { RECEIPT_TRADE_EXISTS_REASON } from "../pipeline/email-receipt-trade.service";
import {
  closeReceiptRequests,
  currentReceiptRequestStatus,
} from "../pipeline/receipt-requests.util";
import type { EmailReceiptCandidateSummary } from "./email-receipt.view";

/** The status_reason of a trade email a person linked to the transaction it reports. */
export const RECEIPT_TRADE_LINKED_REASON = "trade_linked";
/** How far from the trade's day an existing transaction is offered as the one it reports. */
const CANDIDATE_WINDOW_DAYS = 7;
const MAX_CANDIDATES = 10;

interface InvestmentRow {
  id: string;
  account_id: string;
  security_id: string | null;
  action: string;
  date: string;
  commission: string | number | null;
}

/**
 * Linking a trade-confirmation email to the transaction it reports. A trade
 * email creates an investment transaction; when the person already entered it
 * (or imported it), linking says "this email is that transaction": the email is
 * closed as covered, nothing is created, and a scheduled bill or deposit that
 * trade pays is marked paid if it is not already, all in one transaction.
 *
 * The candidates are the user's own investment transactions of the trade's
 * account, direction and ticker near its day, shown on the receipts page in the
 * place a bank transaction's candidates are.
 */
@Injectable()
export class EmailReceiptTradeLinkService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private readonly scheduled: ScheduledTransactionsService,
  ) {}

  /**
   * Existing investment transactions that could be the trade the email
   * reports, closest day first. VOID rows are not offered, and neither is a row
   * another email already accounts for (it is that email's trade, not this one's).
   */
  async candidates(
    m: EntityManager,
    userId: string,
    trade: Record<string, unknown>,
    effectiveDate: string,
    receiptId: string,
  ): Promise<EmailReceiptCandidateSummary[]> {
    const accountId = trade.accountId;
    const symbol = trade.symbol;
    const action = tradeActionOf(trade.action);
    if (
      typeof accountId !== "string" ||
      typeof symbol !== "string" ||
      action === null
    ) {
      return [];
    }
    const day =
      typeof trade.date === "string"
        ? trade.date
        : await emailDayOfUser(m, userId, new Date(effectiveDate));
    // investment_transactions read as records for a pick list; VOID rows are left out (status != 'VOID').
    const rows = returnedRows<{
      id: string;
      date: string;
      total_amount: string | number;
      currency_code: string | null;
      symbol: string;
      quantity: string | number;
      description: string | null;
    }>(
      await m.query(
        `SELECT it.id, TO_CHAR(it.transaction_date, 'YYYY-MM-DD') AS date,
                ${TRADE_ROW_AMOUNT_SQL} AS total_amount, s.currency_code, s.symbol, it.quantity,
                it.description
           FROM investment_transactions it
           JOIN securities s ON s.id = it.security_id
          WHERE it.user_id = $1
            AND it.account_id = $2
            AND it.action = $3
            AND it.status != 'VOID'
            AND it.transaction_date BETWEEN ($4::date - $5::int) AND ($4::date + $5::int)
            AND (LOWER(s.symbol) = LOWER($6) OR LOWER(s.symbol) LIKE LOWER($7))
            AND NOT EXISTS (
                  SELECT 1
                    FROM email_receipts r
                   WHERE r.user_id = it.user_id
                     AND r.investment_transaction_id = it.id
                     AND r.id <> $9::uuid)
          ORDER BY ABS(it.transaction_date - $4::date) ASC, it.id ASC
          LIMIT $8`,
        [
          userId,
          accountId,
          tradeInvestmentAction(action),
          day,
          CANDIDATE_WINDOW_DAYS,
          symbol,
          `${escapeLikePattern(symbol)}.%`,
          MAX_CANDIDATES,
          receiptId,
        ],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      date: row.date,
      amount: Number(row.total_amount),
      currencyCode: row.currency_code ?? "",
      payeeName: row.symbol,
      description: row.description,
      quantity: Number(row.quantity),
    }));
  }

  /**
   * Close the email as covered by `investmentTransactionId`, and mark the
   * scheduled bill or deposit that trade pays as paid when it is not yet. One
   * transaction: a refusal writes nothing.
   */
  async link(
    userId: string,
    receiptId: string,
    investmentTransactionId: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const receipt = await m.getRepository(EmailReceipt).findOne({
        where: { id: receiptId, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!receipt) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.receiptNotFound",
            `Email ${receiptId} not found`,
            { id: receiptId },
          ),
        );
      }
      if (receipt.trade === null) {
        throw new BadRequestException(
          tr(
            "errors.emailReceipts.notATradeEmail",
            "This email was not read as a trade confirmation.",
          ),
        );
      }
      if (receipt.status === "skipped") {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.receiptSkipped",
            "This email could not be read (it was too large or could not be decoded), so there is nothing to process.",
          ),
        );
      }
      const requestStatus = await currentReceiptRequestStatus(
        m,
        userId,
        receipt.aiReviewRequestId,
      );
      if (requestStatus === "applied") {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.receiptApplied",
            "This email's proposal has already been applied to a transaction.",
          ),
        );
      }
      // Linked once, or booked by its approval: the email already accounts for
      // a row. A `trade_exists` email may be pointed at the right row instead.
      if (
        Boolean(receipt.investmentTransactionId) &&
        receipt.statusReason !== RECEIPT_TRADE_EXISTS_REASON
      ) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.tradeAccountedFor",
            "This email already accounts for an investment transaction, so it is not read again.",
          ),
        );
      }
      const rows = returnedRows<InvestmentRow>(
        await m.query(
          `SELECT it.id, it.account_id, it.security_id, it.action,
                  TO_CHAR(it.transaction_date, 'YYYY-MM-DD') AS date,
                  it.commission
             FROM investment_transactions it
            WHERE it.id = $1
              AND it.user_id = $2
              AND it.status != 'VOID'`,
          [investmentTransactionId, userId],
        ),
      );
      const linked = rows[0];
      if (!linked) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.transactionNotFound",
            "That transaction was not found.",
          ),
        );
      }

      const claimedElsewhere = returnedRows<{ id: string }>(
        await m.query(
          `SELECT id FROM email_receipts
            WHERE user_id = $1
              AND investment_transaction_id = $2
              AND id <> $3
            LIMIT 1`,
          [userId, investmentTransactionId, receipt.id],
        ),
      );
      if (claimedElsewhere.length > 0) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.tradeLinkedElsewhere",
            "Another email already accounts for that transaction.",
          ),
        );
      }

      await closeReceiptRequests(m, userId, receipt.id);
      // An approval that committed while this ran booked the trade: closing
      // skipped its applied request, and linking now would leave the email's
      // own row beside the linked one. Refused, so this transaction rolls back.
      const applied = returnedRows<{ id: string }>(
        await m.query(
          `SELECT id FROM ai_review_requests
            WHERE user_id = $1
              AND email_receipt_id = $2
              AND status = 'applied'
            LIMIT 1`,
          [userId, receipt.id],
        ),
      );
      if (applied.length > 0) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.receiptApplied",
            "This email's proposal has already been applied to a transaction.",
          ),
        );
      }
      await m.getRepository(EmailReceipt).update(
        { id: receipt.id, userId },
        {
          status: "ignored",
          statusReason: RECEIPT_TRADE_LINKED_REASON,
          aiReviewRequestId: null,
          investmentTransactionId,
        },
      );

      const linkedAction = tradeActionOf(linked.action);
      if (linked.security_id && linkedAction !== null) {
        const occurrence =
          await this.scheduled.findInvestmentOccurrenceForTrade(userId, {
            accountId: linked.account_id,
            securityId: linked.security_id,
            action: tradeInvestmentAction(linkedAction),
            date: linked.date,
            commission: Number(linked.commission ?? 0),
          });
        if (occurrence) {
          try {
            await this.scheduled.post(userId, occurrence.id, undefined, {
              expectedDueDate: occurrence.dueDate,
              recordOnly: true,
            });
          } catch (error) {
            // Paid in the meantime: the occurrence is already done, which is
            // what linking wanted. Nothing was written by the refused post.
            if (!(error instanceof ConflictException)) throw error;
          }
        }
      }
    });
  }
}
