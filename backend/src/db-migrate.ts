import { Logger } from "@nestjs/common";
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import { applyAppRoleGrants } from "./common/db/app-role";
import { acquireDbLifecycleLock } from "./common/db/advisory-locks";
import { orderMigrations } from "./common/db/migration-filename";
import {
  formatMissingDbFunctions,
  missingDbFunctions,
} from "./common/db/required-db-functions";

const MIGRATIONS_DIRNAME = "migrations";

/**
 * The migration runner is its own process, but its output shares the container
 * log with the Nest app, so it logs through the Nest `Logger` (usable outside
 * an application context) instead of `console`.
 */
const logger = new Logger("DbMigrate");

/** Where a human goes when a migration fails at startup. */
const RUNBOOK = "docs/database-migrations.md";

/**
 * SQLSTATE codes worth naming in the failure report. The "already exists" and
 * "does not exist" families are the ones a non-idempotent migration produces
 * when its body re-runs after a partial apply (the `056` crash-loop in PR #192),
 * so they get an extra pointer to the idempotency lint.
 */
const SQLSTATE_NAMES: Record<string, string> = {
  "22P02": "invalid_text_representation",
  "23502": "not_null_violation",
  "23503": "foreign_key_violation",
  "23505": "unique_violation",
  "23514": "check_violation",
  "25P02": "in_failed_sql_transaction",
  "40001": "serialization_failure",
  "42501": "insufficient_privilege",
  "42601": "syntax_error",
  "42701": "duplicate_column",
  "42703": "undefined_column",
  "42704": "undefined_object",
  "42710": "duplicate_object",
  "42723": "duplicate_function",
  "42883": "undefined_function",
  "42P01": "undefined_table",
  "42P06": "duplicate_schema",
  "42P07": "duplicate_table",
  "42P16": "invalid_table_definition",
  "55P03": "lock_not_available",
  "57014": "query_canceled",
};

/**
 * "Already exists" SQLSTATEs. These mean the statement re-ran after taking
 * effect, so the fix is a guard on the statement -- not a database edit.
 */
const DUPLICATE_SQLSTATES = new Set([
  "42701",
  "42710",
  "42723",
  "42P06",
  "42P07",
]);

/**
 * "Does not exist" SQLSTATEs. Either a DROP that needs `IF EXISTS`, or the
 * migration ran ahead of whatever creates the object (a fresh database that
 * never got `schema.sql`, or a filename that sorts before its prerequisite).
 */
const MISSING_OBJECT_SQLSTATES = new Set(["42P01", "42703", "42704", "42883"]);

/** The subset of `pg`'s DatabaseError fields the failure report surfaces. */
interface SqlErrorFields {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  where?: string;
  position?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

/**
 * Read the diagnostic fields off an unknown thrown value. `pg` attaches them to
 * its `DatabaseError`, but the runner also has to survive a plain `Error` (or a
 * thrown string) without losing the message.
 */
export function describeSqlError(error: unknown): SqlErrorFields {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }
  const e = error as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  return {
    message: str(e.message) ?? String(error),
    code: str(e.code),
    detail: str(e.detail),
    hint: str(e.hint),
    where: str(e.where),
    position: str(e.position),
    schema: str(e.schema),
    table: str(e.table),
    column: str(e.column),
    constraint: str(e.constraint),
  };
}

/**
 * Turn a `pg` error `position` (1-based character offset into the SQL the
 * runner sent) into the migration's own line and column plus the offending
 * source line with a caret under it. Returns null when there is no usable
 * position -- most DDL errors ("trigger already exists") carry none.
 */
export function locateSqlPosition(
  sql: string,
  position?: string,
): { line: number; column: number; excerpt: string } | null {
  if (!position) return null;
  const offset = Number(position);
  if (!Number.isInteger(offset) || offset < 1 || offset > sql.length + 1) {
    return null;
  }
  const before = sql.slice(0, offset - 1);
  const lines = before.split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  const sourceLine = sql.split("\n")[line - 1] ?? "";
  const gutter = `${line}`;
  const excerpt = [
    `  ${gutter} | ${sourceLine}`,
    `  ${" ".repeat(gutter.length)} | ${" ".repeat(Math.max(column - 1, 0))}^`,
  ].join("\n");
  return { line, column, excerpt };
}

