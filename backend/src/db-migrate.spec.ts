import fs from "fs";
import { Logger } from "@nestjs/common";

// Mock pg Client
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();
const mockOn = jest.fn();

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
    on: mockOn,
  })),
}));

// Mock process.exit to prevent test runner from dying
const mockExit = jest
  .spyOn(process, "exit")
  .mockImplementation((() => {}) as any);

import {
  runMigrations,
  describeSqlError,
  locateSqlPosition,
  formatMigrationFailure,
  formatRunnerFailure,
} from "./db-migrate";

/** A stand-in for pg's DatabaseError, which carries diagnostics as own props. */
function pgError(message: string, fields: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), fields);
}

describe("db-migrate runMigrations()", () => {
  let existsSyncSpy: jest.SpyInstance;
  let statSyncSpy: jest.SpyInstance;
  let readdirSyncSpy: jest.SpyInstance;
  let readFileSyncSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);

    // The runner logs through the Nest Logger so its output matches the rest
    // of the boot sequence; spying on console here would catch nothing.
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();

    // Default: no migrations directory found
    existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
    statSyncSpy = jest
      .spyOn(fs, "statSync")
      .mockReturnValue({ isDirectory: () => true } as any);
    readdirSyncSpy = jest.spyOn(fs, "readdirSync").mockReturnValue([] as any);
    readFileSyncSpy = jest.spyOn(fs, "readFileSync").mockReturnValue("");
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("skips when no migrations directory is found", async () => {
    existsSyncSpy.mockReturnValue(false);

    await runMigrations();

    expect(logSpy).toHaveBeenCalledWith(
      "No migrations directory found; skipping migrations",
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS"),
    );
  });

  it("creates schema_migrations table on startup", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([]);
    mockQuery
      // The database-lifecycle advisory lock (lock_timeout, acquire, reset),
      // taken first so only one process initializes or migrates at a time.
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }); // SELECT applied

    await runMigrations();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations"),
    );
  });

  it("skips already-applied migrations", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "002_add_users.sql",
    ] as any);
    mockQuery
      // The database-lifecycle advisory lock (lock_timeout, acquire, reset),
      // taken first so only one process initializes or migrates at a time.
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({
        rows: [{ filename: "001_init.sql" }, { filename: "002_add_users.sql" }],
      }); // SELECT applied

    await runMigrations();

    expect(logSpy).toHaveBeenCalledWith(
      "Database is up to date; no pending migrations",
    );
    // Should NOT have called BEGIN (no migrations to apply)
    expect(mockQuery).not.toHaveBeenCalledWith("BEGIN");
  });

  it("applies pending migrations in order", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "002_add_users.sql",
    ] as any);
    readFileSyncSpy.mockImplementation((filePath: string) => {
      if (filePath.includes("001_init.sql")) return "CREATE TABLE t1();";
      if (filePath.includes("002_add_users.sql")) return "CREATE TABLE t2();";
      return "";
    });

    mockQuery
      // The database-lifecycle advisory lock (lock_timeout, acquire, reset),
      // taken first so only one process initializes or migrates at a time.
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE schema_migrations
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied (none)
      .mockResolvedValue(undefined); // All subsequent queries succeed

    await runMigrations();

    // Verify BEGIN/SQL/INSERT/COMMIT pattern for each migration
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("CREATE TABLE t1();");
    expect(calls).toContain("CREATE TABLE t2();");
    expect(calls).toContain("COMMIT");

    // Should have recorded both migrations
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["001_init.sql"],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["002_add_users.sql"],
    );

    expect(logSpy).toHaveBeenCalledWith("Applied 2 migration(s) successfully");
  });

  it("applies migrations in numeric prefix order, not string order, whatever order the directory lists them in", async () => {
    // Issue #1277: `readdirSync(...).sort()` is a string sort, which agrees
    // with numeric order only while every historical prefix begins with 0 or 1
    // and every timestamp with 2. The 205 below is above today's ceiling (the
    // prefix check refuses one), and it is exactly the shape a string sort
    // places after every timestamp: the runner's order must not depend on the
    // coincidence.
    existsSyncSpy.mockReturnValue(true);
    const listing = [
      "20260905143000_new.sql",
      "205_beyond_ceiling.sql",
      "168_existing.sql",
      "022_old.sql",
    ];
    readdirSyncSpy.mockReturnValue(listing as any);
    readFileSyncSpy.mockReturnValue("SELECT 1;");
    // The fixture must be one a string sort gets wrong, or this proves nothing.
    const stringSorted = [...listing].sort();
    expect(stringSorted[stringSorted.length - 1]).toBe(
      "205_beyond_ceiling.sql",
    );

    mockQuery
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied
      .mockResolvedValue(undefined);

    await runMigrations();

    const recorded = mockQuery.mock.calls
      .filter(
        (c) => c[0] === "INSERT INTO schema_migrations (filename) VALUES ($1)",
      )
      .map((c) => c[1][0]);
    expect(recorded).toEqual([
      "022_old.sql",
      "168_existing.sql",
      "205_beyond_ceiling.sql",
      "20260905143000_new.sql",
    ]);
  });

  it("refuses to run when a filename carries neither prefix form", async () => {
    // A name the comparator cannot place is not applied at whatever position
    // a string sort would give it; the run fails before any BEGIN.
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue(["001_init.sql", "1000_wide.sql"] as any);
    mockQuery.mockResolvedValue({ rows: [] });

    await runMigrations();

    expect(mockQuery).not.toHaveBeenCalledWith("BEGIN");
    const report = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(report).toContain('cannot order migration filename "1000_wide.sql"');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("applies only pending migrations (skips already-applied)", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "002_add_users.sql",
      "003_add_prefs.sql",
    ] as any);
    readFileSyncSpy.mockReturnValue("SELECT 1;");

    mockQuery
      // The database-lifecycle advisory lock (lock_timeout, acquire, reset),
      // taken first so only one process initializes or migrates at a time.
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({
        rows: [{ filename: "001_init.sql" }, { filename: "002_add_users.sql" }],
      }) // SELECT applied (first two already done)
      .mockResolvedValue(undefined); // All subsequent queries succeed

    await runMigrations();

    // Only the third migration should be applied
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["003_add_prefs.sql"],
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["001_init.sql"],
    );

    expect(logSpy).toHaveBeenCalledWith("Applied 1 migration(s) successfully");
  });

  it("rolls back and exits on migration failure, naming the file and the SQL error", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue(["001_bad.sql"] as any);
    readFileSyncSpy.mockReturnValue("INVALID SQL;");

    mockQuery
      // The database-lifecycle advisory lock (lock_timeout, acquire, reset),
      // taken first so only one process initializes or migrates at a time.
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(
        pgError('syntax error at or near "INVALID"', {
          code: "42601",
          position: "1",
        }),
      ) // SQL fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await runMigrations();

    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    const report = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(report).toContain("Migration failed: 001_bad.sql");
    expect(report).toContain('syntax error at or near "INVALID"');
    expect(report).toContain("42601 (syntax_error)");
    expect(report).toContain("docs/database-migrations.md");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("reports how many migrations committed before the failing one", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue(["001_ok.sql", "002_bad.sql"] as any);
    readFileSyncSpy.mockReturnValue("SELECT 1;");

    mockQuery
      // The database-lifecycle advisory lock (lock_timeout, acquire, reset),
      // taken first so only one process initializes or migrates at a time.
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied
      .mockResolvedValueOnce(undefined) // BEGIN (001)
      .mockResolvedValueOnce(undefined) // SQL (001)
      .mockResolvedValueOnce(undefined) // INSERT (001)
      .mockResolvedValueOnce(undefined) // COMMIT (001)
      .mockResolvedValueOnce(undefined) // BEGIN (002)
      .mockRejectedValueOnce(pgError("boom")) // SQL fails (002)
      .mockResolvedValue(undefined); // ROLLBACK and beyond

    await runMigrations();

    const report = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(report).toContain("Migration failed: 002_bad.sql");
    expect(report).toContain(
      "1 migration(s) applied successfully before this one",
    );
  });

  it("exits on connection failure with a runner-level diagnostic", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await runMigrations();

    const report = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(report).toContain(
      "Migration runner failed before or between migrations.",
    );
    expect(report).toContain("ECONNREFUSED");
    expect(report).toContain("docs/database-migrations.md");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("filters non-.sql files from migrations directory", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "README.md",
      ".gitkeep",
    ] as any);
    readFileSyncSpy.mockReturnValue("SELECT 1;");

    mockQuery
      // The database-lifecycle advisory lock (lock_timeout, acquire, reset),
      // taken first so only one process initializes or migrates at a time.
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied
      .mockResolvedValue(undefined); // All subsequent queries succeed

    await runMigrations();

    // Only 001_init.sql should be applied (not README.md or .gitkeep)
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["001_init.sql"],
    );
    expect(logSpy).toHaveBeenCalledWith("Applied 1 migration(s) successfully");
  });

  it("forwards Postgres notices to the logger", async () => {
    // APP_ROLE_GRANTS_SQL reports an insufficient-privilege failure as RAISE
    // WARNING, which pg delivers as a notice event. Without this handler the
    // one path meant to make grants converge failed with zero log output.
    existsSyncSpy.mockReturnValue(false);
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();

    try {
      await runMigrations();

      expect(mockOn).toHaveBeenCalledWith("notice", expect.any(Function));
      const handler = mockOn.mock.calls.find((c) => c[0] === "notice")![1];
      handler({
        message: "Insufficient privilege to grant DML to role monize_app",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "Postgres: Insufficient privilege to grant DML to role monize_app",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("acquires the lifecycle lock before reading the applied set", async () => {
    // The lock exists to serialise check-then-act: reading which migrations
    // are applied before the current holder finishes would replay its work.
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([] as any);
    mockQuery.mockResolvedValue({ rows: [] });

    await runMigrations();

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    const lockAt = calls.findIndex((t) => t.includes("pg_advisory_lock"));
    const appliedAt = calls.findIndex((t) =>
      t.includes("SELECT filename FROM schema_migrations"),
    );
    expect(lockAt).toBeGreaterThan(-1);
    expect(appliedAt).toBeGreaterThan(lockAt);
  });

  it("re-applies the runtime role grants after this boot's DDL", async () => {
    // On a first boot this pass is what revokes the runtime role's writes on
    // schema_migrations -- db-init granted before the table existed.
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue(["001_init.sql"] as any);
    readFileSyncSpy.mockReturnValue("CREATE TABLE t1();");
    mockQuery.mockResolvedValue({ rows: [] });

    await runMigrations();

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    const commitAt = calls.lastIndexOf("COMMIT");
    const grantsAt = calls.findIndex((t) =>
      t.includes("GRANT USAGE ON SCHEMA public"),
    );
    expect(commitAt).toBeGreaterThan(-1);
    expect(grantsAt).toBeGreaterThan(commitAt);
  });

  it("always closes the client connection", async () => {
    existsSyncSpy.mockReturnValue(false);

    await runMigrations();

    expect(mockEnd).toHaveBeenCalled();
  });

  it("closes connection even after failure", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await runMigrations();

    expect(mockEnd).toHaveBeenCalled();
  });
});

describe("describeSqlError()", () => {
  it("reads every pg diagnostic field off a DatabaseError", () => {
    const fields = describeSqlError(
      pgError('column "x" of relation "y" already exists', {
        code: "42701",
        detail: "some detail",
        hint: "some hint",
        where: "PL/pgSQL function inline_code_block line 3",
        position: "42",
        schema: "public",
        table: "y",
        column: "x",
        constraint: "y_pkey",
      }),
    );

    expect(fields).toEqual({
      message: 'column "x" of relation "y" already exists',
      code: "42701",
      detail: "some detail",
      hint: "some hint",
      where: "PL/pgSQL function inline_code_block line 3",
      position: "42",
      schema: "public",
      table: "y",
      column: "x",
      constraint: "y_pkey",
    });
  });

  it("survives a plain Error and a non-object throw", () => {
    expect(describeSqlError(new Error("plain")).message).toBe("plain");
    expect(describeSqlError(new Error("plain")).code).toBeUndefined();
    expect(describeSqlError("just a string").message).toBe("just a string");
    expect(describeSqlError(null).message).toBe("null");
  });

  it("ignores empty-string diagnostics", () => {
    expect(
      describeSqlError(pgError("m", { detail: "" })).detail,
    ).toBeUndefined();
  });
});

describe("locateSqlPosition()", () => {
  const sql = "SELECT 1;\nALTER TABLE t ADD COLUMN x INT;\nSELECT 2;";

  it("maps a pg character offset to the migration's line and column", () => {
    // Position 11 (1-based) is the "A" of ALTER: ten characters ("SELECT 1;\n")
    // precede it, so it is line 2, column 1.
    const located = locateSqlPosition(sql, "11");
    expect(located).not.toBeNull();
    expect(located!.line).toBe(2);
    expect(located!.column).toBe(1);
  });

  it("renders the offending line with a caret under the column", () => {
    const located = locateSqlPosition(sql, "11")!;
    const [source, caret] = located.excerpt.split("\n");
    expect(source).toContain("ALTER TABLE t ADD COLUMN x INT;");
    expect(caret.indexOf("^")).toBe(source.indexOf("ALTER"));
  });

  it("returns null when there is no usable position", () => {
    expect(locateSqlPosition(sql, undefined)).toBeNull();
    expect(locateSqlPosition(sql, "")).toBeNull();
    expect(locateSqlPosition(sql, "0")).toBeNull();
    expect(locateSqlPosition(sql, "not-a-number")).toBeNull();
    expect(locateSqlPosition(sql, String(sql.length + 2))).toBeNull();
  });
});

describe("formatMigrationFailure()", () => {
  const base = {
    file: "116_frequency.sql",
    filePath: "/app/migrations/116_frequency.sql",
    sql: "ALTER TABLE t ADD COLUMN x INT;",
    appliedBefore: 0,
  };

  it("names the file, path, message, sqlstate and runbook", () => {
    const report = formatMigrationFailure({
      ...base,
      error: pgError("boom", { code: "42601" }),
    });

    expect(report).toContain("Migration failed: 116_frequency.sql");
    expect(report).toContain("/app/migrations/116_frequency.sql");
    expect(report).toContain("error:     boom");
    expect(report).toContain("sqlstate:  42601 (syntax_error)");
    expect(report).toContain("docs/database-migrations.md");
    expect(report).toContain("No migrations were applied in this run.");
  });

  it("includes detail, hint, where and object identity when pg supplies them", () => {
    const report = formatMigrationFailure({
      ...base,
      error: pgError("boom", {
        detail: "Key (id)=(1) already exists.",
        hint: "Drop it first.",
        where: "PL/pgSQL function inline_code_block line 4",
        schema: "public",
        table: "t",
        column: "x",
        constraint: "t_pkey",
      }),
    });

    expect(report).toContain("Key (id)=(1) already exists.");
    expect(report).toContain("Drop it first.");
    expect(report).toContain("inline_code_block line 4");
    expect(report).toContain("public");
    expect(report).toContain("t_pkey");
  });

  it("points at the idempotency lint for already-exists failures", () => {
    const report = formatMigrationFailure({
      ...base,
      error: pgError('trigger "x" for relation "t" already exists', {
        code: "42710",
      }),
    });

    expect(report).toContain("not re-runnable");
    expect(report).toContain("npm run migration:lint");
  });

  it("separates missing-object failures from non-idempotent ones", () => {
    const report = formatMigrationFailure({
      ...base,
      error: pgError('relation "currencies" does not exist', { code: "42P01" }),
    });

    expect(report).toContain("ahead of whatever creates the object");
    expect(report).not.toContain("npm run migration:lint");
  });

  it("asks for a SQL fix, not the lint, for other failures", () => {
    const report = formatMigrationFailure({
      ...base,
      error: pgError("division by zero", { code: "22012" }),
    });

    expect(report).toContain("Fix the SQL in 116_frequency.sql");
    expect(report).not.toContain("npm run migration:lint");
  });

  it("shows the failing line when the error carries a position", () => {
    const report = formatMigrationFailure({
      ...base,
      sql: "SELECT 1;\nSELCT 2;",
      error: pgError("syntax error", { code: "42601", position: "11" }),
    });

    expect(report).toContain("at:        line 2, column 1");
    expect(report).toContain("SELCT 2;");
    expect(report).toContain("^");
  });

  it("states that the failed migration was rolled back and will be retried", () => {
    const report = formatMigrationFailure({
      ...base,
      error: new Error("boom"),
    });

    expect(report).toContain("rolled back in full");
    expect(report).toContain(
      "schema_migrations does not list 116_frequency.sql",
    );
  });

  it("counts the migrations that committed before the failure", () => {
    const report = formatMigrationFailure({
      ...base,
      appliedBefore: 3,
      error: new Error("boom"),
    });

    expect(report).toContain(
      "3 migration(s) applied successfully before this one",
    );
  });
});

describe("formatRunnerFailure()", () => {
  it("explains that nothing was migrated and points at the runbook", () => {
    const report = formatRunnerFailure(
      pgError("password authentication failed", {
        code: "42501",
        detail: "role monize_user",
        hint: "check DATABASE_PASSWORD",
      }),
    );

    expect(report).toContain(
      "Migration runner failed before or between migrations.",
    );
    expect(report).toContain("password authentication failed");
    expect(report).toContain("42501 (insufficient_privilege)");
    expect(report).toContain("role monize_user");
    expect(report).toContain("check DATABASE_PASSWORD");
    expect(report).toContain("Nothing was migrated.");
    expect(report).toContain("docs/database-migrations.md");
  });

  it("handles an error with no pg diagnostics", () => {
    const report = formatRunnerFailure(new Error("ECONNREFUSED"));

    expect(report).toContain("ECONNREFUSED");
    expect(report).not.toContain("sqlstate:");
  });
});
