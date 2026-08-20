import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

import {
  ColumnClaim,
  columnProblem,
  extractStringLiterals,
  parseSchemaColumns,
  splitTopLevel,
  statementClaims,
  stripOutputLabel,
} from "./raw-sql-columns";

/**
 * Every column named by raw SQL in `src/` exists in `database/schema.sql`.
 *
 * The regression: `AutoBackupService.claimDueBackup` ended its claim with
 * `RETURNING id`, and `auto_backup_settings` has no `id` -- `user_id` is its
 * primary key. Its unit tests asserted the string (`expect(sql).toContain(
 * "RETURNING id")`) against a mocked `manager.query`, so the mistake was not
 * merely uncaught, it was pinned in place. In production every hourly sweep
 * threw `column "id" does not exist` (42703) out of the claim, which sits
 * before the per-user `try`, so no user's backup ran and none was recorded as
 * failed either.
 *
 * A mocked query cannot demonstrate a property of the schema, the same way a
 * mocked filesystem cannot demonstrate a property of a directory
 * (`backend/CLAUDE.md`). This scan can: it reads the schema and the source, and
 * needs no database.
 *
 * It is deliberately a scan rather than a case for that one query -- the class
 * is "a hand-written column name in a hand-written statement", and there are
 * ~50 such statements across imports, sweepers, job claims and seeders. The
 * grammar lives in `raw-sql-columns.ts` and is unit-tested below, so widening
 * it is a reviewed change rather than a silent one.
 */
const SRC = join(__dirname, "..", "..");
const SCHEMA_PATH = join(SRC, "..", "..", "database", "schema.sql");

function sourceFiles(): string[] {
  return globSync("**/*.ts", {
    cwd: SRC,
    absolute: true,
    ignore: ["**/*.spec.ts", "**/*.d.ts", "**/node_modules/**"],
  });
}

const relative = (file: string): string =>
  file.slice(SRC.length + 1).replace(/\\/g, "/");

type FoundClaim = ColumnClaim & { file: string };

function scanTree(): FoundClaim[] {
  const found: FoundClaim[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    // Cheap pre-filter: only files that write SQL can make a claim.
    if (!/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s/i.test(source)) continue;
    for (const literal of extractStringLiterals(source)) {
      for (const statement of statementClaims(literal)) {
        for (const claim of statement.claims) {
          found.push({ file: relative(file), ...claim });
        }
      }
    }
  }
  return found;
}

describe("raw SQL column names", () => {
  const schema = parseSchemaColumns(readFileSync(SCHEMA_PATH, "utf8"));
  const claims = scanTree();

  describe("the scan sees what it claims to see", () => {
    // Anti-vacuity. A grammar that quietly matched nothing would make the
    // assertion below trivially green -- which is exactly how the original
    // mistake survived its own test.
    it("parses the schema into tables and columns", () => {
      expect(schema.size).toBeGreaterThan(50);
      expect([...(schema.get("auto_backup_settings") ?? [])]).toEqual(
        expect.arrayContaining(["user_id", "enabled", "next_backup_at"]),
      );
      // The table the regression was on genuinely has no `id`.
      expect(schema.get("auto_backup_settings")?.has("id")).toBe(false);
      expect(schema.get("transactions")?.has("id")).toBe(true);
    });

    it("finds the statements the tree is known to contain", () => {
      expect(claims.length).toBeGreaterThan(100);
      const files = new Set(claims.map((claim) => claim.file));
      // One of each shape the scanner is meant to reach: a cron claim, a job
      // lease, a sweeper, and a seeder's INSERT column lists.
      expect(files).toContain("backup/auto-backup.service.ts");
      expect(files).toContain("common/jobs/job-claim.service.ts");
      expect(files).toContain(
        "attachments/attachment-orphan-sweeper.service.ts",
      );
      expect(files).toContain("database/demo-seed.service.ts");
    });

    it("reads the auto-backup claim's RETURNING column", () => {
      // The exact claim the outage was in, checked as a claim rather than as a
      // substring of the SQL.
      expect(claims).toContainEqual({
        file: "backup/auto-backup.service.ts",
        table: "auto_backup_settings",
        column: "user_id",
        clause: "RETURNING",
      });
    });
  });

  it("names only columns that exist in database/schema.sql", () => {
    const problems = claims
      .map((claim) => {
        const problem = columnProblem(claim, schema);
        return problem ? `${claim.file}: ${problem}` : null;
      })
      .filter((problem): problem is string => problem !== null);
    expect(problems).toEqual([]);
  });
});

