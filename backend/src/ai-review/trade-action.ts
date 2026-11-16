import {
  PARSED_TRADE_ACTIONS,
  tradeActionMovesShares,
  type ParsedTradeAction,
} from "../email-receipts/parsing/receipt-parser.types";
import { roundToDecimals } from "../common/round.util";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { INVESTMENT_PRICE_DECIMALS } from "../securities/investment-amount.util";

/**
 * What a trade-confirmation email reports, as the trade pipeline, the review
 * card, the ledger check and the link carry it: a buy, a sell, a cash dividend
 * or a reinvested dividend. The one mapping to and from the ledger's action.
 */
export type TradeAction = ParsedTradeAction;

export const TRADE_ACTIONS: readonly TradeAction[] = PARSED_TRADE_ACTIONS;

const INVESTMENT_ACTION_OF: Readonly<Record<TradeAction, InvestmentAction>> = {
  BUY: InvestmentAction.BUY,
  SELL: InvestmentAction.SELL,
  DIVIDEND: InvestmentAction.DIVIDEND,
  REINVEST: InvestmentAction.REINVEST,
};

/** The investment transaction action a trade books. */
export function tradeInvestmentAction(action: TradeAction): InvestmentAction {
  return INVESTMENT_ACTION_OF[action];
}

/** The trade action a value names (a stored proposal, a ledger row's action), else null. */
export function tradeActionOf(value: unknown): TradeAction | null {
  return TRADE_ACTIONS.find((action) => action === value) ?? null;
}

/**
 * Whether the ledger tells two of these trades apart by share count. A cash
 * dividend moves no shares (its row stores a quantity of 0 when none was
 * given), so the same dividend is the same account, security, day and amount.
 */
export function tradeMatchesOnQuantity(action: TradeAction): boolean {
  return tradeActionMovesShares(action);
}

/**
 * The figures a trade's card is previewed (and its row created) with. The
 * executed total is the fact (INV-TRADE-001), and for a buy, a sell or a cash
 * dividend it is passed as given. A reinvestment's row carries no cash total
 * (`deriveInvestmentTotal` is 0 for REINVEST, and a supplied one is ignored):
 * what it cost is its shares at its price plus the commission, so the price is
 * the one the email's total implies, `(total - commission) / shares`.
 */
export function tradeCardAmounts(trade: {
  action: TradeAction;
  quantity: number | null;
  totalAmount: number;
  commission: number;
}): { quantity?: number; price?: number; totalAmount?: number } {
  const quantity = trade.quantity ?? undefined;
  if (trade.action === "REINVEST" && quantity !== undefined && quantity > 0) {
    return {
      quantity,
      price: roundToDecimals(
        (trade.totalAmount - trade.commission) / quantity,
        INVESTMENT_PRICE_DECIMALS,
      ),
    };
  }
  return { quantity, totalAmount: trade.totalAmount };
}
