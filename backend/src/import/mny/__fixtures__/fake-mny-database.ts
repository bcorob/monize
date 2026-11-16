import { MnyFileFormat } from "../model/mny-money99";
import { MnyDatabase, MnyRow, MnyTable, MnyValue } from "../msisam/open-mny";

/**
 * In-memory stand-in for an open Money file.
 *
 * The committed `.mny` files are small samples: `PAY`, `CRNC_EXCHG` and `BILL`
 * are empty in all of them, and none contains a stock split. Reader edge cases
 * are therefore driven from plain objects, which is the layering the design
 * calls for -- only the decrypt and reader layers need real bytes.
 */

export interface FakeTableDefinition {
  readonly columns: readonly string[];
  readonly rows?: ReadonlyArray<Readonly<Record<string, MnyValue>>>;
}

function fakeTable(name: string, definition: FakeTableDefinition): MnyTable {
  const present = new Set(definition.columns);
  const rows = definition.rows ?? [];

  return {
    name,
    rowCount: rows.length,
    columnNames: definition.columns,
    hasColumn: (column) => present.has(column),
    rows: (requested) =>
      rows.map((row) => {
        const columns = (requested ?? definition.columns).filter((column) =>
          present.has(column),
        );
        return Object.fromEntries(
          columns.map((column) => [column, row[column] ?? null]),
        ) as MnyRow;
      }),
  };
}

/**
 * Builds a database whose tables are exactly the ones described. Any table not
 * listed reads as absent, which is how a Money 2001 file behaves for `BILL`.
 */
export function fakeMnyDatabase(
  tables: Readonly<Record<string, FakeTableDefinition>>,
  format: MnyFileFormat = "msisam",
): MnyDatabase {
  const names = Object.keys(tables);
  const built = new Map(
    names.map((name) => [name, fakeTable(name, tables[name])]),
  );

  return {
    format,
    scheme: "new-sha1",
    passwordProtected: false,
    tableNames: names,
    hasTable: (name) => built.has(name),
    getTableOrNull: (name) => built.get(name) ?? null,
  };
}
