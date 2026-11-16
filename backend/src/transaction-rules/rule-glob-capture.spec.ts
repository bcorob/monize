import { matchesAliasPattern } from "../payees/alias-match.util";
import {
  MAX_CAPTURE_VALUE_LENGTH,
  matchGlobWithCaptures,
  parseGlob,
} from "./rule-glob-capture";

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("parseGlob", () => {
  it("splits literals, stars and captures", () => {
    expect(parseGlob("*Odbiorca: {payee} Rachunek*").tokens).toEqual([
      { kind: "star" },
      { kind: "literal", text: "Odbiorca: " },
      { kind: "capture", name: "payee" },
      { kind: "literal", text: " Rachunek" },
      { kind: "star" },
    ]);
  });

  it("collapses runs of stars, as matchesAliasPattern does", () => {
    expect(parseGlob("a***b").tokens).toEqual([
      { kind: "literal", text: "a" },
      { kind: "star" },
      { kind: "literal", text: "b" },
    ]);
  });

  it("lists capture names in order, duplicates kept", () => {
    expect(parseGlob("{a}x{b}y{a}").captureNames).toEqual(["a", "b", "a"]);
  });

  it.each([
    ["{Payee}"],
    ["{}"],
    ["{my_name}"],
    ["{averyveryverylongcapturename1}"],
  ])("reports %s as malformed and matches it as literal text", (pattern) => {
    const parsed = parseGlob(pattern);
    expect(parsed.malformed).toHaveLength(1);
    expect(parsed.captureNames).toEqual([]);
    expect(parsed.tokens).toEqual([{ kind: "literal", text: pattern }]);
  });

  it.each([["{1}"], ["{a b}"], ["{"], ["}"], ["x{y"], ["{a-b}"]])(
    "reads %s as literal text without complaint",
    (pattern) => {
      const parsed = parseGlob(pattern);
      expect(parsed.malformed).toEqual([]);
      expect(parsed.captureNames).toEqual([]);
    },
  );

  it("accepts a 20 character name and refuses 21", () => {
    expect(parseGlob(`{a${"b".repeat(19)}}`).captureNames).toHaveLength(1);
    expect(parseGlob(`{a${"b".repeat(20)}}`).captureNames).toHaveLength(0);
  });
});

