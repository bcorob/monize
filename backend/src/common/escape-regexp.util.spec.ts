import { escapeRegExp } from "./escape-regexp.util";
import {
  buildPlainRootedPathPattern,
  commentPathSpans,
} from "./repo-paths.util";

describe("escapeRegExp", () => {
  it("escapes the backslash, which a dots-only escape leaves alone", () => {
    // The original defect: `value.replace(/\./g, "\\.")` handles every dot a
    // repository path can contain and passes `\` straight through, so the
    // literal `c\d` becomes the digit class.
    expect(escapeRegExp("c\\d")).toBe("c\\\\d");
    expect(new RegExp(escapeRegExp("c\\d")).test("c5")).toBe(false);
    expect(new RegExp(escapeRegExp("c\\d")).test("c\\d")).toBe(true);
  });

  it("escapes every regex metacharacter", () => {
    for (const meta of [
      ".",
      "*",
      "+",
      "?",
      "^",
      "$",
      "{",
      "}",
      "(",
      ")",
      "|",
      "[",
      "]",
      "\\",
    ]) {
      const pattern = new RegExp(`^${escapeRegExp(meta)}$`);
      expect(pattern.test(meta)).toBe(true);
    }
  });

  it("matches the literal and nothing else", () => {
    const pattern = new RegExp(`^${escapeRegExp("a.b*c")}$`);
    expect(pattern.test("a.b*c")).toBe(true);
    expect(pattern.test("axbbbc")).toBe(false);
  });

  it("leaves ordinary characters untouched", () => {
    expect(escapeRegExp("backend/src/main.ts")).toBe("backend/src/main\\.ts");
  });

  it("does not escape `-`, which is a SyntaxError under the u flag", () => {
    expect(escapeRegExp("a-b")).toBe("a-b");
    expect(() => new RegExp(escapeRegExp("a-b"), "u")).not.toThrow();
  });

  it("produces a valid pattern under the u flag for every metacharacter", () => {
    expect(
      () => new RegExp(escapeRegExp(".*+?^${}()|[]\\/-"), "u"),
    ).not.toThrow();
  });
});

describe("buildPlainRootedPathPattern escapes its prefixes", () => {
  it("reads a metacharacter in a prefix as a literal", () => {
    // A dots-only escape leaves `\d` intact, so the prefix is read as the digit
    // class and the pattern matches c5/main.ts -- a path claim nobody wrote.
    // That fixture is named here in plain prose rather than in a backticked
    // span, because a backticked span is the idiom for "this file is here" and
    // this one deliberately is not: source-comment-paths.spec.ts reads every
    // comment in this file as a claim about the tree. `a+b/` is the same
    // mistake without a backslash.
    const pattern = buildPlainRootedPathPattern(["c\\d/", "a+b/"]);
    expect("c5/main.ts".match(pattern)).toBeNull();
    expect("aab/main.ts".match(pattern)).toBeNull();
  });

  it("still matches the literal prefix it was given", () => {
    const pattern = buildPlainRootedPathPattern(["c\\d/"]);
    expect("c\\d/main.ts".match(pattern)).toEqual(["c\\d/main.ts"]);
  });

  it("keeps the real prefixes working", () => {
    // `.github/` carries the dot the original escape was written for.
    expect(
      commentPathSpans("see .github/workflows/ci.yml for the job"),
    ).toEqual([".github/workflows/ci.yml"]);
    expect(commentPathSpans("see backend/src/main.ts for the setup")).toEqual([
      "backend/src/main.ts",
    ]);
  });

  // The dot is the half the original escape did handle; asserted so a rewrite
  // of the escaping cannot lose it while fixing the backslash.
  it("does not read a dot in a prefix as a wildcard", () => {
    expect(commentPathSpans("see xgithub/workflows/ci.yml")).toEqual([]);
  });
});
