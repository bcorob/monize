import { normalizeInstalmentText, normalizeLinkValue } from "./receipt-link";

describe("normalizeLinkValue", () => {
  it("removes every kind of whitespace and lower-cases", () => {
    expect(normalizeLinkValue(" 1000 000 002\t")).toBe("1000000002");
    expect(normalizeLinkValue("AB 12 Cd")).toBe("ab12cd");
  });

  it("returns null for an empty or blank value", () => {
    expect(normalizeLinkValue("")).toBeNull();
    expect(normalizeLinkValue("   ")).toBeNull();
  });

  it("accepts 100 characters and refuses 101", () => {
    expect(normalizeLinkValue("a".repeat(100))).toBe("a".repeat(100));
    expect(normalizeLinkValue("a".repeat(101))).toBeNull();
    // The length is counted after the whitespace is gone.
    expect(normalizeLinkValue(`${"a ".repeat(50)}a`)).toBe("a".repeat(51));
  });
});

describe("normalizeInstalmentText", () => {
  it("trims and folds whitespace", () => {
    expect(normalizeInstalmentText("  1.  spłata z   3 ")).toBe(
      "1. spłata z 3",
    );
  });

  it("returns null when nothing is left", () => {
    expect(normalizeInstalmentText("    ")).toBeNull();
  });

  it("cuts to 50 characters", () => {
    const out = normalizeInstalmentText("x".repeat(80));
    expect(out).toBe("x".repeat(50));
  });
});