/**
 * The block printed before the runner exits non-zero. Names the failing file,
 * every SQL diagnostic Postgres supplied, where in the file it happened, what
 * state the database is in, and where the recovery runbook lives -- the PR #192
 * thread lost an afternoon to a failure that reported only `[object Object]`.
 */
export function formatMigrationFailure(params: {
  file: string;
  filePath: string;
  sql: string;
  error: unknown;
  appliedBefore: number;
}): string {
  const { file, filePath, sql, error, appliedBefore } = params;
  const fields = describeSqlError(error);
  const rule = "-".repeat(72);
  const lines: string[] = [
    rule,
    `Migration failed: ${file}`,
    `  file:      ${filePath}`,
  ];

  lines.push(`  error:     ${fields.message}`);
  if (fields.code) {
    const name = SQLSTATE_NAMES[fields.code];
    lines.push(`  sqlstate:  ${fields.code}${name ? ` (${name})` : ""}`);
  }
  for (const [label, value] of [
    ["detail", fields.detail],
    ["hint", fields.hint],
    ["where", fields.where],
    ["schema", fields.schema],
    ["table", fields.table],
    ["column", fields.column],
    ["constraint", fields.constraint],
  ] as const) {
    if (value) lines.push(`  ${label.padEnd(10)} ${value}`);
  }

  const located = locateSqlPosition(sql, fields.position);
  if (located) {
    lines.push(
      `  at:        line ${located.line}, column ${located.column} (position ${fields.position})`,
      "",
      located.excerpt,
    );
  }

  lines.push(
    "",
    appliedBefore > 0
      ? `${appliedBefore} migration(s) applied successfully before this one; each was committed separately.`
      : "No migrations were applied in this run.",
    `This migration was rolled back in full -- schema_migrations does not list ${file}, so`,
    "the next startup retries it. Startup aborts deliberately (fail fast): a partially",
    "migrated database is never served.",
    "",
    "Next steps:",
  );

  if (fields.code && DUPLICATE_SQLSTATES.has(fields.code)) {
    lines.push(
      `  1. "Already exists" means ${file} is not re-runnable: it half-applied earlier, or`,
      "     its content changed after it was applied. Guard the offending statement",
      "     (IF NOT EXISTS, a preceding DROP ... IF EXISTS, or a catalog-checking DO block)",
      "     and verify with:",
      "       cd backend && npm run migration:lint",
      `  2. Recovery runbook (includes the partially-applied case): ${RUNBOOK}`,
    );
  } else if (fields.code && MISSING_OBJECT_SQLSTATES.has(fields.code)) {
    lines.push(
      '  1. "Does not exist" means either a DROP that needs IF EXISTS, or this migration ran',
      "     ahead of whatever creates the object -- a database that never had schema.sql",
      "     applied, or a filename that sorts before its prerequisite. Check the object named",
      "     above against database/schema.sql.",
      `  2. Recovery runbook: ${RUNBOOK}`,
    );
  } else {
    lines.push(
      `  1. Fix the SQL in ${file} (the error above names the statement).`,
      `  2. Recovery runbook: ${RUNBOOK}`,
    );
  }

  lines.push(rule);
  return lines.join("\n");
}

/** The block printed when the runner fails outside a specific migration. */
export function formatRunnerFailure(error: unknown): string {
  const fields = describeSqlError(error);
  const rule = "-".repeat(72);
  const lines = [
    rule,
    "Migration runner failed before or between migrations.",
    `  error:     ${fields.message}`,
  ];
  if (fields.code) {
    const name = SQLSTATE_NAMES[fields.code];
    lines.push(`  sqlstate:  ${fields.code}${name ? ` (${name})` : ""}`);
  }
  if (fields.detail) lines.push(`  detail:    ${fields.detail}`);
  if (fields.hint) lines.push(`  hint:      ${fields.hint}`);
  lines.push(
    "",
    "Nothing was migrated. Common causes: the database is unreachable, DATABASE_*",
    "credentials are wrong, or the role lacks rights on schema_migrations.",
    `Runbook: ${RUNBOOK}`,
    rule,
  );
  return lines.join("\n");
}

/**
 * Resolve a path and verify it stays within the given base directory.
 * Returns the resolved path or null if validation fails.
 */
function safePath(base: string, relative: string): string | null {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, relative);
  if (
    !resolved.startsWith(resolvedBase + path.sep) &&
    resolved !== resolvedBase
  ) {
    return null;
  }
  return resolved;
}

