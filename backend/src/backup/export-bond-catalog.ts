import { BackupBondCatalog } from "./backup-format";
import { ExportReader } from "./export-cursor";

/**
 * The identity of every bond series the user's investment transactions
 * reference: where it came from and what it is called, never what it pays.
 *
 * `bond_instruments` is reference data a backup does not carry (INV-BOND-008:
 * a deployment's catalog holds only what a person fetched), so a restore onto a
 * deployment that lacks a series used to drop the series from every row that
 * named it. With the identity in the file the restore can fetch the series from
 * the official source instead. Terms are deliberately not exported: they enter
 * the catalog only from the official source or an administrator (INV-BOND-006),
 * so a file can never be the origin of a rate.
 *
 * `$1` is the exporting user, bound by the reader. The catalog is global and
 * readable by every identity; the user's own rows pick which entries.
 */
const BOND_SERIES_IDENTITY_SQL = `
  SELECT i.id AS "bondInstrumentId",
         i.issuer_country_code AS "issuerCountryCode",
         i.issuer_code AS "issuerCode",
         i.program_code AS "programCode",
         i.series_code AS "seriesCode"
    FROM bond_instruments i
   -- includes VOID rows: records read -- a voided row still names its series.
   WHERE i.id IN (SELECT t.bond_instrument_id
                    FROM investment_transactions t
                   WHERE t.user_id = $1 AND t.bond_instrument_id IS NOT NULL)
   ORDER BY i.issuer_country_code, i.issuer_code, i.series_code`;

/**
 * The `bondCatalog` document member, read in the export's snapshot. A bounded
 * read: at most one entry per series of the catalog the user holds rows in.
 */
export async function readBondCatalogIdentity(
  reader: ExportReader,
): Promise<BackupBondCatalog> {
  const rows = await reader.read(BOND_SERIES_IDENTITY_SQL);
  return {
    series: rows.map((row) => ({
      bondInstrumentId: String(row.bondInstrumentId),
      issuerCountryCode: String(row.issuerCountryCode),
      issuerCode: String(row.issuerCode),
      programCode: String(row.programCode),
      seriesCode: String(row.seriesCode),
    })),
  };
}
