import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * A singleton table's entity declares the constraint that makes it a singleton.
 *
 * Three tables in `database/schema.sql` are one row by construction --
 * `push_instance_config`, `oauth_instance_config`, `update_check_state` -- and
 * each spells it the same way:
 *
 * ```sql
 * id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id)
 * ```
 *
 * The primary key alone does not make it one row. It admits TRUE **and** FALSE;
 * `CHECK (id)` is what refuses the second. Every writer today inserts a
 * hardcoded `TRUE`, so the key happens to be enough -- which is exactly why a
 * missing CHECK would go unnoticed until something inserted the other value.
 *
 * The integration harness builds its database from entity metadata
 * (`synchronize: true`) while production applies `schema.sql`, so a constraint
 * that only `schema.sql` carries is one no integration spec can observe. The
 * race specs that prove "two replicas racing on first start mint one JWKS" and
 * "two replicas ticking together make one GitHub request" would then be
 * contending over a weaker schema than the one they are evidence about --
 * the same class of hole `schema-entity-parity.integration.spec.ts` records for
 * foreign-key delete rules.
 *
 * This guard needs no database. It reads the singleton declarations out of
 * `schema.sql` and checks that each one's entity carries `@Check`. It is
 * deliberately narrow: full CHECK-constraint parity across all 90 constraints
 * in the schema is a separate, baselined change of the kind that spec made for
 * its 55 foreign keys.
 *
 * Per `docs/backend/backup.md`: a scan that names a shape is disarmed silently
 * when that shape is edited away, so finding none **throws** rather than
 * passing vacuously.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = join(REPO_ROOT, "database", "schema.sql");
const ENTITY_ROOT = join(REPO_ROOT, "backend", "src");

/**
 * `CREATE TABLE <name> (... id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id) ...`
 *
 * Anchored on the column rather than on a table-name list, so a fourth
 * singleton is covered the day it is written and nobody has to remember this
 * file.
 */
const SINGLETON_TABLE =
  /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*) \([^;]*?\bid BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK \(id\)/gi;

/** Tables `database/schema.sql` declares as one-row-by-construction. */
export function parseSingletonTables(sql: string): string[] {
  const names = [...sql.matchAll(SINGLETON_TABLE)].map((match) =>
    match[1].toLowerCase(),
  );
  if (names.length === 0) {
    throw new Error(
      "No `id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id)` columns found in " +
        "database/schema.sql. The singleton shape was rewritten, so this guard " +
        "is checking nothing; update the pattern or delete the guard.",
    );
  }
  return [...new Set(names)].sort();
}

/** Every `*.entity.ts` under `backend/src`, found on disk so an unstaged one counts. */
function entityFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...entityFiles(path));
    } else if (name.endsWith(".entity.ts")) {
      found.push(path);
    }
  }
  return found;
}

/** Entity source keyed by the table name its `@Entity(...)` names. */
function entitySourcesByTable(): Map<string, { path: string; src: string }> {
  const byTable = new Map<string, { path: string; src: string }>();
  for (const path of entityFiles(ENTITY_ROOT)) {
    const src = readFileSync(path, "utf8");
    const table = /@Entity\(\s*["']([a-z_][a-z0-9_]*)["']/i.exec(src)?.[1];
    if (table) byTable.set(table.toLowerCase(), { path, src });
  }
  return byTable;
}

describe("singleton tables declare their CHECK on the entity", () => {
  const singletons = parseSingletonTables(readFileSync(SCHEMA_PATH, "utf8"));
  const entities = entitySourcesByTable();

  it("finds the singleton declarations in schema.sql", () => {
    // Names the four that exist today, so deleting one is a decision somebody
    // makes rather than a guard quietly covering less.
    expect(singletons).toEqual([
      "auto_backup_policy",
      "oauth_instance_config",
      "push_instance_config",
      "update_check_state",
    ]);
  });

  it.each(singletons)("%s has an entity", (table) => {
    expect(entities.get(table)).toBeDefined();
  });

  it.each(singletons)("%s's entity carries @Check", (table) => {
    const entity = entities.get(table);
    if (!entity) throw new Error(`No entity maps to ${table}`);
    expect(entity.src).toMatch(/@Check\(\s*["']id["']\s*\)/);
  });
});
