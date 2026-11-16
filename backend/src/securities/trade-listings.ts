import type { EntityManager } from "typeorm";
import { escapeLikePattern } from "../transactions/transaction-search.util";
import { Security } from "./entities/security.entity";

/** The most listings one ticker is looked up against. */
const MAX_TRADE_LISTINGS = 10;

/**
 * The user's active securities a broker's ticker can mean, strictly: the
 * symbol itself (any case) or the symbol with an exchange suffix (`XCNS`
 * finds `XCNS.TO`), never a name or a fragment. The one query behind
 * `SecuritiesService.resolveByTradeSymbol` and the trade reader's currency
 * fallback, so both see the same listings.
 */
export async function findTradeListings(
  m: EntityManager,
  userId: string,
  ticker: string,
): Promise<Security[]> {
  const symbol = (ticker ?? "").trim();
  if (!symbol) return [];
  return m
    .getRepository(Security)
    .createQueryBuilder("security")
    .where("security.userId = :userId", { userId })
    .andWhere("security.isActive = true")
    .andWhere(
      "(LOWER(security.symbol) = LOWER(:symbol) OR LOWER(security.symbol) LIKE LOWER(:suffixed))",
      { symbol, suffixed: `${escapeLikePattern(symbol)}.%` },
    )
    .orderBy("security.symbol", "ASC")
    .take(MAX_TRADE_LISTINGS)
    .getMany();
}

/**
 * The currency a ticker trades in for this user: the one currency all its
 * listings share, else null (no listing, or listings in two currencies, which
 * the ticker alone cannot choose between).
 */
export async function tradeListingsCurrency(
  m: EntityManager,
  userId: string,
  ticker: string,
): Promise<string | null> {
  const codes = new Set(
    (await findTradeListings(m, userId, ticker)).map((row) =>
      row.currencyCode.toUpperCase(),
    ),
  );
  return codes.size === 1 ? [...codes][0] : null;
}
