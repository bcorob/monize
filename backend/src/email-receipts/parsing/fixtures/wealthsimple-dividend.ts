import type { ReceiptParserDefinition } from "../receipt-parser.types";
import { WEALTHSIMPLE_TFSA_ACCOUNT_ID } from "./wealthsimple-trade";

/** A cash dividend notice: the amount paid and no share count. */
export const WEALTHSIMPLE_DIVIDEND_BODY = [
  "You received a dividend",
  "Type: Dividend",
  "Symbol: XEQT",
  "Amount: $12.34",
  "Date: October 15, 2026",
].join("\n");

/** A reinvested dividend (DRIP): the shares the distribution bought. */
export const WEALTHSIMPLE_DRIP_BODY = [
  "You received a dividend",
  "Type: Dividend reinvested",
  "Symbol: XEQT",
  "Shares: 0.3721",
  "Price: $33.16",
  "Amount: $12.34",
  "Date: October 15, 2026",
].join("\n");

/** One profile for the sender's dividend notices, cash and reinvested; no account text, so a default account. */
export const WEALTHSIMPLE_DIVIDEND_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  requireLine: ["You received a dividend"],
  trade: {
    action: ["Type: {action}"],
    symbol: ["Symbol: {symbol}"],
    quantity: ["Shares: {quantity}"],
    price: ["Price: {amount}"],
    total: ["Amount: {amount}"],
    date: ["Date: {date}"],
    defaultAccountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID,
  },
};
