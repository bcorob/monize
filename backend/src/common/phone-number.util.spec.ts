import { readFileSync } from "fs";
import { join } from "path";
import { BadRequestException } from "@nestjs/common";
import {
  formatPhoneForDisplay,
  normalizePhoneNumber,
  normalizePhoneOrThrow,
  phoneRegionFromPreferences,
  type PhoneNormalization,
} from "./phone-number.util";

/**
 * The phone rules are asserted from a shared table (`phone-number-cases.json`)
 * that `frontend/src/lib/phone-number.contract.test.ts` reads too, because the
 * browser validates a number before the server does: a case the two layers
 * answer differently is a form that submits a value the API then refuses, or
 * one that blocks a number the API would have taken. A case added on either
 * side is a case both must satisfy.
 */
interface NormalizeCase {
  name: string;
  input: string;
  prefs: { numberFormat?: string | null; language?: string | null } | null;
  expect: PhoneNormalization;
}
interface DisplayCase {
  input: string;
  expect: string;
}
interface RegionCase {
  name: string;
  prefs: { numberFormat?: string | null; language?: string | null } | null;
  expect: string | null;
}

const table = JSON.parse(
  readFileSync(join(__dirname, "phone-number-cases.json"), "utf8"),
) as {
  comment: string;
  normalize: NormalizeCase[];
  display: DisplayCase[];
  region: RegionCase[];
};

describe("phone number normalization, shared with the frontend", () => {
  it("reads a table with enough cases to be worth having", () => {
    // A table that failed to load would make every `it.each` below vacuous.
    expect(table.normalize.length).toBeGreaterThan(20);
    expect(table.display.length).toBeGreaterThan(5);
    expect(table.region.length).toBeGreaterThan(5);
    expect(table.comment).toContain("E.164");
  });

  it("covers both outcomes, so neither arm can silently stop being tested", () => {
    expect(table.normalize.some((c) => c.expect.ok)).toBe(true);
    const reasons = table.normalize
      .filter(
        (c): c is NormalizeCase & { expect: { ok: false } } => !c.expect.ok,
      )
      .map((c) => (c.expect as { reason: string }).reason);
    expect(reasons).toContain("invalid");
    expect(reasons).toContain("needs-country-code");
  });

  it.each(table.normalize)(
    "normalizes: $name",
    ({ input, prefs, expect: want }) => {
      const region = phoneRegionFromPreferences(prefs);
      expect(normalizePhoneNumber(input, region)).toEqual(want);
    },
  );

  it.each(table.display)(
    "displays $input as $expect",
    ({ input, expect: want }) => {
      expect(formatPhoneForDisplay(input)).toBe(want);
    },
  );

  it.each(table.region)(
    "resolves a region: $name",
    ({ prefs, expect: want }) => {
      expect(phoneRegionFromPreferences(prefs)).toBe(want);
    },
  );
});

describe("formatPhoneForDisplay is total", () => {
  it("renders nothing for an absent value", () => {
    expect(formatPhoneForDisplay(null)).toBe("");
    expect(formatPhoneForDisplay(undefined)).toBe("");
    expect(formatPhoneForDisplay("")).toBe("");
  });

  it("returns a legacy value unchanged rather than blanking it", () => {
    // Rows written before this rule are not backfilled, so a value that does
    // not parse still has to reach the reader -- a stored "call the shop" is
    // worth showing even though it cannot be dialled.
    expect(formatPhoneForDisplay("call the shop")).toBe("call the shop");
    expect(formatPhoneForDisplay("206-448-8762 (mobile)")).toBe(
      "206-448-8762 (mobile)",
    );
  });

  it("round-trips what normalization stored", () => {
    const result = normalizePhoneNumber("+44 20 7946 0958 ext. 12", null);
    if (!result.ok) throw new Error("expected a valid number");
    expect(formatPhoneForDisplay(result.stored)).toBe(result.display);
  });
});

describe("normalizePhoneOrThrow", () => {
  it("returns the stored form for a number it can read", () => {
    expect(normalizePhoneOrThrow("(206) 448-8762", "US")).toBe("+12064488762");
  });

  it("names the value it refused, so a wrong rejection is reportable", () => {
    expect(() => normalizePhoneOrThrow("12345", "US")).toThrow(
      BadRequestException,
    );
    expect(() => normalizePhoneOrThrow("12345", "US")).toThrow(/"12345"/);
  });

  it("asks for a country code rather than calling an unplaceable number invalid", () => {
    // The two refusals have different repairs: checking the digits would not
    // help a user whose number is correct and merely unplaceable.
    expect(() => normalizePhoneOrThrow("020 7946 0958", null)).toThrow(
      /country code/i,
    );
    expect(() => normalizePhoneOrThrow("020 7946 0958", "US")).toThrow(
      /not a valid phone number/i,
    );
  });
});
