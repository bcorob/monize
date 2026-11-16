import { tradeActionOf } from "../../ai-review/trade-action";
import { roundMoney } from "../../common/round.util";
import { tradeActionMovesShares } from "../parsing/receipt-parser.types";
import type { EmailReceiptTradeProposal } from "./email-receipt.view";
import { isRecord } from "../../common/helpers/is-record";

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The trade an `email_trade` request's stored proposal (`StoredAiReviewTradeProposal`)
 * holds, read from the card's preview, the figures the confirmation shows and
 * the commit writes. Null when the proposal is absent or any figure the reader
 * needs is missing or malformed: a partial trade is not shown as a trade. A cash
 * dividend may carry no share count and no price (it was paid as one amount);
 * one with no shares has no amount per share either, though the preview's
 * price is then the whole amount (`derivePriceFromTotal` divides by 1). A
 * reinvestment's row carries no cash total, so its total is what it cost: its
 * shares at its price plus the commission.
 */
export function readTradeProposal(
  proposal: unknown,
): EmailReceiptTradeProposal | null {
  if (!isRecord(proposal) || !isRecord(proposal.action)) return null;
  const preview = proposal.action.preview;
  if (!isRecord(preview)) return null;
  const action = tradeActionOf(preview.investmentAction);
  if (action === null) return null;
  const accountName = text(preview.accountName);
  const date = text(preview.transactionDate);
  const symbol = text(preview.symbol);
  const currencyCode = text(preview.securityCurrency);
  const quantity = finite(preview.quantity);
  const price = finite(preview.price);
  const totalAmount = finite(preview.totalAmount);
  const commission = finite(preview.commission);
  if (
    accountName === null ||
    date === null ||
    symbol === null ||
    currencyCode === null ||
    (tradeActionMovesShares(action) && (quantity === null || price === null)) ||
    totalAmount === null ||
    commission === null
  ) {
    return null;
  }
  const shares = quantity !== null && quantity > 0 ? quantity : null;
  return {
    accountName,
    date,
    action,
    symbol,
    securityName: text(preview.securityName),
    quantity: tradeActionMovesShares(action) ? quantity : shares,
    price: tradeActionMovesShares(action) || shares !== null ? price : null,
    commission,
    totalAmount:
      action === "REINVEST" && quantity !== null && price !== null
        ? roundMoney(quantity * price + commission)
        : totalAmount,
    currencyCode,
  };
}
