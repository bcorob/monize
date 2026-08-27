/**
 * Self-test for the migration idempotency lint (`migration-lint.mjs`). Runs
 * under `node --test` (not jest) since it exercises an ESM build script, not
 * app code.
 *
 *   node --test scripts/migration-lint.test.mjs   (npm run migration:lint:test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  RULES,
  stripComments,
  splitStatements,
  lineOf,
  isBlockGuarded,
  normalizeIdentifier,
  collectPragmas,
  lintSql,
  lintDirectory,
  NON_RERUNNABLE_DATA_MIGRATIONS,
  missingOneShotMigrations,
} from "./migration-lint.mjs";

const rulesOf = (sql) => lintSql(sql).findings.map((f) => f.rule);
const clean = (sql) => assert.deepEqual(lintSql(sql).findings, []);
const flags = (sql, rule) => {
  const found = rulesOf(sql);
  assert.ok(
    found.includes(rule),
    `expected rule "${rule}", got ${JSON.stringify(found)}`,
  );
};

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

test("stripComments blanks comments while preserving offsets and newlines", () => {
  const sql = "SELECT 1; -- trailing\nSELECT 2;";
  const stripped = stripComments(sql);
  assert.equal(stripped.length, sql.length);
  assert.equal(stripped.split("\n").length, 2);
  assert.ok(!stripped.includes("trailing"));
  assert.ok(stripped.startsWith("SELECT 1;"));
});

test("stripComments removes block comments and leaves double dashes inside literals", () => {
  assert.ok(!stripComments("/* note */ SELECT 1;").includes("note"));
  const literal = stripComments("SELECT '-- not a comment', 2;");
  assert.ok(literal.includes("-- not a comment"));
});

test("stripComments leaves dollar-quoted bodies untouched", () => {
  const sql = "DO $$ BEGIN -- inner\n RAISE NOTICE 'x'; END $$;";
  assert.ok(stripComments(sql).includes("-- inner"));
});

test("splitStatements separates top-level statements and reports offsets", () => {
  const sql = "SELECT 1;\nSELECT 2;";
  const statements = splitStatements(sql);
  assert.equal(statements.length, 2);
  assert.equal(lineOf(sql, statements[1].start), 2);
  assert.equal(statements[1].blockText, null);
});

test("splitStatements keeps a semicolon inside a dollar-quoted body out of the top level", () => {
  const sql = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;\nSELECT 9;";
  const statements = splitStatements(sql);
  const topLevel = statements.filter((s) => s.blockText === null);
  assert.equal(topLevel.length, 2);
  assert.ok(topLevel[0].text.includes("DO $$"));
  // The body's statements are present too, tagged with their enclosing block.
  assert.ok(
    statements.some((s) => s.blockText && s.text.includes("PERFORM 2")),
  );
});

test("splitStatements blanks the body out of the wrapper statement text", () => {
  const sql = "DO $$ BEGIN CREATE TABLE t (id int); END $$;";
  const wrapper = splitStatements(sql).find((s) => s.blockText === null);
  assert.ok(!wrapper.text.includes("CREATE TABLE"));
});

test("normalizeIdentifier strips quotes and schema qualification", () => {
  assert.equal(normalizeIdentifier('"MyTrigger"'), "mytrigger");
  assert.equal(normalizeIdentifier("public.tbl"), "tbl");
  assert.equal(normalizeIdentifier(undefined), "");
});

test("isBlockGuarded recognizes catalog probes and IF EXISTS tests only", () => {
  assert.equal(isBlockGuarded(null), false);
  assert.equal(isBlockGuarded("BEGIN PERFORM 1; END"), false);
  assert.equal(
    isBlockGuarded("IF NOT EXISTS (SELECT 1 FROM pg_trigger) THEN"),
    true,
  );
  assert.equal(
    isBlockGuarded("IF EXISTS (SELECT 1 FROM information_schema.columns)"),
    true,
  );
});

