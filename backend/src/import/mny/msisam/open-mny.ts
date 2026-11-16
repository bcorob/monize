import MDBReader from "mdb-reader";
import type { Value } from "mdb-reader";

import {
  MnyNotAMoneyFileError,
  MnyUnreadableDatabaseError,
} from "../mny-errors";
import { MnyFileFormat } from "../model/mny-money99";
import { JET_ENGINE_NAME, MsisamEncryptionScheme } from "./jet-header";
import { decryptMsisamInPlace, readMsisamMetadata } from "./msisam-decrypt";

/** What page 0 says about a file, however its pages were obtained. */
interface MsisamFileMetadata {
  readonly format: MnyFileFormat;
  readonly scheme: MsisamEncryptionScheme;
  readonly passwordProtected: boolean;
}

/** Tables every Money version has. */
const MONEY_TABLES = ["ACCT", "TRN", "DHD"] as const;

/**
 * Refuses a Jet 3 file that lacks Money's tables. Its header cannot say: a
 * Money 97-99 file and an Access 97 `.mdb` both read "Standard Jet DB",
 * version 0. An MSISAM file is Money's by its engine name alone.
 *
 * @throws MnyNotAMoneyFileError
 */
export function assertMoneyTables(
  format: MnyFileFormat,
  tableNames: readonly string[],
): void {
  if (
    format === "jet3" &&
    !MONEY_TABLES.every((table) => tableNames.includes(table))
  ) {
    throw new MnyNotAMoneyFileError(JET_ENGINE_NAME);
  }
}

/**
 * Opens a decrypted `.mny` file with `mdb-reader` and exposes it through a
 * tolerant façade.
 *
 * Money's table and column set changed across releases -- Money 2001 has no
 * `BILL` table at all, which is what crash-looped the PR #192 proof of concept.
 * Nothing above this layer may call `getTable` directly: reads go through
 * `getTableOrNull` and `MnyTable.rows`, which silently drops columns the file
 * does not have instead of throwing.
 *
 * `mdb-reader` is ESM-only. TypeScript's `nodenext` module resolution emits a
 * `require()` for it, which Node 22 resolves natively, and Jest transforms it
 * to CommonJS via the `transformIgnorePatterns` allowlist the repo already
 * uses for `openid-client` and friends. That is why the reader is a plain
 * dependency here rather than the vendored copy the design document proposed.
 */

export type MnyValue = Value;
export type MnyRow = Record<string, MnyValue>;

export interface MnyTable {
  /** Table name as stored in the Money file, e.g. "TRN". */
  readonly name: string;
  /** Number of rows the table holds. */
  readonly rowCount: number;
  /** Every column name present in this file's version of the table. */
  readonly columnNames: readonly string[];
  /** True when this file's version of the table has the given column. */
  hasColumn(column: string): boolean;
  /**
   * Reads rows, keeping only the requested columns that actually exist.
   * Reading all columns (no argument) is the tolerant default.
   */
  rows(columns?: readonly string[]): MnyRow[];
}

export interface MnyDatabase {
  /**
   * `jet3` for a Money 97-99 file, `msisam` for Money 2001 onwards. The two
   * use different code spaces for the same columns (`mny-money99.ts`).
   */
  readonly format: MnyFileFormat;
  /** Key-derivation scheme the source file used. */
  readonly scheme: MsisamEncryptionScheme;
  /** True when a non-blank password was needed to open the file. */
  readonly passwordProtected: boolean;
  /** Every user table present in the file, in file order. */
  readonly tableNames: readonly string[];
  /** True when the file has the named table. */
  hasTable(name: string): boolean;
  /** The named table, or null when this Money version does not have it. */
  getTableOrNull(name: string): MnyTable | null;
}

