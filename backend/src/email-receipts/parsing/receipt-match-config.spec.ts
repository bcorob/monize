import {
  DEFAULT_MATCH_BY,
  DEFAULT_MATCH_CONFIG,
  MAX_TOLERANCE_UNITS,
  parseToleranceUnits,
  resolveMatchConfig,
} from "./receipt-match-config";

describe("parseToleranceUnits", () => {
  it.each([
    ["0", 0],
    ["0.00", 0],
    ["0.5", 5000],
    ["0.50", 5000],
    ["1", 10000],
    ["2.25", 22500],
    ["5.00", 50000],
    ["0.0001", 1],
    ["5.0001", 50001],
    ["12", 120000],
  ])("reads %j as %d units", (text, units) => {
    expect(parseToleranceUnits(text)).toBe(units);
  });

  it.each([
    "",
    ".",
    ".5",
    "5.",
    "-1",
    "+1",
    "1e2",
    "1,5",
    " 1",
    "1 ",
    "0.00001",
    "1234",
    "abc",
    "1.2.3",
    "０.５",
  ])("refuses %j", (text) => {
    expect(parseToleranceUnits(text)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    expect(parseToleranceUnits(1)).toBeNull();
    expect(parseToleranceUnits(null)).toBeNull();
    expect(parseToleranceUnits(undefined)).toBeNull();
    expect(parseToleranceUnits({})).toBeNull();
  });
});

describe("resolveMatchConfig", () => {
  it("is the truth table a profile without a match section always had", () => {
    expect(DEFAULT_MATCH_CONFIG).toEqual({
      by: ["orderId", "amount_payee", "amount_date"],
      referenceIn: ["description", "payee", "referenceNumber"],
      daysBefore: 3,
      daysAfter: 14,
      toleranceUnits: 0,
    });
    expect(resolveMatchConfig(undefined)).toEqual(DEFAULT_MATCH_CONFIG);
    expect(resolveMatchConfig(null)).toEqual(DEFAULT_MATCH_CONFIG);
    expect(resolveMatchConfig({})).toEqual(DEFAULT_MATCH_CONFIG);
    expect(DEFAULT_MATCH_BY).toEqual([
      "orderId",
      "amount_payee",
      "amount_date",
    ]);
  });

  it("takes every key the profile gives, and the default for the rest", () => {
    expect(
      resolveMatchConfig({
        by: ["reference", "amount_date"],
        referenceIn: ["description"],
        daysBefore: 0,
        daysAfter: 7,
        amountTolerance: "0.75",
      }),
    ).toEqual({
      by: ["reference", "amount_date"],
      referenceIn: ["description"],
      daysBefore: 0,
      daysAfter: 7,
      toleranceUnits: 7500,
    });
    expect(resolveMatchConfig({ daysAfter: 30 }).daysBefore).toBe(3);
  });

  it("keeps a stored tolerance inside the bound and a malformed one at zero", () => {
    expect(resolveMatchConfig({ amountTolerance: "9.00" }).toleranceUnits).toBe(
      MAX_TOLERANCE_UNITS,
    );
    expect(resolveMatchConfig({ amountTolerance: "abc" }).toleranceUnits).toBe(
      0,
    );
  });
});
