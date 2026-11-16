import { canonicalUuid } from "./backup-id-remap.util";
import {
  BackupBondSeriesIdentity,
  BackupData,
  backupTables,
  parseBondCatalogIdentity,
} from "./backup-format";

/**
 * The pure half of the restore's bond series recovery
 * (`BackupBondSeriesRecoveryService`): which series a file's rows reference and
 * how the rows are pointed at the target catalog's ids.
 */

/** The catalog's unique key of a series, upper case on the code (the catalog compares it so). */
export function seriesKey(
  identity: Pick<
    BackupBondSeriesIdentity,
    "issuerCountryCode" | "issuerCode" | "seriesCode"
  >,
): string {
  return `${identity.issuerCountryCode.toUpperCase()}|${identity.issuerCode}|${identity.seriesCode.toUpperCase()}`;
}

/**
 * The identities of the series the file's investment transactions name, one per
 * series, in the order the file lists them.
 *
 * Only a series that a row names **and** the file's `bondCatalog` describes is
 * returned: the member alone is not a reason to fetch anything (a crafted file
 * listing hundreds of series no row uses costs the server nothing), and a row
 * naming an id the file does not describe restores as it always did. Ids are
 * compared canonicalised, because the rows were canonicalised by
 * `resolveRestoreReferences` and the member is untrusted text.
 */
export function referencedBondSeries(
  data: BackupData,
): BackupBondSeriesIdentity[] {
  const identities = parseBondCatalogIdentity(data.bondCatalog);
  if (identities.length === 0) return [];

  const named = new Set<string>();
  for (const row of backupTables(data).investment_transactions ?? []) {
    const id = canonicalUuid(row?.bond_instrument_id);
    if (id !== null) named.add(id);
  }
  if (named.size === 0) return [];

  const seen = new Set<string>();
  const wanted: BackupBondSeriesIdentity[] = [];
  for (const identity of identities) {
    const id = canonicalUuid(identity.bondInstrumentId);
    if (id === null || !named.has(id)) continue;
    const key = seriesKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ ...identity, bondInstrumentId: id });
  }
  return wanted;
}

/**
 * The document with every `investment_transactions.bond_instrument_id` found in
 * `idByBackupId` rewritten to the target catalog's id for the same series, as a
 * new document. An id the map does not hold is left for
 * `severUnavailableCatalogLinks`, which keeps it where the catalog has it and
 * writes NULL where it does not.
 */
export function applyBondSeriesIds(
  data: BackupData,
  idByBackupId: ReadonlyMap<string, string>,
): BackupData {
  const rows = data.investment_transactions;
  if (idByBackupId.size === 0 || !Array.isArray(rows)) return data;
  return {
    ...data,
    investment_transactions: rows.map((row) => {
      const id = canonicalUuid(row?.bond_instrument_id);
      const target = id === null ? undefined : idByBackupId.get(id);
      return target === undefined || target === row.bond_instrument_id
        ? row
        : { ...row, bond_instrument_id: target };
    }),
  };
}
