import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DataSource } from "typeorm";
import { escapeRegExp } from "@/common/escape-regexp.util";

/**
 * The unique keys and CHECK constraints production has, carried into the
 * entity-built integration schema (A26-M42, A26-S05-01).
 *
 * `synchronize` builds tables from entity metadata, and an entity that omits a
 * key `schema.sql` declares leaves the harness without it: an `ON CONFLICT`
 * naming that key fails with 42P10 ("no unique or exclusion constraint matching
 * the ON CONFLICT specification"), so the production write path cannot run in
 * any suite, and a race test over the key passes against a database with
 * nothing to contend over. A missing CHECK lets a write production refuses pass
 * every suite and fail only in production.
 *
 * So the constraints are read from production's own definition, not restated:
 * `database/schema.sql` is applied once to a reference database (rebuilt only
 * when the file's hash changes), its catalog is read with PostgreSQL's own
 * deparser, and every unique key and CHECK the harness lacks is added after
 * `synchronize`. `schema-entity-parity.integration.spec.ts` holds the result:
 * the harness carries every one of them.
 */

const SCHEMA_SQL = path.join(__dirname, "../../../database/schema.sql");

export type ProductionConstraintKind =
  "unique-constraint" | "unique-index" | "check";

export interface ProductionConstraint {
  kind: ProductionConstraintKind;
  table: string;
  name: string;
  /**
   * What makes two constraints the same, whatever they are named: the table and
   * PostgreSQL's deparsed definition (`btree (budget_id, period_start)`,
   * `CHECK ((amount > (0)::numeric))`).
   */
  key: string;
  /** The statement that creates it on a database lacking it. */
  ddl: string;
}

/**
 * Bumped when the way the reference database is built changes, so a database
 * built the old way from the same schema.sql is rebuilt rather than reused.
 */
const REFERENCE_FORMAT = "2";

