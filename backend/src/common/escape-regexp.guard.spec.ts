import { readFileSync } from "node:fs";
import { join } from "node:path";

import { globSync } from "glob";

/**
 * Regex escaping is written once, in `escape-regexp.util.ts`.
 *
 * The character class was spelled out in four places and got a fifth copy that
 * escaped only dots -- which is how CodeQL's `js/incomplete-sanitization`
 * (CWE-020) came to fire on `repo-paths.util.ts`. Both halves of that are
 * mechanical rather than a judgement call, so this scans the source: a copy of
 * the class is a duplicate that can drift, and a `replace` that escapes one
 * metacharacter into a `\\`-prefixed literal is the incomplete form itself.
 *
 * The pattern is not "this calculation is wrong" but "this shape is the wrong
 * shape", and the next instance will be in a file nobody thought to check.
 */
const SRC = join(__dirname, "..");

/**
 * The canonical metacharacter class, as source text. Written with string
 * escapes rather than `String.raw`, because the class contains `${}` and a
 * template literal would read that as a substitution.
 */
const ESCAPE_CLASS = "[.*+?^${}()|[\\]\\\\]";

/**
 * A `replace` that rewrites one character into its backslash-escaped self:
 * `replace(/\./g, "\\.")`. That is the incomplete escape, and it reads as
 * complete because the metacharacter it handles is the one the value contains.
 */
const PARTIAL_ESCAPE =
  /\.replace\(\s*\/\\?([.*+?^$(){}|[\]])\/[a-z]*\s*,\s*"\\\\\1"/;

function sourceFiles(): string[] {
  return globSync("**/*.ts", {
    cwd: SRC,
    absolute: true,
    ignore: ["**/*.spec.ts", "**/*.d.ts", "**/node_modules/**"],
  });
}

function relative(file: string): string {
  return file.slice(SRC.length + 1).replace(/\\/g, "/");
}

describe("regex escaping has one implementation", () => {
  /** The helper itself is where the class is allowed to appear. */
  const OWNER = "common/escape-regexp.util.ts";

  it("the helper is the only file spelling out the metacharacter class", () => {
    const offenders = sourceFiles()
      .filter((file) => readFileSync(file, "utf8").includes(ESCAPE_CLASS))
      .map(relative)
      .filter((file) => file !== OWNER);

    expect(offenders).toEqual([]);
  });

  it("no file escapes a single metacharacter by hand", () => {
    const offenders = sourceFiles()
      .filter((file) => PARTIAL_ESCAPE.test(readFileSync(file, "utf8")))
      .map(relative)
      // The helper quotes the defect it exists to prevent.
      .filter((file) => file !== OWNER);

    expect(offenders).toEqual([]);
  });

  it("the partial-escape scan recognises the shape it was written for", () => {
    // The literal that was in `repo-paths.util.ts`, and a `%`/`_` SQL LIKE
    // escape, which is a different job and must not be flagged.
    expect(PARTIAL_ESCAPE.test(String.raw`p.replace(/\./g, "\\.")`)).toBe(true);
    expect(PARTIAL_ESCAPE.test(String.raw`v.replace(/[%_]/g, "\\$&")`)).toBe(
      false,
    );
  });

  it("the class scan recognises the shape it was written for", () => {
    const hand = `s.replace(/${ESCAPE_CLASS}/g, "\\\\$&")`;
    expect(hand.includes(ESCAPE_CLASS)).toBe(true);
    expect('s.replace(/[%_]/g, "\\\\$&")'.includes(ESCAPE_CLASS)).toBe(false);
  });
});
