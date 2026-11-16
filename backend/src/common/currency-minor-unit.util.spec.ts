import { readFileSync } from "fs";
import { join } from "path";
import {
  bookSplitsAtMinorUnit,
  currencyMinorUnitDecimals,
  minorUnitAbsorbIndex,
} from "./currency-minor-unit.util";

interface BookingCase {
  name: string;
  amounts: number[];
  parentAmount: number;
  decimals: number;
  absorbIndex: number;
  expected: { amounts: number[]; parentAmount: number };
}

interface AbsorbCase {
  name: string;
  lines: {
    amount: number;
    transferAccountId: string | null;
    memo: string | null;
  }[];
  accountTypes: Record<string, string>;
  expected: number;
}

// The parity fixture: `frontend/src/lib/minor-unit-booking.test.ts` runs the
// same cases against the client's copy of both functions.
const cases = JSON.parse(
  readFileSync(join(__dirname, "minor-unit-booking-cases.json"), "utf8"),
) as { booking: BookingCase[]; absorbIndex: AbsorbCase[] };

describe("currencyMinorUnitDecimals", () => {
  it.each([
    ["EUR", 2],
    ["CAD", 2],
    ["JPY", 0],
    ["KWD", 3],
  ])("reads %s as %i decimals", (code, decimals) => {
    expect(currencyMinorUnitDecimals(code)).toBe(decimals);
  });

  it("falls back to 2 for a missing or unknown code, as the client does", () => {
    expect(currencyMinorUnitDecimals(null)).toBe(2);
    expect(currencyMinorUnitDecimals(undefined)).toBe(2);
    expect(currencyMinorUnitDecimals("")).toBe(2);
    expect(currencyMinorUnitDecimals("NOT-A-CODE")).toBe(2);
  });
});

describe("bookSplitsAtMinorUnit (minor-unit-booking-cases.json)", () => {
  it.each(cases.booking.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(
      bookSplitsAtMinorUnit(
        c.amounts,
        c.parentAmount,
        c.decimals,
        c.absorbIndex,
      ),
    ).toEqual(c.expected);
  });
});

describe("minorUnitAbsorbIndex (minor-unit-booking-cases.json)", () => {
  it.each(cases.absorbIndex.map((c) => [c.name, c] as const))(
    "%s",
    (_name, c) => {
      expect(
        minorUnitAbsorbIndex(c.lines, new Map(Object.entries(c.accountTypes))),
      ).toBe(c.expected);
    },
  );
});
