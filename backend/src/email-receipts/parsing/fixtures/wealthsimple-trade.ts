import type { ReceiptParserDefinition } from "../receipt-parser.types";

/** The text part of a Wealthsimple "Your order has been filled" email (a fractional buy). */
export const WEALTHSIMPLE_BUY_SUBJECT = "Your order has been filled";
export const WEALTHSIMPLE_BUY_BODY = [
  "Your order has been filled",
  "Account: RRSP",
  "Type: Fractional Buy",
  "Symbol: XCNS",
  "Shares: 75.9878",
  "Average price: $26.32",
  "Total cost: $2,000.00",
  "Time: October 15, 2026 12:04 EDT",
  "Learn more about order fulfillment in the Help Centre.",
].join("\n");

export const WEALTHSIMPLE_RRSP_ACCOUNT_ID =
  "11111111-1111-4111-8111-111111111111";
export const WEALTHSIMPLE_TFSA_ACCOUNT_ID =
  "22222222-2222-4222-8222-222222222222";

export const WEALTHSIMPLE_TRADE_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  requireLine: ["Your order has been filled"],
  trade: {
    account: ["Account: {account}"],
    action: ["Type: {action}"],
    symbol: ["Symbol: {symbol}"],
    quantity: ["Shares: {quantity}"],
    price: ["Average price: {amount}"],
    total: ["Total cost: {amount}"],
    date: ["Time: {date}"],
    accountRules: [
      { match: "RRSP", accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID },
      { match: "TFSA", accountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID },
    ],
  },
};