describe("raw SQL column grammar", () => {
  const schema = parseSchemaColumns(
    `CREATE TABLE auto_backup_settings (
       user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       enabled BOOLEAN NOT NULL DEFAULT false,
       next_backup_at TIMESTAMP,
       CONSTRAINT abs_check CHECK (enabled IS NOT NULL)
     );
     CREATE TABLE IF NOT EXISTS users (
       id UUID PRIMARY KEY,
       failed_login_attempts INT NOT NULL DEFAULT 0,
       locked_until TIMESTAMP
     );`,
  );

  const problemsIn = (sql: string): string[] =>
    statementClaims(sql).flatMap((statement) =>
      statement.claims
        .map((claim) => columnProblem(claim, schema))
        .filter((problem): problem is string => problem !== null),
    );

  it("parses columns and skips table constraints", () => {
    expect([...(schema.get("auto_backup_settings") ?? [])]).toEqual([
      "user_id",
      "enabled",
      "next_backup_at",
    ]);
    // `REFERENCES users(id)` is inside the column entry, not a column of its
    // own -- a paren-blind comma split would have invented `id` here, and this
    // whole guard would then have passed the regression.
    expect(schema.get("auto_backup_settings")?.has("id")).toBe(false);
  });

  it("fails the exact statement that broke automatic backups", () => {
    expect(
      problemsIn(
        `UPDATE auto_backup_settings
            SET next_backup_at = $1
          WHERE user_id = $2 AND enabled = true
          RETURNING id`,
      ),
    ).toEqual([
      expect.stringContaining("RETURNING id on auto_backup_settings"),
    ]);
  });

  it("passes the fixed statement", () => {
    expect(
      problemsIn(
        `UPDATE auto_backup_settings
            SET next_backup_at = $1
          WHERE user_id = $2
          RETURNING user_id`,
      ),
    ).toEqual([]);
  });

  it("checks SET targets and INSERT column lists too", () => {
    expect(
      problemsIn("UPDATE auto_backup_settings SET last_backup_at = $1"),
    ).toEqual([expect.stringContaining("SET last_backup_at")]);
    expect(
      problemsIn("INSERT INTO users (id, nickname) VALUES ($1, $2)"),
    ).toEqual([expect.stringContaining("INSERT nickname")]);
    expect(
      problemsIn("INSERT INTO users (id, locked_until) VALUES ($1, $2)"),
    ).toEqual([]);
  });

  it("does not read the table's own alias as a foreign qualifier", () => {
    expect(
      problemsIn(
        `UPDATE users u SET locked_until = NULL
          WHERE u.id = $1
          RETURNING u.failed_login_attempts AS attempts, u.nickname AS nick`,
      ),
    ).toEqual([expect.stringContaining("RETURNING nickname")]);
  });

  it("does not read SET as an alias", () => {
    // `UPDATE t SET x` would otherwise alias the table `set`, and every
    // qualified column would then be skipped as another relation's.
    expect(
      problemsIn("UPDATE auto_backup_settings SET enabled = true RETURNING id"),
    ).toHaveLength(1);
  });

  it("makes no claim it cannot resolve", () => {
    // A CTE or joined qualifier, an expression, a star, and an interpolated
    // fragment each yield nothing rather than a guess: a guard with false
    // positives gets disabled, and then it guards nothing.
    expect(
      problemsIn(
        `WITH prev AS (SELECT id, locked_until FROM users)
         UPDATE users u SET locked_until = NULL FROM prev
          WHERE u.id = prev.id
          RETURNING prev.locked_until AS old_locked_until,
                    COUNT(*) AS total, *`,
      ),
    ).toEqual([]);
    expect(problemsIn("UPDATE users SET  interp  = $1 RETURNING id")).toEqual(
      [],
    );
  });

  it("attributes each statement's columns to its own table", () => {
    // One string, two statements: the second's RETURNING must not be checked
    // against the first's table.
    expect(
      problemsIn(
        `INSERT INTO users (id) VALUES ($1) RETURNING id;
         UPDATE auto_backup_settings SET enabled = true RETURNING user_id`,
      ),
    ).toEqual([]);
  });

  it("says nothing about a table the schema does not define", () => {
    // A temporary table, a `pg_catalog` relation or a CTE target is not a claim
    // about the application schema; the table inventory is guarded elsewhere.
    expect(problemsIn("UPDATE pg_temp_scratch SET whatever = 1")).toEqual([]);
  });

  describe("literal extraction", () => {
    it("reads template, single- and double-quoted SQL", () => {
      const source = [
        "const a = `UPDATE users SET locked_until = NULL`;",
        `const b = 'DELETE FROM users';`,
        `const c = "INSERT INTO users (id) VALUES ($1)";`,
      ].join("\n");
      expect(extractStringLiterals(source)).toEqual([
        "UPDATE users SET locked_until = NULL",
        "DELETE FROM users",
        "INSERT INTO users (id) VALUES ($1)",
      ]);
    });

    it("skips comments, so SQL quoted in a doc comment is not scanned", () => {
      const source = [
        "// UPDATE users SET nope = 1",
        "/* RETURNING nope */",
        "const a = `UPDATE users SET locked_until = NULL`;",
      ].join("\n");
      expect(extractStringLiterals(source)).toEqual([
        "UPDATE users SET locked_until = NULL",
      ]);
    });

    it("replaces an interpolation rather than splicing its code in", () => {
      const source =
        "const a = `UPDATE users SET locked_until = NULL ${cond ? `AND x` : ''} RETURNING id`;";
      const [literal] = extractStringLiterals(source);
      expect(literal).toContain("interp");
      expect(literal).not.toContain("cond");
      expect(literal).toContain("RETURNING id");
    });
  });

  describe("clause splitting", () => {
    it("splits on top-level commas only", () => {
      expect(splitTopLevel("a, b, coalesce(c, d) AS e")).toEqual([
        "a",
        "b",
        "coalesce(c, d) AS e",
      ]);
    });

    it("strips an output label without eating a qualifier", () => {
      expect(stripOutputLabel("u.failed_login_attempts AS attempts")).toBe(
        "u.failed_login_attempts",
      );
      expect(stripOutputLabel("u.locked_until")).toBe("u.locked_until");
      expect(stripOutputLabel("data_committed")).toBe("data_committed");
    });
  });
});