describe("matchGlobWithCaptures", () => {
  const table: Array<[string, string, string, Record<string, string> | null]> =
    [
      [
        "the design example",
        "Przelew. Nazwa odbiorcy: Jan Kowalski Rachunek odbiorcy: 123",
        "*Nazwa odbiorcy: {payee} Rachunek*",
        { payee: "Jan Kowalski" },
      ],
      [
        "a whole-text capture",
        "Biedronka 12",
        "{shop}",
        { shop: "Biedronka 12" },
      ],
      ["a prefix capture", "Sklep: Zabka", "Sklep: {shop}", { shop: "Zabka" }],
      [
        "a suffix capture",
        "Zabka - karta",
        "{shop} - karta",
        { shop: "Zabka" },
      ],
      [
        "case-insensitive literals, original case kept",
        "SKLEP: ŻaBka",
        "sklep: {shop}",
        { shop: "ŻaBka" },
      ],
      [
        "the shortest run that lets the rest match",
        "a-b-c-d",
        "{first}-{rest}",
        { first: "a", rest: "b-c-d" },
      ],
      [
        "the leftmost placement of the next literal",
        "x=1;x=2;x=3",
        "{a};{b}",
        { a: "x=1", b: "x=2;x=3" },
      ],
      [
        "two captures around one literal",
        "from ACME to BOB",
        "from {src} to {dst}",
        { src: "ACME", dst: "BOB" },
      ],
      ["an empty capture", "ab", "a{mid}b", { mid: "" }],
      [
        "a capture value trimmed",
        "k:   spaced out   ;",
        "k:{v};",
        { v: "spaced out" },
      ],
      ["no match when a literal is missing", "abc", "a{x}z", null],
      ["no match when the prefix differs", "xabc", "a{x}c", null],
      ["no match when the suffix differs", "abcx", "a{x}c", null],
      ["literals may not overlap the suffix", "ab", "ab{x}b", null],
      [
        "a star between captures stays anonymous",
        "a1b2c",
        "a{one}b*c",
        { one: "1" },
      ],
      [
        "adjacent wildcards: the first takes nothing, the last takes the run",
        "ab",
        "a{x}{y}b",
        { x: "", y: "" },
      ],
      [
        "adjacent wildcards around text",
        "a123b",
        "a{x}{y}b",
        { x: "", y: "123" },
      ],
    ];

  it.each(table)("%s", (_name, text, pattern, expected) => {
    const got = matchGlobWithCaptures(text, pattern);
    expect(got === null ? null : plain(got)).toEqual(expected);
  });

  it("caps a captured value at 200 characters", () => {
    const got = matchGlobWithCaptures(`x${"a".repeat(300)}y`, "x{v}y");
    expect(got?.v).toHaveLength(MAX_CAPTURE_VALUE_LENGTH);
  });

  it("never matches beyond the shared 500 character bound", () => {
    const ok = "a".repeat(500);
    expect(matchGlobWithCaptures(ok, "{x}")).not.toBeNull();
    expect(matchGlobWithCaptures(`${ok}a`, "{x}")).toBeNull();
    expect(matchGlobWithCaptures("abc", `{x}${"a".repeat(500)}`)).toBeNull();
  });

  it("returns a frozen record without a prototype, so a capture named constructor is safe", () => {
    const got = matchGlobWithCaptures("abc", "a{constructor}c");
    expect(got).not.toBeNull();
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.getPrototypeOf(got)).toBeNull();
    expect(got?.constructor).toBe("b");
    expect(Object.keys(matchGlobWithCaptures("abc", "a*c") ?? {})).toEqual([]);
  });

  it("slices the original text when case folding keeps its length", () => {
    expect(matchGlobWithCaptures("Grüße: MÜLLER", "grüße: {n}")?.n).toBe(
      "MÜLLER",
    );
  });

  it("falls back to the folded text when case folding changes the length", () => {
    // U+0130 lower-cases to two code units.
    const got = matchGlobWithCaptures("İx: Name", "*x: {n}");
    expect(got?.n).toBe("name");
  });

  it("stays fast on a pattern built to hurt a backtracking matcher", () => {
    const text = "a".repeat(400);
    const started = Date.now();
    expect(matchGlobWithCaptures(text, "{a}a{b}a{c}a{d}a{e}b")).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("agreement with matchesAliasPattern on patterns without captures", () => {
  const texts = [
    "",
    "a",
    "ab",
    "aba",
    "abab",
    "biedronka 12",
    "  padded  ",
    "sklep: żabka",
    "x{y}z",
    "{}",
    "a*b",
    "przelew: jan kowalski rachunek: 1",
  ];
  const patterns = [
    "",
    "*",
    "**",
    "a",
    "a*",
    "*a",
    "*a*",
    "a*b",
    "a*a",
    "ab*b",
    "*b*a*",
    "a**b",
    "*biedronka*",
    "biedronka*",
    "*12",
    "sklep: *",
    "*rachunek*",
    "x{y}z",
    "{}",
    "{Bad}",
    "{",
    "}",
    "a*b*a*b",
    "*ab*ab*",
  ];

  it.each(patterns)("agrees on %j for every sample text", (pattern) => {
    for (const text of texts) {
      const captured = matchGlobWithCaptures(text, pattern) !== null;
      expect({ text, pattern, captured }).toEqual({
        text,
        pattern,
        captured: matchesAliasPattern(text, pattern),
      });
    }
  });

  it("agrees on a seeded random corpus", () => {
    let seed = 20260929;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ["a", "b", "A", "B", " ", "{", "}"];
    const build = (length: number, withStar: boolean): string =>
      Array.from({ length }, () =>
        withStar && next(4) === 0 ? "*" : alphabet[next(alphabet.length)],
      ).join("");
    for (let i = 0; i < 600; i++) {
      const text = build(next(9), false);
      const pattern = build(next(7), true);
      if (parseGlob(pattern).captureNames.length > 0) continue;
      expect({
        text,
        pattern,
        got: matchGlobWithCaptures(text, pattern) !== null,
      }).toEqual({
        text,
        pattern,
        got: matchesAliasPattern(text, pattern),
      });
    }
  });

  it("returns an empty capture set for a match without captures", () => {
    expect(plain(matchGlobWithCaptures("abc", "a*c"))).toEqual({});
  });
});