// ---------------------------------------------------------------------------
// Rules: unguarded DDL is caught
// ---------------------------------------------------------------------------

test("CREATE TABLE without IF NOT EXISTS is flagged", () => {
  flags(
    "CREATE TABLE widgets (id UUID PRIMARY KEY);",
    "create-table-without-if-not-exists",
  );
  clean("CREATE TABLE IF NOT EXISTS widgets (id UUID PRIMARY KEY);");
});

test("CREATE INDEX without IF NOT EXISTS is flagged, unique and concurrent included", () => {
  flags("CREATE INDEX idx_a ON t(a);", "create-index-without-if-not-exists");
  flags(
    "CREATE UNIQUE INDEX idx_a ON t(a);",
    "create-index-without-if-not-exists",
  );
  flags(
    "CREATE INDEX CONCURRENTLY idx_a ON t(a);",
    "create-index-without-if-not-exists",
  );
  clean("CREATE INDEX IF NOT EXISTS idx_a ON t(a);");
  clean("CREATE UNIQUE INDEX IF NOT EXISTS idx_a ON t(a);");
});

test("ADD COLUMN without IF NOT EXISTS is flagged once per column", () => {
  const findings = lintSql(
    "ALTER TABLE t ADD COLUMN a INT, ADD COLUMN IF NOT EXISTS b INT, ADD COLUMN c INT;",
  ).findings;
  assert.equal(findings.length, 2);
  assert.ok(
    findings.every((f) => f.rule === "add-column-without-if-not-exists"),
  );
  clean("ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT;");
});

test("ADD without the COLUMN keyword is flagged (it can never carry the guard)", () => {
  flags("ALTER TABLE t ADD note TEXT;", "add-column-without-if-not-exists");
  clean("ALTER TABLE t ENABLE ROW LEVEL SECURITY;");
});

test("DROP without IF EXISTS is flagged for every object kind", () => {
  for (const stmt of [
    "DROP TABLE t;",
    "DROP INDEX idx_a;",
    "DROP TRIGGER trg ON t;",
    "DROP POLICY p ON t;",
    "ALTER TABLE t DROP COLUMN a;",
    "ALTER TABLE t DROP CONSTRAINT c;",
  ]) {
    flags(stmt, "drop-without-if-exists");
  }
  clean("DROP TABLE IF EXISTS t;");
  clean("ALTER TABLE t DROP COLUMN IF EXISTS a;");
});

test("ADD CONSTRAINT needs a preceding DROP CONSTRAINT IF EXISTS of the same name", () => {
  flags(
    "ALTER TABLE t ADD CONSTRAINT chk_a CHECK (a > 0);",
    "add-constraint-without-drop",
  );
  // A drop of a *different* constraint does not excuse it.
  flags(
    "ALTER TABLE t DROP CONSTRAINT IF EXISTS chk_b;\nALTER TABLE t ADD CONSTRAINT chk_a CHECK (a > 0);",
    "add-constraint-without-drop",
  );
  clean(
    "ALTER TABLE t DROP CONSTRAINT IF EXISTS chk_a;\nALTER TABLE t ADD CONSTRAINT chk_a CHECK (a > 0);",
  );
});

test("CREATE TRIGGER needs a preceding DROP TRIGGER IF EXISTS or a pg_trigger guard", () => {
  flags(
    "CREATE TRIGGER trg_a BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();",
    "create-trigger-without-drop",
  );
  // The 077 style: drop-then-create.
  clean(
    "DROP TRIGGER IF EXISTS trg_a ON t;\n" +
      "CREATE TRIGGER trg_a BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();",
  );
  // The 056 style: a DO block that checks pg_trigger first.
  clean(`DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_a') THEN
        CREATE TRIGGER trg_a BEFORE UPDATE ON t
            FOR EACH ROW EXECUTE FUNCTION f();
    END IF;
END $$;`);
});

