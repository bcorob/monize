import { BOND_ENGINE_PRICE_SOURCE } from "../bonds/bond-price-source";
import { BackupData } from "./backup-format";

/**
 * The file's price rows without the bond engine's rows of the given securities:
 * they were computed from an instrument the security is no longer linked to,
 * nothing would ever recompute or remove them, and a security priced by a stale
 * engine looks like a valid price (INV-BOND-005). The input is returned as is
 * when there is nothing to remove or it is not a list.
 */
export function withoutEnginePrices(
  prices: BackupData["security_prices"],
  securityIds: ReadonlySet<string>,
): BackupData["security_prices"] {
  if (securityIds.size === 0 || !Array.isArray(prices)) return prices;
  return prices.filter(
    (p) =>
      !(
        p.source === BOND_ENGINE_PRICE_SOURCE &&
        typeof p.security_id === "string" &&
        securityIds.has(p.security_id)
      ),
  );
}

/**
 * The file's investment transactions without the bond series of the given
 * securities, which are restored unlinked: a security that is not
 * program-linked never has one (INV-BOND-007).
 */
export function withoutBondSeries(
  rows: BackupData["investment_transactions"],
  securityIds: ReadonlySet<string>,
): BackupData["investment_transactions"] {
  if (securityIds.size === 0 || !Array.isArray(rows)) return rows;
  return rows.map((row) =>
    typeof row.security_id === "string" &&
    securityIds.has(row.security_id) &&
    row.bond_instrument_id != null
      ? { ...row, bond_instrument_id: null }
      : row,
  );
}

/**
 * What a restore must not keep of securities it restored unlinked from their
 * bond program: their engine price rows and the series of their transactions.
 * Replaces the two lists on `data`.
 */
export function dropSeveredBondData(
  data: BackupData,
  securityIds: ReadonlySet<string>,
): void {
  data.security_prices = withoutEnginePrices(data.security_prices, securityIds);
  data.investment_transactions = withoutBondSeries(
    data.investment_transactions,
    securityIds,
  );
}
