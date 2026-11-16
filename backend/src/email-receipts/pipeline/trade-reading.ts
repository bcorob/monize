import type { EntityManager } from "typeorm";
import { tradeListingsCurrency } from "../../securities/trade-listings";
import {
  parseTradeLinesTraced,
  type TracedTrade,
} from "../parsing/parse-trade";
import type { ReceiptTradeDefinition } from "../parsing/receipt-parser.types";

/**
 * Read a trade email the way the pipeline books it: the lines alone first,
 * and only when an account rule needs a currency the email does not name, a
 * second read with the currency of the user's security for the ticker (the
 * one all its listings share; listings in two currencies settle nothing, and
 * the reading stays `trade_no_currency`). The one implementation behind the
 * pipeline, the profile test and the preview, so each decides the same account.
 */
export async function readTradeEmail(
  m: EntityManager,
  userId: string,
  definition: ReceiptTradeDefinition,
  lines: readonly string[],
): Promise<TracedTrade> {
  const first = parseTradeLinesTraced(definition, lines);
  if (first.trade.reason !== "trade_no_currency" || !first.trade.symbol) {
    return first;
  }
  const securityCurrency = await tradeListingsCurrency(
    m,
    userId,
    first.trade.symbol,
  );
  return securityCurrency === null
    ? first
    : parseTradeLinesTraced(definition, lines, { securityCurrency });
}