export async function runMigrations() {
  logger.log("Running database migrations");

  const client = new Client({
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432", 10),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });

  // Surface Postgres NOTICE/WARNING messages, exactly as db-init does. The
  // grants convergence below reports its failures this way (the DO block
  // degrades insufficient_privilege to RAISE WARNING), so without this handler
  // the one path meant to make grants converge would fail with zero log output.
  client.on("notice", (msg) => {
    if (msg?.message) {
      logger.warn(`Postgres: ${msg.message}`);
    }
  });

  try {
    await client.connect();

    // The same lock db-init takes, for the same reason and against the same
    // races: two migrators both reading the pending set before either commits,
    // and an initializer applying schema.sql while a migrator replays migrations
    // on top of it. The applied-filename read below therefore happens after any
    // other process has finished, so a follower simply finds nothing pending.
    await acquireDbLifecycleLock(client);

    // Find migrations directory
    // All base directories are trusted (derived from __dirname or cwd)
    const baseDirs = [
      path.resolve(__dirname, ".."), // /app (Docker)
      path.resolve(__dirname, "..", "..", "database"), // Development
      path.resolve(process.cwd()), // Current directory
      path.resolve(process.cwd(), "..", "database"), // Parent/database
    ];

    let migrationsDir: string | null = null;
    for (const base of baseDirs) {
      const candidate = safePath(base, MIGRATIONS_DIRNAME);
      if (
        candidate &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isDirectory()
      ) {
        migrationsDir = candidate;
        break;
      }
    }

    if (!migrationsDir) {
      logger.log("No migrations directory found; skipping migrations");
      return;
    }

    // Ensure schema_migrations table exists (bootstrap)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Get list of already-applied migrations
    const applied = await client.query(
      "SELECT filename FROM schema_migrations",
    );
    const appliedSet = new Set(applied.rows.map((r) => r.filename));

    // Every .sql migration file, in apply order: numeric prefix, then full
    // filename (migration-filename.ts). Not a string sort -- one agrees with
    // this order today only because every historical prefix begins with 0 or
    // 1 and every timestamp with 2 (issue #1277). A filename carrying neither
    // prefix form throws here and fails the run below.
    const files = orderMigrations(
      fs
        .readdirSync(migrationsDir)
        .filter(
          (f) =>
            f.endsWith(".sql") && !f.includes(path.sep) && !f.includes("/"),
        ),
    );

    // Run pending migrations in order
    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const filePath = safePath(migrationsDir, file);
      if (!filePath) {
        logger.error(`Skipping invalid migration filename: ${file}`);
        continue;
      }
      const sql = fs.readFileSync(filePath, "utf8");

      logger.log(`Applying migration: ${file}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error(
          formatMigrationFailure({
            file,
            filePath,
            sql,
            error: err,
            appliedBefore: count,
          }),
        );
        process.exit(1);
      }
    }

    if (count > 0) {
      logger.log(`Applied ${count} migration(s) successfully`);
    } else {
      logger.log("Database is up to date; no pending migrations");
    }

    // Converge the runtime role's grants now that this boot's DDL has run. On a
    // first boot this is the pass that takes effect: db-init's grants ran
    // before schema.sql created schema_migrations, so the write-revoke on the
    // ledger was skipped and the default privileges handed the runtime role
    // INSERT/UPDATE/DELETE on it -- this call takes those writes back (see
    // applyAppRoleGrants). Unconditional: cheap, idempotent, and running it
    // only when `count > 0` would miss a database repaired by hand.
    await applyAppRoleGrants(client, {
      appUser: process.env.DATABASE_APP_USER,
    });

    // Then prove the run achieved what the code needs. "Every pending migration
    // applied" and "the schema this build calls is present" are different
    // claims: a ledger row for a migration whose object was later dropped, a
    // database restored under an image newer than it, or a filename that never
    // reached this directory all satisfy the first and not the second. Reporting
    // it here names the migration while the operator is still reading migration
    // output, rather than leaving main.ts to refuse a boot ten lines later.
    const missing = await missingDbFunctions(client);
    if (missing.length > 0) {
      logger.error(formatMissingDbFunctions(missing));
      process.exit(1);
    }
  } catch (error) {
    logger.error(formatRunnerFailure(error));
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations();
}
