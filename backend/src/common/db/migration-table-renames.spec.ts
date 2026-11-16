/**
 * A renamed table is a name three other things still spell out.
 *
 * `budget_alerts` became `notifications` in migration 179, and the rename is the
 * first one this repository has done. Three places went on naming the old table
 * and only one of them fails loudly:
 *
 *   * **The migrations before it.** Every migration is replayed on top of
 *     `schema.sql` by the "Schema vs Migrations Drift" job, so a statement naming
 *     a table the schema no longer has aborts the whole replay -- and, because
 *     `db-migrate` runs the same directory at container start, aborts the boot of
 *     any deployment whose `schema_migrations` does not already list the file.
 *     The fix is a `to_regclass` guard inside a `DO` block: PL/pgSQL plans a
 *     statement only when it is reached, so a branch that is skipped is never
 *     parsed, while a database old enough to need the migration still runs it.
 *   * **`schema.sql`.** It has to describe the table under its current name, or
 *     a fresh install and an upgraded one disagree.
 *   * **Existing backup artifacts**, which key their tables by SQL table name and
 *     were written before the rename. That one is silent: the restore is handed
 *     `undefined` for the new key, inserts nothing and reports zero. Hence
 *     `LEGACY_TABLE_KEYS`.
 *
 * The renames themselves are read out of the migrations rather than listed here,
 * so the next one is covered without being registered.
 */
import * as fs from "fs";
import * as path from "path";

import { LEGACY_TABLE_KEYS } from "../../backup/backup-format";
import { RESTORABLE_TABLES } from "../../backup/restore-plan";
import { compareMigrationFilenames } from "./migration-filename";

const MIGRATIONS_DIR = path.join(__dirname, "../../../../database/migrations");
const SCHEMA_SQL = path.join(__dirname, "../../../../database/schema.sql");

/**
 * Comments removed, line count preserved, so an offender report still points at
 * the right line -- and so the prose explaining a guard cannot satisfy the scan
 * that checks for it.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, "");
}

interface TableRename {
  from: string;
  to: string;
  /** Migration filename that performs the rename. */
  file: string;
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(compareMigrationFilenames);
}

function readMigration(file: string): string {
  return stripSqlComments(
    fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"),
  );
}

function tableRenames(): TableRename[] {
  const renames: TableRename[] = [];
  for (const file of migrationFiles()) {
    const sql = readMigration(file);
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)\s+RENAME\s+TO\s+(\w+)/gi,
    )) {
      renames.push({ from: m[1], to: m[2], file });
    }
  }
  return renames;
}

function mentions(sql: string, table: string): boolean {
  return new RegExp(`\\b${table}\\b`).test(sql);
}

/**
 * Whether a migration only touches `table` behind a check that it still exists.
 *
 * Two shapes, because the migrations have two. A file that names the table
 * outright guards on that literal name. A file that drives DDL from a list of
 * table names -- `112_rls_policies_direct.sql` loops one over `format()` -- has
 * no literal to guard, so it tests the name it is holding; the loop skips a
 * table that has been renamed out from under it and the replay survives.
 */
function guardsExistence(sql: string, table: string): boolean {
  return (
    sql.includes(`to_regclass('public.${table}')`) ||
    sql.includes(`to_regclass('${table}')`) ||
    /to_regclass\(\s*'public\.'\s*\|\|/.test(sql)
  );
}

describe("a renamed table leaves nothing spelling out the old name", () => {
  const renames = tableRenames();

  it("finds the renames it is meant to check", () => {
    // A rename this suite cannot see is a rename it cannot guard, and the whole
    // file would pass vacuously the day the regex stops matching.
    expect(renames.map((r) => `${r.from} -> ${r.to}`)).toContain(
      "budget_alerts -> notifications",
    );
  });

  it.each(renames)(
    "$file: every earlier migration naming $from guards on its existence",
    ({ from, file }) => {
      const offenders = migrationFiles()
        .filter((f) => f !== file)
        .filter((f) => mentions(readMigration(f), from))
        .filter((f) => !guardsExistence(readMigration(f), from));

      expect(offenders).toEqual([]);
    },
  );

  it.each(renames)(
    "$file: schema.sql describes $to and no longer creates $from",
    ({ from, to }) => {
      const schema = stripSqlComments(fs.readFileSync(SCHEMA_SQL, "utf8"));
      expect(schema).toMatch(new RegExp(`CREATE TABLE\\s+${to}\\b`));
      expect(schema).not.toMatch(new RegExp(`CREATE TABLE\\s+${from}\\b`));
    },
  );

  it.each(renames.filter((r) => RESTORABLE_TABLES.has(r.to)))(
    "$file: a backup written before the rename still restores $to",
    ({ from, to }) => {
      // Without the alias the restore reads `undefined` for the new key,
      // inserts nothing and reports zero -- data loss that looks like success.
      expect(LEGACY_TABLE_KEYS[to] ?? []).toContain(from);
    },
  );

  it("no legacy alias shadows a table that still exists", () => {
    const schema = stripSqlComments(fs.readFileSync(SCHEMA_SQL, "utf8"));
    for (const [current, legacyNames] of Object.entries(LEGACY_TABLE_KEYS)) {
      expect(RESTORABLE_TABLES.has(current)).toBe(true);
      for (const legacy of legacyNames) {
        expect(schema).not.toMatch(new RegExp(`CREATE TABLE\\s+${legacy}\\b`));
      }
    }
  });
});
