import * as fs from "fs";
import * as path from "path";
import { findProhibitedGuidance } from "./prohibited-primitive-guidance";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ESLINT_CONFIG = path.join(REPO_ROOT, "backend/eslint.config.mjs");

/**
 * The documented set of prohibited database primitives must be the configured
 * set.
 *
 * `CONTRIBUTING.md` told contributors to use `QueryRunner` transactions for every
 * multi-table write, long after the root instructions and ESLint had prohibited
 * them, and the auxiliary agent guidance demonstrated `dataSource.transaction`.
 * Nothing failed, because a document cannot be type-checked -- so a contributor
 * or an agent following official guidance produced code CI rejects, or worse,
 * code that evades the narrow syntax rule and merges.
 *
 * Fixing the wording is not the fix. This ties the two together: a ban added to
 * the config that no instruction file mentions fails here, and so does an
 * instruction naming a ban the config does not have. It reads the config as text
 * on purpose -- importing it would execute a flat-config module for its side
 * effects and still not enumerate the selectors.
 */
describe("RLS lint bans are documented where contributors read", () => {
  const config = fs.readFileSync(ESLINT_CONFIG, "utf8");

  /**
   * Method names banned via `no-restricted-syntax` on
   * `CallExpression[callee.property.name="..."]`, read out of the config rather
   * than listed here, so a new ban is covered without editing this spec.
   */
  const bannedCalls = [
    ...config.matchAll(
      /CallExpression\[callee\.property\.name="([A-Za-z]+)"\]/g,
    ),
  ].map((match) => match[1]);

  const instructionFiles = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "backend/CLAUDE.md",
  ];

  it("finds the bans it is meant to check", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuous.
    expect(bannedCalls).toContain("createQueryRunner");
    expect(bannedCalls).toContain("transaction");
    expect(config).toContain("InjectRepository");
  });

  // AGENTS.md is the canonical instruction file; the root CLAUDE.md imports it.
  it.each(["AGENTS.md", "CONTRIBUTING.md"])(
    "%s names every call the config bans",
    (relative) => {
      const doc = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
      // The call form, not the bare word: `transaction` is ordinary English in
      // these files ("MUST run in a single transaction"), so a substring check
      // for the method name would pass without the ban being documented at all.
      // The receiver is left open -- these files write both
      // `this.dataSource.transaction(...)` and a bare `createQueryRunner()`.
      const missing = bannedCalls.filter(
        (name) => !new RegExp(String.raw`\b${name}\(`).test(doc),
      );
      expect(missing).toEqual([]);
    },
  );

  it("no instruction file positively recommends a banned primitive", () => {
    const offenders = instructionFiles.flatMap((relative) =>
      findProhibitedGuidance(
        fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"),
        bannedCalls,
      ).map((hit) => `${relative}: ${hit.token} -- ${hit.excerpt}`),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The classifier itself, against fixed examples.
   *
   * Scanning the live documents proves only that today's wording passes, which is
   * how the first version of this check shipped unable to detect the exact
   * sentence its own comment named: "must use a `QueryRunner` transaction"
   * contains no call expression, so a call-form-only pattern missed it. The
   * negative cases matter just as much -- these files name every banned
   * primitive in order to ban it, and a classifier that cannot tell a
   * prohibition from a recommendation fails on correct documentation.
   */
  describe("recommendation classifier", () => {
    const detect = (text: string): number =>
      findProhibitedGuidance(text, bannedCalls).length;

    it.each([
      // The exact historical CONTRIBUTING.md rule this guard exists for.
      "Any operation touching multiple tables or doing read-modify-write must use a `QueryRunner` transaction.",
      "Any operation touching multiple tables or doing read-modify-write MUST use a `createQueryRunner()` transaction.",
      "You should open a QueryRunner and start a transaction.",
      "For multi-table writes, use `dataSource.transaction(async (m) => ...)`.",
      "Services must inject their repositories with @InjectRepository.",
      "Always prefer a QueryRunner for read-modify-write.",
    ])("flags: %s", (text) => {
      expect(detect(text)).toBeGreaterThan(0);
    });

    it.each([
      // Every one of these appears, in substance, in the live instruction files.
      "Never inject a repository with `@InjectRepository`, call `createQueryRunner()`, call `dataSource.transaction()`, or use a bare `dataSource.query(...)`.",
      "helpers take an `EntityManager`, never a `QueryRunner`.",
      "There are no `QueryRunner`s left in `src/`.",
      "If you find a `createQueryRunner()` in a diff, it is new and wrong.",
      "one withScopedDb replaces the QueryRunner block.",
      "`dataSource.transaction()` looks equivalent and is not: it opens a transaction outside the active scoped manager.",
      "The QueryRunner pattern is obsolete; it was removed in R1-R7.",
      // The noun, not the method. This is why the call form is required for
      // `transaction`: matching it bare fired on correct documentation.
      "Any operation that touches multiple tables MUST run in a single transaction.",
    ])("does not flag: %s", (text) => {
      expect(detect(text)).toBe(0);
    });

    it("is not vacuous -- it needs the ban list to detect anything", () => {
      const sentence = "You must use a QueryRunner transaction.";
      expect(findProhibitedGuidance(sentence, bannedCalls, [])).toEqual([]);
      expect(detect(sentence)).toBeGreaterThan(0);
    });
  });

  it("does not claim a counting ratchet that no longer exists", () => {
    // `docs/specs/mny-import.md` described a CI script counting
    // `@InjectRepository`/`createQueryRunner` sites and failing on any increase.
    // The script is gone -- the ratchet reached zero and became an outright ban
    // -- so a reader was being pointed at a gate that could not fail.
    // Walk recursively and keep FILES. `readdirSync` lists directories too, so
    // reading every entry threw EISDIR the first time a script directory grew a
    // subdirectory (`scripts/lib/`) -- a spec unrelated to that change failing
    // on it. Recursing is also the honest reading of the question: a ratchet
    // script nested one level down would have been invisible to a flat scan.
    const scripts = [
      path.join(REPO_ROOT, "scripts"),
      path.join(REPO_ROOT, "backend/scripts"),
    ].flatMap((dir) =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { withFileTypes: true, recursive: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(entry.parentPath, entry.name))
        : [],
    );
    const ratchetExists = scripts.some((file) =>
      /InjectRepository|createQueryRunner/.test(fs.readFileSync(file, "utf8")),
    );

    const claimsRatchet = fs
      .readFileSync(path.join(REPO_ROOT, "docs/specs/mny-import.md"), "utf8")
      .match(/the CI script counts/);

    expect(Boolean(claimsRatchet)).toBe(ratchetExists);
  });
});