function schemaHash(): string {
  return createHash("sha256")
    .update(`format ${REFERENCE_FORMAT}\n`)
    .update(fs.readFileSync(SCHEMA_SQL))
    .digest("hex");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Connects to the reference database built from `schema.sql`, building it
 * first when it is absent or was built from a different `schema.sql`. Needs
 * CREATEDB, which the test owner has (the email-receipts schema suite relies on
 * the same). The caller destroys the returned connection.
 */
export async function connectSchemaReference(
  dataSource: DataSource,
): Promise<DataSource> {
  const [{ db }]: { db: string }[] = await dataSource.query(
    "SELECT current_database() AS db",
  );
  const name = `${db}_schema_ref`;
  const hash = schemaHash();

  const existing: { comment: string | null }[] = await dataSource.query(
    `SELECT shobj_description(oid, 'pg_database') AS comment
       FROM pg_database WHERE datname = $1`,
    [name],
  );
  const connect = async (): Promise<DataSource> => {
    const ref = new DataSource({
      ...dataSource.options,
      database: name,
      entities: [],
      synchronize: false,
      dropSchema: false,
    } as never);
    await ref.initialize();
    return ref;
  };

  if (existing.length === 1 && existing[0].comment === hash) {
    return connect();
  }

  await dataSource.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  await dataSource.query(`CREATE DATABASE ${quoteIdent(name)}`);
  const ref = await connect();
  try {
    await ref.query(fs.readFileSync(SCHEMA_SQL, "utf8"));
    await canonicalizeChecks(ref);
  } catch (err) {
    await ref.destroy();
    await dataSource.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    throw new Error(
      `Could not build the schema.sql reference database: ${(err as Error).message}`,
      { cause: err },
    );
  }
  // Written last: a build that failed half-way never looks current.
  await dataSource.query(
    `COMMENT ON DATABASE ${quoteIdent(name)} IS '${hash}'`,
  );
  return ref;
}

/**
 * Re-creates every CHECK from PostgreSQL's own deparse of it, so two databases
 * that hold one rule print it identically.
 *
 * The deparse of a CHECK is not a fixed point the first time: `kind IN ('a')`
 * on a varchar column prints as `ANY ((ARRAY['a'::character varying])::text[])`,
 * and that text, parsed again, prints with the cast folded into each element.
 * After one round trip it is stable, so both sides of a comparison take it --
 * the reference database once when it is built, the harness before it is
 * compared. Only for empty tables: a database being set up, never one in use.
 */
async function canonicalizeChecks(dataSource: DataSource): Promise<void> {
  const checks: { table: string; name: string; def: string }[] =
    await dataSource.query(`
      SELECT t.relname AS table, c.conname AS name, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND c.contype = 'c'`);
  for (const { table, name, def } of checks) {
    await dataSource.query(
      `ALTER TABLE ${quoteIdent(table)} DROP CONSTRAINT ${quoteIdent(name)}, ` +
        `ADD CONSTRAINT ${quoteIdent(name)} ${def}`,
    );
  }
}

/**
 * Every unique key (constraint or index, partial and expression ones included,
 * primary keys excluded) and every table CHECK in the `public` schema of a
 * database, deparsed by PostgreSQL so two spellings of one rule compare equal.
 */
export async function readConstraintCatalog(
  dataSource: DataSource,
): Promise<ProductionConstraint[]> {
  const uniques: {
    table: string;
    name: string;
    indexdef: string;
    method_and_columns: string;
    condef: string | null;
  }[] = await dataSource.query(`
    SELECT t.relname AS table,
           i.relname AS name,
           pg_get_indexdef(ix.indexrelid) AS indexdef,
           regexp_replace(pg_get_indexdef(ix.indexrelid), '^.* USING ', '') AS method_and_columns,
           CASE WHEN c.oid IS NULL THEN NULL ELSE pg_get_constraintdef(c.oid) END AS condef
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_constraint c
        ON c.conindid = ix.indexrelid AND c.contype = 'u'
     WHERE n.nspname = 'public'
       AND ix.indisunique
       AND NOT ix.indisprimary`);

  const checks: { table: string; name: string; def: string }[] =
    await dataSource.query(`
      SELECT t.relname AS table, c.conname AS name, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND c.contype = 'c'`);

  const catalog: ProductionConstraint[] = [];
  for (const u of uniques) {
    catalog.push({
      kind: u.condef ? "unique-constraint" : "unique-index",
      table: u.table,
      name: u.name,
      key: `${u.table}|UNIQUE ${u.method_and_columns}`,
      ddl: u.condef
        ? `ALTER TABLE ${quoteIdent(u.table)} ADD CONSTRAINT ${quoteIdent(u.name)} ${u.condef}`
        : u.indexdef,
    });
  }
  for (const c of checks) {
    catalog.push({
      kind: "check",
      table: c.table,
      name: c.name,
      key: `${c.table}|${c.def}`,
      ddl: `ALTER TABLE ${quoteIdent(c.table)} ADD CONSTRAINT ${quoteIdent(c.name)} ${c.def}`,
    });
  }
  return catalog.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * `table -> column -> type`, the type as a cast would spell it, for the
 * columns whose type is user-defined (an enum) in `dataSource` when
 * `userDefinedOnly`, or every column otherwise.
 */
async function columnTypes(
  dataSource: DataSource,
  userDefinedOnly: boolean,
): Promise<Map<string, Map<string, string>>> {
  const rows: {
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
  }[] = await dataSource.query(
    `SELECT table_name, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );
  const types = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (userDefinedOnly && r.data_type !== "USER-DEFINED") continue;
    const columns = types.get(r.table_name) ?? new Map<string, string>();
    columns.set(
      r.column_name,
      r.data_type === "USER-DEFINED" ? r.udt_name : r.data_type,
    );
    types.set(r.table_name, columns);
  }
  return types;
}

/**
 * The production unique keys and CHECKs, read from the reference database and
 * spelled for `target`.
 *
 * Production names its enum types once (`account_type`); `synchronize` makes
 * one per column (`accounts_account_type_enum`). A CHECK or a partial index
 * comparing a column with an enum literal deparses with production's type
 * name, which does not exist in the harness, so each such cast is rewritten to
 * the type the same column has in `target`. A CHECK is row-local, so the
 * table's own columns decide the mapping.
 */
export async function productionConstraintsFor(
  target: DataSource,
): Promise<ProductionConstraint[]> {
  const ref = await connectSchemaReference(target);
  let catalog: ProductionConstraint[];
  let refTypes: Map<string, Map<string, string>>;
  try {
    catalog = await readConstraintCatalog(ref);
    refTypes = await columnTypes(ref, true);
  } finally {
    await ref.destroy();
  }
  const targetTypes = await columnTypes(target, false);

  return catalog.map((constraint) => {
    const prod = refTypes.get(constraint.table);
    const here = targetTypes.get(constraint.table);
    if (!prod || !here) return constraint;
    let { key, ddl } = constraint;
    for (const [column, prodType] of prod) {
      const hereType = here.get(column);
      if (!hereType || hereType === prodType) continue;
      const cast = new RegExp(`::${escapeRegExp(prodType)}\\b`, "g");
      key = key.replace(cast, `::${hereType}`);
      ddl = ddl.replace(cast, `::${hereType}`);
    }
    return { ...constraint, key, ddl };
  });
}

/**
 * Adds to a `synchronize`-built database every production unique key and CHECK
 * it lacks, on the tables it has (schema.sql may legitimately be ahead of the
 * entities by a table). Matched by definition, not name, so a key an entity
 * already declares under TypeORM's generated name is not added twice. Throws,
 * naming the constraint, when one cannot be added: a harness quietly missing a
 * key is the defect this exists to remove.
 */
export async function applyProductionConstraints(
  dataSource: DataSource,
): Promise<void> {
  await canonicalizeChecks(dataSource);
  const wanted = await productionConstraintsFor(dataSource);
  const existing = await readConstraintCatalog(dataSource);
  const have = new Set(existing.map((c) => c.key));
  // A migration the harness replays for its policies or functions (179 for the
  // notifications policy) also creates the indexes it carried at the time. When
  // a later migration redefined one under the same name, the replayed shape is
  // stale: schema.sql's definition replaces it rather than colliding with it.
  const indexByName = new Map(
    existing
      .filter((c) => c.kind === "unique-index")
      .map((c) => [c.name, c] as const),
  );
  const tables = new Set<string>(
    (
      await dataSource.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).map((r: { table_name: string }) => r.table_name),
  );

  for (const constraint of wanted) {
    if (!tables.has(constraint.table) || have.has(constraint.key)) continue;
    try {
      const stale = indexByName.get(constraint.name);
      if (constraint.kind === "unique-index" && stale) {
        await dataSource.query(
          `DROP INDEX IF EXISTS ${quoteIdent(stale.name)}`,
        );
      }
      await dataSource.query(constraint.ddl);
    } catch (err) {
      throw new Error(
        `Could not add production ${constraint.kind} ${constraint.name} on ${constraint.table} ` +
          `to the integration schema (${constraint.ddl}): ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}