function wrapTable(reader: MDBReader, name: string): MnyTable {
  const table = reader.getTable(name);
  const columnNames = table.getColumnNames();
  const present = new Set(columnNames);

  return {
    name,
    rowCount: table.rowCount,
    columnNames,
    hasColumn: (column) => present.has(column),
    rows: (columns) => {
      const requested = columns?.filter((column) => present.has(column));
      if (requested !== undefined && requested.length === 0) {
        // Asking mdb-reader for an empty column list returns empty objects;
        // returning one per row keeps row counts meaningful for callers.
        return Array.from({ length: table.rowCount }, () => ({}) as MnyRow);
      }
      try {
        return table.getData<MnyRow>(
          requested === undefined ? undefined : { columns: requested },
        );
      } catch (error) {
        // Row data is read lazily, page by page, long after the table
        // definition was resolved -- so a file whose upload was cut short, or
        // whose data pages are damaged, fails here rather than in `wrapTable`.
        // Without this the raw "Wrong page type" escapes as an untyped error:
        // the parse call 500s with no code for the wizard to act on, and a
        // running job records it as retryable, offering Try again on a file
        // that will fail the same way forever.
        throw new MnyUnreadableDatabaseError(error);
      }
    },
  };
}

/**
 * Decrypts and opens a `.mny` file.
 *
 * `buffer` is decrypted in place, so the caller must hand over ownership (see
 * `decryptMsisamInPlace`). Tables are materialised lazily -- `getTableOrNull`
 * reads a table's definition on first call, so a 200 MB file never has more
 * than one table resident at a time.
 *
 * @throws MnyImportError subclasses for unsupported, truncated, password
 *   protected or unparseable files
 */
export function openMnyFile(buffer: Buffer, password?: string): MnyDatabase {
  return openDatabase(buffer, decryptMsisamInPlace(buffer, password));
}

/**
 * Opens a buffer that has **already** been through `decryptMsisamInPlace`.
 *
 * The staged copy of an upload is stored decrypted, on purpose: the password is
 * spent on the parse request and never persisted (ADR-2, ADR-7). The import job
 * then re-parses those bytes -- and must not decrypt them a second time. RC4 is
 * symmetric, so a second pass re-encrypts pages 1..0xE, and the only symptom is
 * `MnyUnreadableDatabaseError` from a layer that looks unrelated.
 *
 * The scheme and password state still come from page 0, which is never
 * encrypted and so reads the same either way.
 */
export function openDecryptedMnyFile(buffer: Buffer): MnyDatabase {
  return openDatabase(buffer, readMsisamMetadata(buffer));
}

function openDatabase(
  buffer: Buffer,
  { format, scheme, passwordProtected }: MsisamFileMetadata,
): MnyDatabase {
  let reader: MDBReader;
  let tableNames: string[];
  try {
    // `mdb-reader` writes into the bytes it reads, and the damage is silent:
    // a second read of the same buffer returns every currency value with its
    // sign stripped (-20.0000 reads back as 20.0000) while row counts, dates
    // and text all stay correct. The wizard hits this on every import --
    // `POST /parse` reads the upload and then stages those same bytes, so the
    // background job's re-read saw an all-positive ledger: every debit became
    // a credit, both sides of a transfer came out positive, and account
    // opening balances were absolute too, because they share `toAmount`.
    //
    // The reader therefore gets its own copy and the caller's buffer stays
    // readable plaintext. That costs one extra file-size of peak memory (see
    // the README's Memory section) and is the price of `openMnyFile` being a
    // door you may walk through twice.
    reader = new MDBReader(Buffer.from(buffer));
    tableNames = reader.getTableNames();
  } catch (error) {
    throw new MnyUnreadableDatabaseError(error);
  }

  assertMoneyTables(format, tableNames);
  const present = new Set(tableNames);
  const cache = new Map<string, MnyTable>();

  return {
    format,
    scheme,
    passwordProtected,
    tableNames,
    hasTable: (name) => present.has(name),
    getTableOrNull: (name) => {
      if (!present.has(name)) {
        return null;
      }
      const cached = cache.get(name);
      if (cached) {
        return cached;
      }
      try {
        const table = wrapTable(reader, name);
        cache.set(name, table);
        return table;
      } catch (error) {
        throw new MnyUnreadableDatabaseError(error);
      }
    },
  };
}
