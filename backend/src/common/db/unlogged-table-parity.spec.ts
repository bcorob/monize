/**
 * An `UNLOGGED` table is unlogged in every source that creates it.
 *
 * `UNLOGGED` is not a performance knob this repository can hold in one place
 * and forget: it decides whether the rows survive a crash and whether they
 * reach a streaming standby. `http_throttle_counters` is written on every
 * guarded request and is deliberately expendable
 * (`backend/src/common/throttler/postgres-throttler-storage.ts`), and the
 * migration and `database/schema.sql` each say so in their own `CREATE`.
 *
 * Nothing else can catch a disagreement. TypeORM's metadata cannot express
 * `UNLOGGED` at all, so the entity is silent and the integration harness --
 * which builds its database from that metadata -- gets a logged table either
 * way. The "Schema vs Migrations Drift" job replays the migrations on top of
 * `schema.sql`, where a `CREATE TABLE IF NOT EXISTS` finds the table already
 * present and skips; `pg_class.relpersistence` is not compared. So a fresh
 * install and an upgraded one could differ on durability with every gate
 * green, and the difference would surface as a table that unexpectedly
 * survived -- or unexpectedly did not -- a failover.
 *
 * The persistence is read out of both sources rather than listed here, so the
 * next unlogged table is covered the day it is written. Per
 * `docs/guard-tests.md`, a scan anchored on a shape passes vacuously once that
 * shape is edited away, so finding no unlogged table **throws**.
 */
import * as fs from "fs";
import * as path from "path";

import { compareMigrationFilenames } from "./migration-filename";

const MIGRATIONS_DIR = path.join(__dirname, "../../../../database/migrations");
const SCHEMA_SQL = path.join(__dirname, "../../../../database/schema.sql");

/**
 * Comments removed, line count preserved, so the prose above a `CREATE` cannot
 * satisfy the scan that reads it.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, "");
}

/** `CREATE [UNLOGGED] TABLE [IF NOT EXISTS] <name>`, capturing both parts. */
const CREATE_TABLE =
  /CREATE\s+(UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;

/** `ALTER TABLE <name> SET {LOGGED|UNLOGGED}`, which flips it after the fact. */
const ALTER_PERSISTENCE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+SET\s+(UNLOGGED|LOGGED)\b/gi;

/**
 * Table name to "is it unlogged", in statement order: a later `ALTER ... SET`
 * wins over the `CREATE`, the way the database applies them.
 *
 * `TEMP`/`TEMPORARY` tables are session-scoped scratch and are skipped: they
 * are neither logged nor a durability claim about a shipped table.
 */
export function parseTablePersistence(sql: string): Map<string, boolean> {
  const persistence = new Map<string, boolean>();
  const bare = stripSqlComments(sql);

  for (const match of bare.matchAll(CREATE_TABLE)) {
    const qualifier = (match[1] ?? "").trim().toUpperCase();
    if (qualifier === "TEMP" || qualifier === "TEMPORARY") continue;
    persistence.set(match[2].toLowerCase(), qualifier === "UNLOGGED");
  }
  for (const match of bare.matchAll(ALTER_PERSISTENCE)) {
    const table = match[1].toLowerCase();
    if (!persistence.has(table)) continue;
    persistence.set(table, match[2].toUpperCase() === "UNLOGGED");
  }

  return persistence;
}

/**
 * Every migration in apply order, so a later `ALTER ... SET LOGGED` is read
 * after the `CREATE` it overrides.
 *
 * Through `compareMigrationFilenames` rather than a bare `.sort()`: the two
 * prefix schemes do not agree under a string sort, and this file's whole
 * subject is what the database ends up with after the runner has applied them
 * in its order.
 */
function readMigrationsInOrder(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort(compareMigrationFilenames)
    .map((name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"))
    .join("\n");
}

describe("unlogged table parity", () => {
  const schemaPersistence = parseTablePersistence(
    fs.readFileSync(SCHEMA_SQL, "utf8"),
  );
  const migrationPersistence = parseTablePersistence(readMigrationsInOrder());

  it("finds unlogged tables to check, rather than passing on an empty set", () => {
    const unlogged = [...schemaPersistence]
      .filter(([, isUnlogged]) => isUnlogged)
      .map(([table]) => table);

    // The anchor. Without it, deleting the one UNLOGGED table -- or breaking
    // the regex on a reformat -- would leave every assertion below iterating
    // nothing and reporting green.
    expect(unlogged).toContain("http_throttle_counters");
  });

  it("declares the same persistence in database/schema.sql and in the migrations", () => {
    const disagreements = [...schemaPersistence]
      .filter(
        ([table, isUnlogged]) =>
          migrationPersistence.has(table) &&
          migrationPersistence.get(table) !== isUnlogged,
      )
      .map(
        ([table, isUnlogged]) =>
          `${table}: schema.sql says ${isUnlogged ? "UNLOGGED" : "LOGGED"}, ` +
          `the migrations say ${migrationPersistence.get(table) ? "UNLOGGED" : "LOGGED"}`,
      );

    // A fresh install applies schema.sql and an upgrade applies the migration;
    // the two must not produce tables that differ on crash survival.
    expect(disagreements).toEqual([]);
  });
});
