import { readFileSync } from "fs";
import { join } from "path";

import {
  buildIndex,
  buildMigrationIndex,
  commentPathSpans,
  extractSqlComments,
  extractTsComments,
  FileIndex,
  migrationProblem,
  migrationRefs,
  strictProblem,
} from "./repo-paths.util";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * `doc-paths.spec.ts` proved that a doc naming a file is a claim about the tree,
 * and checked it -- but only in `docs/` and `CLAUDE.md`. A source comment makes
 * the identical claim, and PR #1077 shipped four of them wrong, caught only by a
 * human reading the diff:
 *
 *  - `currency-reference-columns.ts` said the guard was
 *    currency-reference-columns.spec.ts; it is `currency-references.spec.ts`.
 *  - the same file cited "migrations 133 and 134" for the two currency
 *    functions, which had been renumbered to 136 and 137.
 *  - `136_currency_global_liveness.sql` sent the reader to `backend/src/db-init.ts`
 *    for the runtime grant, which had moved to `backend/src/common/db/app-role.ts`.
 *  - `137_currency_codes_referenced_by_user.sql` cited "sibling in 133" for a
 *    function that is in 136.
 *
 * The check is **existence, not semantics**: it catches a comment naming a file
 * or migration that is not in the tree -- a renamed or deleted file, a migration
 * number with no matching `NNN_*.sql`. It cannot catch a reference that resolves
 * to a real file which is nonetheless the wrong one. Of the four mistakes above,
 * only the renamed guard spec is a dead reference on today's tree: 133 and 134
 * later became the joint-account migrations, and `db-init.ts` still exists (its
 * grant moved out to `app-role.ts`), so those three are now semantic errors an
 * existence check cannot see. The blind spot is named on purpose. The unit tests
 * below feed each reverted comment through the scan's own functions against a
 * fixture that omits the stale target, proving the mechanism flags every shape;
 * the tree scan then holds the live tree to it, which is what caught two real
 * stale references (a moved `source-bytes.spec.ts`, a renamed integration spec)
 * when this guard first ran.
 *
 * So this guard extends the same grammar to TypeScript (`backend/src/**` /*.ts)
 * and SQL migration (`database/migrations/*.sql`) comments. Two things it must
 * get right, both with tests below rather than a comment:
 *
 *  - **Comments only, never strings.** A path or a `--` inside a string literal
 *    is code, not a claim -- `COMMENT ON FUNCTION ... IS '... -- enforced by
 *    x.spec.ts'` must not be read. `extractTsComments` / `extractSqlComments`
 *    skip strings, templates and (in TS) regexes.
 *  - **A migration is identified by its number, not a path.** "migration 136"
 *    resolves against the filename `136_*.sql`; a bare number with no migration
 *    cue ("as 100", "AES-256") is deliberately not read as one.
 */

// ---------------------------------------------------------------------------
// Comment extraction -- strings and templates must not leak in.
// ---------------------------------------------------------------------------

describe("TypeScript comment extraction", () => {
  it("reads line and block comments but not string or template contents", () => {
    const src = [
      `const url = "https://example.com/backend/src/not-a-claim.ts";`,
      `// see backend/src/real.ts`,
      `const t = \`${"${x}"} backend/src/also-not.ts\`;`,
      `/* block backend/src/blocky.ts */`,
      `const re = /backend\\/src\\/regexy.ts/; // trailing backend/src/tail.ts`,
    ].join("\n");
    const comments = extractTsComments(src);
    const joined = comments.join("\n");
    expect(joined).toContain("backend/src/real.ts");
    expect(joined).toContain("backend/src/blocky.ts");
    expect(joined).toContain("backend/src/tail.ts");
    // The string, template and regex bodies never became comments.
    expect(joined).not.toContain("not-a-claim.ts");
    expect(joined).not.toContain("also-not.ts");
    expect(joined).not.toContain("regexy.ts");
  });

  it("keeps a regex holding // from surfacing as a phantom line comment", () => {
    // A regex read as division would expose its `//` as a comment start; the
    // scanner consumes the literal instead.
    const src = `const slashes = str.replace(/\\/\\/backend\\/src\\/ghost.ts/, "");`;
    expect(extractTsComments(src).join("\n")).not.toContain("ghost.ts");
  });

  it("returns to a regex context after an operator keyword", () => {
    const src = `function f(s) { return /a\\/\\/b.ts/.test(s); } // real.ts`;
    const joined = extractTsComments(src).join("\n");
    expect(joined).toContain("real.ts");
    expect(joined).not.toContain("b.ts");
  });

  it("keeps a slash inside a regex character class from ending the literal", () => {
    // `[/]` holds a slash that must not be read as the closing delimiter, or the
    // trailing x.ts would leak and the real2.ts comment would be missed.
    const src = `const r = /[/]x.ts/; // real2.ts`;
    const joined = extractTsComments(src).join("\n");
    expect(joined).toContain("real2.ts");
    expect(joined).not.toContain("x.ts");
  });

  it("reads a comment inside a template interpolation, not just outside", () => {
    // An interpolation body is code, so a block comment in one is a real claim.
    // A nested object literal must not end the interpolation early.
    const src = [
      "const q = `SELECT ${build({ from: 1 }) /* see backend/src/interp.ts */}`;",
      "// backend/src/tail.ts",
    ].join("\n");
    const joined = extractTsComments(src).join("\n");
    expect(joined).toContain("backend/src/interp.ts");
    expect(joined).toContain("backend/src/tail.ts");
    // Template text around the interpolation is still not a comment.
    expect(joined).not.toContain("SELECT");
  });
});

describe("SQL comment extraction", () => {
  it("reads -- and block comments but not string-literal contents", () => {
    const sql = [
      `COMMENT ON FUNCTION f() IS`,
      `  'consult every FK -- enforced by currency-references.spec.ts.';`,
      `-- runtime grant lives in backend/src/common/db/app-role.ts`,
      `/* block backend/src/blocky.ts */`,
    ].join("\n");
    const comments = extractSqlComments(sql);
    const joined = comments.join("\n");
    expect(joined).toContain("backend/src/common/db/app-role.ts");
    expect(joined).toContain("backend/src/blocky.ts");
    // The `-- enforced by ...` inside the COMMENT string is not a comment.
    expect(joined).not.toContain("enforced by currency-references");
  });

  it("does not read -- inside a dollar-quoted body as a comment", () => {
    const sql = [
      `CREATE FUNCTION f() RETURNS void AS $$`,
      `BEGIN -- backend/src/inside-body.ts`,
      `END;`,
      `$$ LANGUAGE plpgsql;`,
      `-- backend/src/outside.ts`,
    ].join("\n");
    const joined = extractSqlComments(sql).join("\n");
    expect(joined).toContain("backend/src/outside.ts");
    expect(joined).not.toContain("inside-body.ts");
  });

  it("handles doubled single-quote escapes without ending the string early", () => {
    const sql = `SELECT 'it''s -- not a comment backend/src/nope.ts'; -- backend/src/yes.ts`;
    const joined = extractSqlComments(sql).join("\n");
    expect(joined).toContain("backend/src/yes.ts");
    expect(joined).not.toContain("nope.ts");
  });

  it("skips a named dollar-quoted body, not just $$", () => {
    const sql = [
      `CREATE FUNCTION f() RETURNS void AS $body$`,
      `  SELECT 1; -- backend/src/in-named-body.ts`,
      `$body$ LANGUAGE sql;`,
      `-- backend/src/after.ts`,
    ].join("\n");
    const joined = extractSqlComments(sql).join("\n");
    expect(joined).toContain("backend/src/after.ts");
    expect(joined).not.toContain("in-named-body.ts");
  });

  it("reads a nested block comment through to its outer close", () => {
    const joined = extractSqlComments(
      "/* outer /* inner backend/src/nested.ts */ still-outer */ SELECT 1;",
    ).join("\n");
    expect(joined).toContain("backend/src/nested.ts");
    expect(joined).toContain("still-outer");
  });

  it("treats a backslash-escaped quote in an E'...' string as content", () => {
    // In E'...' a `\'` is an escaped quote, so the string does not end there;
    // reading it as an ending would leak the tail and misread the `--` in it.
    const sql = `SELECT E'a\\' -- backend/src/in-estring.ts'; -- backend/src/real.ts`;
    const joined = extractSqlComments(sql).join("\n");
    expect(joined).toContain("backend/src/real.ts");
    expect(joined).not.toContain("in-estring.ts");
  });
});

// ---------------------------------------------------------------------------
// Claims inside a comment.
// ---------------------------------------------------------------------------

describe("comment path claims", () => {
  it("reads a backticked span at any strength and a plain-text rooted path", () => {
    const spans = commentPathSpans(
      "so `currency-references.spec.ts` parses `database/schema.sql`, " +
        "and the grant lives in backend/src/common/db/app-role.ts.",
    );
    expect(spans).toContain("currency-references.spec.ts"); // backticked bare
    expect(spans).toContain("database/schema.sql"); // backticked rooted
    expect(spans).toContain("backend/src/common/db/app-role.ts"); // plain rooted
  });

  it("does not read a bare word or a fragment out of running prose", () => {
    // Only backticks or a fully rooted path are claims; a stray `foo/bar` or a
    // trailing filename in a sentence is too ambiguous to demand resolution.
    const spans = commentPathSpans(
      "resolve names in category-name.util, see the map/helper there",
    );
    expect(spans).toEqual([]);
  });

  it("stops a rooted path at sentence punctuation", () => {
    expect(
      commentPathSpans("lives in backend/src/common/db/app-role.ts, alongside"),
    ).toContain("backend/src/common/db/app-role.ts");
  });

  it("resolves a .js reference to its .ts source only under compiledJs", () => {
    // A comment naming the compiled runtime (`main.js`) resolves against
    // `main.ts` -- but only for the source-comment scan. Docs stay strict, so a
    // doc naming a genuinely-missing `.js` is not excused by a `.ts` sibling.
    const idx = buildIndex(["backend/src/main.ts"]);
    expect(strictProblem("main.js", idx, { compiledJs: true })).toBeNull();
    expect(strictProblem("main.js", idx)).toContain("does not resolve");
  });
});

describe("migration-number references", () => {
  it("reads the migration and sibling-in forms, and no bare number", () => {
    expect(
      migrationRefs("The two SQL functions (migrations 136 and 137)"),
    ).toEqual([136, 137]);
    expect(
      migrationRefs("Group A predicate from migration 112 verbatim"),
    ).toEqual([112]);
    expect(migrationRefs("unlike their sibling in 136. They must")).toEqual([
      136,
    ]);
    // A comma- or ampersand-separated list is read the same as "and".
    expect(migrationRefs("mirrors migrations 112, 113 & 114 verbatim")).toEqual(
      [112, 113, 114],
    );
    // A number with no migration cue is not a reference.
    expect(migrationRefs("an overpayment is 100% principal")).toEqual([]);
    expect(migrationRefs("keyed by AES-256-GCM env var")).toEqual([]);
    expect(migrationRefs("stored as 159 in round.util")).toEqual([]);
  });

  it("reads a timestamp-prefixed migration as one number, never as its first four digits", () => {
    // `\d{2,4}` alone would read a fourteen-digit timestamp as its first
    // four digits and report a migration that does not exist; the timestamp
    // form is tried first.
    expect(migrationRefs("added by migration 20260905143000")).toEqual([
      20260905143000,
    ]);
    expect(
      migrationRefs("migrations 191 and 20260905143000 both touch it"),
    ).toEqual([191, 20260905143000]);
    expect(migrationRefs("sibling in 20260905143000.")).toEqual([
      20260905143000,
    ]);
    // A digit run of neither width is not a migration number.
    expect(migrationRefs("migration 12345 is not a form")).toEqual([]);
  });

  it("resolves a referenced number against the migration filenames", () => {
    const migrations = buildMigrationIndex([
      "database/migrations/136_currency_global_liveness.sql",
      "database/migrations/137_currency_codes_referenced_by_user.sql",
    ]);
    expect(migrationProblem(136, migrations)).toBeNull();
    expect(migrationProblem(133, migrations)).toContain("does not exist");
    expect(migrationProblem(133, migrations)).toContain("133_*.sql");
  });

  it("indexes a timestamp-prefixed filename by its full numeric value", () => {
    const migrations = buildMigrationIndex([
      "database/migrations/191_payee_lookup_ai_enabled.sql",
      "database/migrations/20260905143000_heal_something.sql",
    ]);
    expect(migrationProblem(20260905143000, migrations)).toBeNull();
    expect(migrationProblem(191, migrations)).toBeNull();
    expect(migrationProblem(20260905143001, migrations)).toContain(
      "20260905143001_*.sql",
    );
  });
});

// ---------------------------------------------------------------------------
// The four PR #1077 claims fail when reverted (issue #1093, criterion 1).
// Each reverted comment is fed through the same functions the tree scan uses,
// against a fixture representing the *corrected* tree -- the currency functions
// are 136/137, their guard is `currency-references.spec.ts`, the runtime grant
// is in `app-role.ts` -- and omitting the stale targets, so each reverted claim
// is a reference to something absent. That isolates the detection mechanism from
// the existence blind spot named in the file header: on the live tree three of
// these targets exist as other things, so only the renamed guard spec fails the
// tree scan; here every shape does.
// ---------------------------------------------------------------------------

describe("the corrected PR #1077 claims fail when reverted", () => {
  const index: FileIndex = buildIndex([
    "backend/src/currencies/currency-references.spec.ts",
    "backend/src/common/db/app-role.ts",
    "database/schema.sql",
  ]);
  // Only the corrected currency migrations exist in the fixture; a revert to
  // 133/134 (or "sibling in 133") therefore names a migration that is absent.
  const migrations = buildMigrationIndex([
    "database/migrations/136_currency_global_liveness.sql",
    "database/migrations/137_currency_codes_referenced_by_user.sql",
  ]);

  const pathProblems = (comment: string): string[] =>
    commentPathSpans(comment)
      .map((span) => strictProblem(span, index, { compiledJs: true }))
      .filter((p): p is string => p !== null);

  const numberProblems = (comment: string): string[] =>
    migrationRefs(comment)
      .map((ref) => migrationProblem(ref, migrations))
      .filter((p): p is string => p !== null);

  it("flags the renamed guard spec (currency-reference-columns.ts)", () => {
    const reverted = extractTsComments(
      "/** so `currency-reference-columns.spec.ts` parses schema.sql */",
    ).join("\n");
    expect(pathProblems(reverted)).toEqual([
      expect.stringContaining("currency-reference-columns.spec.ts"),
    ]);
  });

  it("flags the renumbered currency migrations (currency-reference-columns.ts)", () => {
    const reverted = extractTsComments(
      "// The two SQL functions (migrations 133 and 134) answer the database's",
    ).join("\n");
    expect(numberProblems(reverted)).toEqual([
      expect.stringContaining("migration 133"),
      expect.stringContaining("migration 134"),
    ]);
  });

  it("flags the moved runtime-grant path (136_currency_global_liveness.sql)", () => {
    const reverted = extractSqlComments(
      "-- runtime grant lives in backend/src/db-init.ts alongside the other",
    ).join("\n");
    expect(pathProblems(reverted)).toEqual([
      expect.stringContaining("backend/src/db-init.ts"),
    ]);
  });

  it("flags the sibling migration number (137_currency_codes_referenced_by_user.sql)", () => {
    const reverted = extractSqlComments(
      "-- Both are deliberately SECURITY INVOKER, unlike their sibling in 133.",
    ).join("\n");
    expect(numberProblems(reverted)).toEqual([
      expect.stringContaining("migration 133"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The tree itself: every source and migration comment tells the truth.
// ---------------------------------------------------------------------------

const REPO_ROOT = findRepoRoot(__dirname);

const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("source and migration comments name things that exist", () => {
  interface TreeData {
    index: FileIndex;
    migrations: Set<number>;
    tsFiles: string[];
    sqlFiles: string[];
  }
  let cached: TreeData | undefined;

  const load = (): TreeData => {
    if (cached) return cached;
    const root = requireRepoRoot(REPO_ROOT);
    // Existence is generous (tracked plus untracked-but-not-ignored), matching
    // doc-paths: a file committed in the same change as the comment that names
    // it passes before staging.
    const index = buildIndex(
      gitListFiles(root, "--cached --others --exclude-standard"),
    );
    const tracked = gitListFiles(root);
    const sqlFiles = tracked.filter((f) =>
      /^database\/migrations\/[^/]+\.sql$/.test(f),
    );
    const tsFiles = tracked.filter((f) => /^backend\/src\/.+\.tsx?$/.test(f));
    cached = {
      index,
      migrations: buildMigrationIndex(sqlFiles),
      tsFiles,
      sqlFiles,
    };
    return cached;
  };

  const problemsIn = (
    files: string[],
    extract: (source: string) => string[],
  ): string[] => {
    const { index, migrations } = load();
    const found: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT as string, file), "utf8");
      for (const comment of extract(source)) {
        for (const span of commentPathSpans(comment)) {
          const problem = strictProblem(span, index, { compiledJs: true });
          if (problem) found.push(`${file}: ${problem}`);
        }
        for (const ref of migrationRefs(comment)) {
          const problem = migrationProblem(ref, migrations);
          if (problem) found.push(`${file}: ${problem}`);
        }
      }
    }
    return found;
  };

  it("scans a real body of files, so the assertions are not vacuous", () => {
    const { tsFiles, sqlFiles, index, migrations } = load();
    expect(tsFiles.length).toBeGreaterThan(500);
    expect(sqlFiles.length).toBeGreaterThan(100);
    expect(index.list.length).toBeGreaterThan(500);
    expect(migrations.size).toBeGreaterThan(100);
  });

  it("finds no stale path in a backend/src TypeScript comment", () => {
    expect(problemsIn(load().tsFiles, extractTsComments)).toEqual([]);
  });

  it("finds no stale path or migration number in a migration comment", () => {
    expect(problemsIn(load().sqlFiles, extractSqlComments)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reach of an existence guard on a literal #1077 revert, asserted against
// the live tree rather than a fixture -- the boundary the review asked to see
// made explicit. Existence checking flags a dead reference; it cannot flag a
// reference that still resolves to a real-but-wrong target.
// ---------------------------------------------------------------------------

describeTree("a literal PR #1077 revert against the live tree", () => {
  const realTree = (): { index: FileIndex; migrations: Set<number> } => {
    const root = requireRepoRoot(REPO_ROOT);
    const all = gitListFiles(root, "--cached --others --exclude-standard");
    return {
      index: buildIndex(all),
      migrations: buildMigrationIndex(
        all.filter((f) => /^database\/migrations\/[^/]+\.sql$/.test(f)),
      ),
    };
  };

  it("catches correction #1, whose target is genuinely gone today", () => {
    // currency-reference-columns.spec.ts was renamed to
    // currency-references.spec.ts, so the old name resolves nowhere -- a literal
    // revert of this comment fails the guard on the real tree, no fixture needed.
    const { index } = realTree();
    expect(
      strictProblem("currency-reference-columns.spec.ts", index, {
        compiledJs: true,
      }),
    ).toContain("does not resolve");
  });

  it("cannot catch corrections #2-#4, whose targets still exist (named blind spot)", () => {
    // 133 and 134 are now the joint-account migrations, and
    // backend/src/db-init.ts still exists (its grant moved to app-role.ts), so a
    // literal revert to any of them resolves. An existence guard cannot tell that
    // they mean something different now; catching that needs content-level
    // verification this guard deliberately does not attempt. This asserts the
    // limit so it is a known, tested boundary rather than a surprise.
    const { index, migrations } = realTree();
    expect(migrationProblem(133, migrations)).toBeNull();
    expect(migrationProblem(134, migrations)).toBeNull();
    expect(
      strictProblem("backend/src/db-init.ts", index, { compiledJs: true }),
    ).toBeNull();
  });
});