test("CREATE POLICY needs a preceding DROP POLICY IF EXISTS, dynamic %I included", () => {
  flags("CREATE POLICY p ON t USING (true);", "create-policy-without-drop");
  clean("DROP POLICY IF EXISTS p ON t;\nCREATE POLICY p ON t USING (true);");
  // The 112 style: a format()-driven drop/create loop over a table list.
  clean(`DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['a', 'b'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
        EXECUTE format('CREATE POLICY %I ON %I USING (user_id = 1)', t || '_isolation', t);
    END LOOP;
END $$;`);
});

test("enum value, type, function, view, sequence, extension and schema DDL are covered", () => {
  flags(
    "ALTER TYPE mood ADD VALUE 'sad';",
    "enum-add-value-without-if-not-exists",
  );
  clean("ALTER TYPE mood ADD VALUE IF NOT EXISTS 'sad';");
  flags("CREATE TYPE mood AS ENUM ('ok');", "create-type-without-guard");
  flags(
    "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;",
    "create-function-without-or-replace",
  );
  clean(
    "CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;",
  );
  flags("CREATE VIEW v AS SELECT 1;", "create-view-without-or-replace");
  clean("CREATE OR REPLACE VIEW v AS SELECT 1;");
  flags(
    "CREATE MATERIALIZED VIEW mv AS SELECT 1;",
    "create-view-without-or-replace",
  );
  flags("CREATE SEQUENCE s;", "create-object-without-if-not-exists");
  flags("CREATE EXTENSION pg_trgm;", "create-object-without-if-not-exists");
  clean("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
});

test("INSERT without ON CONFLICT is flagged; ON CONFLICT and WHERE NOT EXISTS pass", () => {
  flags("INSERT INTO t (a) VALUES (1);", "insert-without-on-conflict");
  clean("INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING;");
  clean("INSERT INTO t (a) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM t);");
});

/**
 * Not idempotency but deployability, and the reason it is here rather than in a
 * jest spec: it has to hold for every migration in the directory, and this is
 * the CI gate that walks all of them.
 *
 * A migration naming the runtime role fails on any installation where that role
 * does not exist -- it is provisioned by db-init, or by the CNPG Cluster
 * manifest, or not at all at RLS_MODE=off -- and the migration aborting means the
 * backend crash-loops before serving a request.
 *
 * PUBLIC is allowed, and for the same reason rather than in spite of it: it is a
 * keyword that always resolves. It must be allowed, because CREATE FUNCTION
 * grants EXECUTE to PUBLIC implicitly, so revoking that anywhere but the
 * transaction that created the function leaves a window in which any role can
 * execute a fresh SECURITY DEFINER function.
 */
test("a migration naming a role is flagged; PUBLIC is allowed", () => {
  flags("CREATE ROLE monize_app LOGIN;", "role-or-grant-statement");
  flags("ALTER ROLE monize_app NOSUPERUSER;", "role-or-grant-statement");
  flags("DROP ROLE monize_app;", "role-or-grant-statement");
  flags("CREATE USER monize_app PASSWORD 'x';", "role-or-grant-statement");
  flags(
    "GRANT EXECUTE ON FUNCTION f(VARCHAR) TO monize_app;",
    "role-or-grant-statement",
  );
  flags("GRANT SELECT ON TABLE t TO monize_app;", "role-or-grant-statement");
  flags("REVOKE ALL ON TABLE t FROM monize_app;", "role-or-grant-statement");
  // A quoted role name is still a named role.
  flags('GRANT SELECT ON t TO "monize_app";', "role-or-grant-statement");
  // Role membership is a GRANT naming two roles.
  flags("GRANT monize_admin TO monize_app;", "role-or-grant-statement");

  clean("REVOKE ALL ON FUNCTION f(VARCHAR) FROM PUBLIC;");
  clean("REVOKE ALL ON FUNCTION f(VARCHAR) FROM public;");
  clean("GRANT SELECT ON TABLE t TO PUBLIC;");
  // Tail options after the grantee list are options, not grantees.
  clean("GRANT SELECT ON TABLE t TO PUBLIC WITH GRANT OPTION;");
  clean("REVOKE ALL ON TABLE t FROM PUBLIC CASCADE;");
  // The word appearing in prose or an identifier is not a grant statement.
  clean("COMMENT ON FUNCTION f() IS 'EXECUTE is revoked from PUBLIC';");
});

test("every grantee in a list is checked, not just the first", () => {
  // `FROM PUBLIC, monize_app` names a role exactly as much as `FROM monize_app`
  // does; reading only the first entry let the rest of the list through.
  flags(
    "REVOKE ALL ON TABLE t FROM PUBLIC, monize_app;",
    "role-or-grant-statement",
  );
  flags(
    "GRANT SELECT ON TABLE t TO PUBLIC, monize_app;",
    "role-or-grant-statement",
  );
  flags(
    'REVOKE ALL ON TABLE t FROM monize_app, "PUBLIC";',
    "role-or-grant-statement",
  );
  clean("REVOKE ALL ON TABLE t FROM PUBLIC, public;");
});

test("the other statements that bind a role are flagged too", () => {
  // Each of these fails on an installation where the role does not exist, for
  // the same reason a GRANT does.
  flags("ALTER TABLE t OWNER TO monize_app;", "role-or-grant-statement");
  flags(
    "ALTER FUNCTION f(VARCHAR) OWNER TO monize_app;",
    "role-or-grant-statement",
  );
  flags("REASSIGN OWNED BY old_owner TO new_owner;", "role-or-grant-statement");
  flags("SET ROLE monize_app;", "role-or-grant-statement");
  flags("SET LOCAL ROLE monize_app;", "role-or-grant-statement");
  flags("SET SESSION AUTHORIZATION monize_app;", "role-or-grant-statement");

  // A policy's TO clause binds it to roles the same way a GRANT does.
  flags(
    "CREATE POLICY p ON t TO monize_app USING (true);",
    "role-or-grant-statement",
  );
  flags(
    "CREATE POLICY p ON t FOR SELECT TO PUBLIC, monize_app USING (true);",
    "role-or-grant-statement",
  );
  flags("ALTER POLICY p ON t TO monize_app;", "role-or-grant-statement");
  // TO PUBLIC is the default made explicit; RENAME TO renames the policy, not
  // a role; and a column named granted_to inside the predicate is not a TO
  // clause.
  clean(
    "DROP POLICY IF EXISTS p ON t;\nCREATE POLICY p ON t TO PUBLIC USING (granted_to IS NOT NULL);",
  );
  assert.ok(
    !rulesOf("ALTER POLICY p ON t RENAME TO p2;").includes(
      "role-or-grant-statement",
    ),
  );

  // RESET names no role, and the words inside a string literal are data, not a
  // statement.
  clean("RESET ROLE;");
  clean(
    "INSERT INTO notes (body) VALUES ('never SET ROLE in a migration') ON CONFLICT DO NOTHING;",
  );
});

test("the shipped migrations satisfy the role rule", () => {
  // The real directory, not a fixture: the claim is about every migration that
  // ships, so the test walks them all. No migration currently contains any
  // role, grant, ownership or SET ROLE statement -- grants live in db-init
  // (backend/src/common/db/app-role.ts).
  const migrationsDir = fileURLToPath(
    new URL("../../database/migrations", import.meta.url),
  );
  const { files, findings } = lintDirectory(migrationsDir);
  assert.ok(
    files.length > 100,
    `expected the real migrations, got ${files.length} file(s)`,
  );
  assert.deepEqual(
    findings.filter((f) => f.rule === "role-or-grant-statement"),
    [],
  );
});

test("a REVOKE FROM PUBLIC stays legal for the migration that will need it", () => {
  // CREATE FUNCTION grants EXECUTE to PUBLIC implicitly; the only gap-free
  // place to revoke that from a future SECURITY DEFINER function is the same
  // transaction that creates it. No shipped migration uses this yet -- the
  // test above pins that -- and this pins the allowance, so tightening the
  // rule to an absolute ban fails loudly here instead of blocking that
  // migration when it arrives.
  clean("REVOKE ALL ON FUNCTION some_future_definer(VARCHAR) FROM PUBLIC;");
});

test("statements that are re-runnable by nature are not flagged", () => {
  clean("ALTER TABLE t ALTER COLUMN a TYPE NUMERIC(20, 6);");
  clean("ALTER TABLE t ALTER COLUMN a SET DEFAULT 'x';");
  clean("ALTER TABLE t ALTER COLUMN a DROP NOT NULL;");
  clean("UPDATE t SET a = 'x' WHERE a IS NULL;");
  clean("DELETE FROM t WHERE a IS NULL;");
  clean("COMMENT ON FUNCTION f() IS 'note';");
  clean("SELECT 1;");
});

test("findings carry the line of the offending statement", () => {
  const { findings } = lintSql("-- header\n\nCREATE TABLE t (id int);\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
});

// ---------------------------------------------------------------------------
// Pragmas
// ---------------------------------------------------------------------------

test("a disable pragma with a reason suppresses that rule on the next statement", () => {
  clean(
    "-- migration-lint-disable-next-line insert-without-on-conflict: seed table is truncated first\n" +
      "INSERT INTO t (a) VALUES (1);",
  );
  // Only the named rule, and only for that statement.
  flags(
    "-- migration-lint-disable-next-line insert-without-on-conflict: reason\n" +
      "INSERT INTO t (a) VALUES (1);\nCREATE TABLE u (id int);",
    "create-table-without-if-not-exists",
  );
});

test("a disable pragma without a reason, or naming an unknown rule, is itself a finding", () => {
  const noReason = lintSql(
    "-- migration-lint-disable-next-line insert-without-on-conflict\nINSERT INTO t (a) VALUES (1);",
  ).findings;
  assert.ok(
    noReason.some(
      (f) => f.rule === "pragma" && /needs a reason/.test(f.message),
    ),
  );

  const unknown = collectPragmas(
    "-- migration-lint-disable-next-line no-such-rule: why\n",
  );
  assert.ok(unknown.problems.some((p) => /unknown lint rule/.test(p.message)));
});

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

test("every rule has a unique id", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the repository's migrations lint clean", () => {
  // fileURLToPath, not `.pathname` -- a file:// URL percent-encodes a space,
  // and lintDirectory hands that straight to `fs`, which does not decode it.
  const { files, findings } = lintDirectory(
    fileURLToPath(new URL("../../database/migrations", import.meta.url)),
  );
  assert.ok(files.length > 0, "expected migrations to be found");
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`),
    [],
  );
});

test("every registered one-shot data migration still exists, with a reason", () => {
  // The register excuses a file from the "a second pass matches nothing"
  // assumption the whole lint rests on, so a stale entry silently excuses a file
  // that is not there -- and a new one with no reason excuses it with no
  // argument. Both are the register failing at the only job it has.
  const dir = fileURLToPath(new URL("../../database/migrations", import.meta.url));
  const { files } = lintDirectory(dir);
  assert.deepEqual(missingOneShotMigrations(files), []);
  for (const [name, reason] of NON_RERUNNABLE_DATA_MIGRATIONS) {
    assert.ok(
      typeof reason === "string" && reason.length > 40,
      `${name} needs a reason saying what a second pass would do`,
    );
  }
});

test("a registered one-shot migration that has been deleted is reported", () => {
  assert.deepEqual(missingOneShotMigrations([]), [
    ...NON_RERUNNABLE_DATA_MIGRATIONS.keys(),
  ]);
  assert.ok(NON_RERUNNABLE_DATA_MIGRATIONS.size > 0);
});
