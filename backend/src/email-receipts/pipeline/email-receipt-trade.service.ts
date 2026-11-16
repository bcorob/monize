import { Injectable } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import type { PendingAiAction } from "../../ai/actions/ai-action.types";
import { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import {
  EMAIL_RECEIPTS_CLAIM_KEY,
  type AiReviewTradeInput,
} from "../../ai-review/ai-review-work.types";
import {
  emailDayOfUser,
  findTradeInLedger,
} from "../../ai-review/trade-ledger";
import type { TradeAction } from "../../ai-review/trade-action";
import { roundMoney } from "../../common/round.util";
import type { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import type {
  EmailReceipt,
  EmailReceiptStatus,
} from "../entities/email-receipt.entity";
import {
  effectiveReceiptDate,
  isForwardedReceipt,
} from "../imap/forwarded-receipt";
import {
  tradeExecutedTotalUnits,
  tradeMayAutoApply,
} from "../parsing/parse-trade";
import type {
  ParsedTrade,
  ReceiptTradeDefinition,
} from "../parsing/receipt-parser.types";
import { isRefusal, refusalNote } from "./receipt-failure";
import { RECEIPT_TRADE_INSTRUCTION } from "./receipt-instructions";
import { closeReceiptRequests } from "./receipt-requests.util";
import { readTradeEmail } from "./trade-reading";

/** The `status_reason` of an email whose trade is already in the ledger. */
export const RECEIPT_TRADE_EXISTS_REASON = "trade_exists";
const MONEY_UNITS = 10_000;
const MAX_DESCRIPTION = 200;

/** What reading one trade email decided: the receipt's new state and, when the gate passed, the card to confirm. */
export interface TradeOutcome {
  status: EmailReceiptStatus;
  reason: string | null;
  /** The `email_trade` request the receipt now stands behind; null when it holds none. */
  requestId: string | null;
  trade: ParsedTrade;
  /** The ledger row the email accounts for: the one already booked (`trade_exists`), else null. */
  investmentTransactionId: string | null;
  /** Present when the opt-in auto-apply gate passed: the signed card to confirm. */
  autoApply: PendingAiAction | null;
}

export interface TradeContext {
  parser: EmailReceiptParser;
  definition: ReceiptTradeDefinition;
  lines: readonly string[];
  mailboxAutoApply: boolean;
}

/**
 * Reads a brokerage trade-confirmation email through to a proposal to CREATE the
 * investment transaction it reports (design "Trade confirmations"). It runs
 * inside the pipeline's transaction, under the receipt's row lock: read the
 * lines with the profile's `trade` section, refuse a trade the ledger already
 * holds, queue an `email_trade` request born claimed by this module, and store
 * the signed card as its proposal. Nothing here writes the ledger: the row is
 * created by `/ai/actions/confirm` after a person approves the card, or by the
 * same call after the opt-in auto-apply gate (INV-RECEIPT-003).
 */
@Injectable()
export class EmailReceiptTradeService {
  constructor(
    private readonly requests: AiReviewRequestsService,
    private readonly work: AiReviewWorkService,
  ) {}

  async process(
    m: EntityManager,
    userId: string,
    receipt: EmailReceipt,
    context: TradeContext,
  ): Promise<TradeOutcome> {
    const { trade } = await readTradeEmail(
      m,
      userId,
      context.definition,
      context.lines,
    );
    const outcome = (
      status: EmailReceiptStatus,
      reason: string | null,
      requestId: string | null = null,
      autoApply: PendingAiAction | null = null,
      investmentTransactionId: string | null = null,
    ): TradeOutcome => ({
      status,
      reason,
      requestId,
      trade,
      investmentTransactionId,
      autoApply,
    });

    if (!trade.complete) return outcome("parse_failed", trade.reason);
    const input = this.toInput(
      receipt,
      trade,
      trade.date ??
        (await emailDayOfUser(m, userId, effectiveReceiptDate(receipt))),
    );

    // The ledger may already hold this trade (a manual entry, a broker import).
    // Creating it twice is the worst thing automation can do here, so it is an
    // ignored email that says why and accounts for that row, never a second
    // proposal. A matching row another email already accounts for is a second,
    // identical fill: proposed, but never auto-applied.
    const ledger = await findTradeInLedger(m, userId, input, receipt.id);
    if (ledger.unclaimedId !== null) {
      return outcome(
        "ignored",
        RECEIPT_TRADE_EXISTS_REASON,
        null,
        null,
        ledger.unclaimedId,
      );
    }

    // A reprocess replaces the proposal: the receipt's earlier requests close
    // first, so the one-open-request-per-email index never refuses this one.
    await closeReceiptRequests(m, userId, receipt.id);
    const request = await this.requests.enqueueTrade(m, userId, {
      emailReceiptId: receipt.id,
      instruction: RECEIPT_TRADE_INSTRUCTION,
      claimedBy: EMAIL_RECEIPTS_CLAIM_KEY,
    });
    if (!request) return outcome("review_conflict", null);

    try {
      const done = await this.work.submitTrade(
        userId,
        EMAIL_RECEIPTS_CLAIM_KEY,
        request.id,
        input,
      );
      const gate =
        context.mailboxAutoApply &&
        context.parser.status === "approved" &&
        tradeMayAutoApply(trade) &&
        !ledger.anyMatch &&
        // The broker of a forward is a claim of the email's text: a person
        // looks, seeing who forwarded it (A26-H02).
        !isForwardedReceipt(receipt);
      return outcome("review", null, request.id, gate ? done.action : null);
    } catch (error) {
      if (!isRefusal(error)) throw error;
      await this.requests.release(
        userId,
        request.id,
        EMAIL_RECEIPTS_CLAIM_KEY,
        {
          final: true,
          note: refusalNote(error),
        },
      );
      return outcome("review", "proposal_refused", request.id);
    }
  }

  /** The proposal a complete reading makes on `date` (the email's own, else the day it was sent): the executed total and the commission, in currency units. */
  private toInput(
    receipt: EmailReceipt,
    trade: ParsedTrade,
    date: string,
  ): AiReviewTradeInput {
    const quantity = trade.quantity;
    const commission = (trade.commission ?? 0) / MONEY_UNITS;
    const action = trade.action as TradeAction;
    // The executed total is the fact. An email that states only a price gives
    // the total its price implies (commission added to a buy, taken from a sell).
    const total = roundMoney(
      (tradeExecutedTotalUnits(trade) as number) / MONEY_UNITS,
    );
    return {
      accountId: trade.accountId as string,
      action,
      symbol: trade.symbol as string,
      quantity,
      totalAmount: total,
      commission,
      date,
      description: `Email receipt: ${receipt.subject}`.slice(
        0,
        MAX_DESCRIPTION,
      ),
      currency: trade.currency ?? null,
    };
  }
}
