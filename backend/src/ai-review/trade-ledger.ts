import type { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { todayInTimezone } from "../common/date-utils";
import { getEffectiveTimezoneOfUser } from "../common/users-by-timezone.util";
import { escapeLikePattern } from "../transactions/transaction-search.util";
import type { AiReviewTradeInput } from "./ai-review-work.types";
import {
  tradeInvestmentAction,
  tradeMatchesOnQuantity,
  type TradeAction,
} from "./trade-action";

/**
 * What an investment transaction row `it` came to, as a trade email states it:
 * its total, except a reinvestment's, whose row carries no cash total, so its
 * shares at its price plus the commission.
 */
export const TRADE_ROW_AMOUNT_SQL = `CASE WHEN it.action = 'REINVEST'
            THEN ROUND(COALESCE(it.quantity, 0) * COALESCE(it.price, 0)
                       + COALESCE(it.commission, 0), 4)
            ELSE it.total_amount END`;

/** What the ledger already holds of one trade. */
export interface TradeLedgerMatch {
  /**
   * A matching row no other email accounts for: the trade is already booked
   * (a manual entry, a broker import), so this email is a duplicate of it.
   */
  unclaimedId: string | null;
  /**
   * Whether any matching row exists, accounted for or not. A second identical
   * fill on the same day is proposed, but only a person approves it: the
   * auto-apply gate requires none. A dividend counts the same day's
   * reinvestment of that security too, and the other way round: a broker on a
   * DRIP may send one email for the payout and one for the shares it bought.
   */
  anyMatch: boolean;
}

/** The other way a broker reports one dividend payout. */
const PAYOUT_COUNTERPART: Partial<Record<TradeAction, TradeAction>> = {
  DIVIDEND: "REINVEST",
  REINVEST: "DIVIDEND",
};

/**
 * The investment transactions with this trade's account, action, day and
 * share count (a cash dividend's amount, as it moves no shares) whose security
 * is the given one, or the ticker or one of its listings (`XCNS`, `XCNS.TO`),
 * a VOID one excepted -- and which of them no email other than `receiptId`
 * accounts for (`email_receipts.investment_transaction_id`).
 *
 * One function for every surface that asks "is this trade already booked": the
 * pipeline before it proposes, the card before it is shown or approved, the
 * confirm inside the write's own transaction, and the link's candidates.
 */
export async function findTradeInLedger(
  m: EntityManager,
  userId: string,
  trade: Pick<
    AiReviewTradeInput,
    "accountId" | "action" | "quantity" | "totalAmount" | "date"
  > &
    ({ symbol: string } | { securityId: string }),
  receiptId: string | null,
): Promise<TradeLedgerMatch> {
  const bySecurity = "securityId" in trade;
  const byQuantity = tradeMatchesOnQuantity(trade.action);
  const rows = returnedRows<{ id: string; claimed: boolean }>(
    await m.query(
      `SELECT it.id,
              EXISTS (
                SELECT 1
                  FROM email_receipts r
                 WHERE r.user_id = it.user_id
                   AND r.investment_transaction_id = it.id
                   AND r.id IS DISTINCT FROM $8::uuid) AS claimed
         FROM investment_transactions it
         JOIN securities s ON s.id = it.security_id
        WHERE it.user_id = $1
          AND it.account_id = $2
          AND it.action = $3
          AND it.transaction_date = $4::date
          AND it.status != 'VOID'
          AND (CASE WHEN $10::boolean
                    THEN it.quantity = $5::numeric
                    ELSE it.total_amount = $11::numeric END)
          AND (it.security_id = $9::uuid
               OR ($9::uuid IS NULL
                   AND (LOWER(s.symbol) = LOWER($6::text)
                        OR LOWER(s.symbol) LIKE LOWER($7::text))))
        ORDER BY it.created_at, it.id
        LIMIT 20`,
      [
        userId,
        trade.accountId,
        tradeInvestmentAction(trade.action),
        trade.date,
        byQuantity && trade.quantity !== null ? String(trade.quantity) : null,
        bySecurity ? null : trade.symbol,
        bySecurity ? null : `${escapeLikePattern(trade.symbol)}.%`,
        receiptId,
        bySecurity ? trade.securityId : null,
        byQuantity,
        String(trade.totalAmount),
      ],
    ),
  );
  const counterpart = PAYOUT_COUNTERPART[trade.action];
  const payoutTwin =
    rows.length === 0 && counterpart !== undefined
      ? returnedRows<{ id: string }>(
          await m.query(
            `SELECT it.id
               FROM investment_transactions it
               JOIN securities s ON s.id = it.security_id
              WHERE it.user_id = $1
                AND it.account_id = $2
                AND it.action = $3
                AND it.transaction_date = $4::date
                AND it.status != 'VOID'
                AND (it.security_id = $7::uuid
                     OR ($7::uuid IS NULL
                         AND (LOWER(s.symbol) = LOWER($5::text)
                              OR LOWER(s.symbol) LIKE LOWER($6::text))))
              LIMIT 1`,
            [
              userId,
              trade.accountId,
              tradeInvestmentAction(counterpart),
              trade.date,
              bySecurity ? null : trade.symbol,
              bySecurity ? null : `${escapeLikePattern(trade.symbol)}.%`,
              bySecurity ? trade.securityId : null,
            ],
          ),
        ).length > 0
      : false;
  return {
    unclaimedId: rows.find((row) => !row.claimed)?.id ?? null,
    anyMatch: rows.length > 0 || payoutTwin,
  };
}

/**
 * Record on the email an `email_trade` request was raised for the investment
 * transaction its approval booked, in the write's own transaction.
 */
export async function recordTradeBooking(
  m: EntityManager,
  userId: string,
  requestId: string,
  investmentTransactionId: string,
): Promise<void> {
  await m.query(
    `UPDATE email_receipts r
        SET investment_transaction_id = $3
       FROM ai_review_requests q
      WHERE q.id = $2
        AND q.user_id = $1
        AND r.id = q.email_receipt_id
        AND r.user_id = $1`,
    [userId, requestId, investmentTransactionId],
  );
}

/**
 * The calendar day an email was sent, in the user's own timezone (their
 * preference, else the last one their browser reported, else UTC): the day a
 * trade is dated when its email states none. Not the UTC day, which dates an
 * evening fill in the Americas a day late.
 */
export async function emailDayOfUser(
  m: EntityManager,
  userId: string,
  sentAt: Date,
): Promise<string> {
  const timezone = await getEffectiveTimezoneOfUser(m, userId);
  return todayInTimezone(timezone, sentAt) ?? sentAt.toISOString().slice(0, 10);
}
