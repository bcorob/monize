import { validateReceiptParserDefinition } from "./receipt-parser.validation";

const CAT = "33333333-3333-4333-8333-333333333333";
const ok = (extra: Record<string, unknown>) =>
  validateReceiptParserDefinition({ version: 2, ...extra });
const errorsOf = (extra: Record<string, unknown>) => {
  const r = ok(extra);
  return r.ok ? [] : r.errors;
};

describe("validation of fees, category names and balanceTolerance", () => {
  it("accepts fees entries with {amount} and feesCategoryId", () => {
    const r = ok({ fees: ["Kaucja {amount} zł"], feesCategoryId: CAT });
    expect(r.ok).toBe(true);
  });

  it("refuses a fee entry without {amount}", () => {
    expect(errorsOf({ fees: ["Kaucja"] }).map((e) => e.path)).toContain(
      "fees[0]",
    );
  });

  it("refuses a feesCategoryId that is not a UUID", () => {
    expect(errorsOf({ feesCategoryId: "x" })).toEqual([
      { path: "feesCategoryId", code: "invalid_uuid" },
    ]);
  });

  it.each(["defaultCategory", "shippingCategory", "feesCategory"])(
    "%s is a trimmed name of 1 to 100 characters",
    (field) => {
      const r = ok({ [field]: "  Food  " });
      expect(
        r.ok && (r.definition as unknown as Record<string, string>)[field],
      ).toBe("Food");
      expect(ok({ [field]: "a".repeat(100) }).ok).toBe(true);
      expect(errorsOf({ [field]: "a".repeat(101) })).toEqual([
        { path: field, code: "too_long" },
      ]);
      expect(errorsOf({ [field]: "   " })).toEqual([
        { path: field, code: "empty" },
      ]);
      expect(errorsOf({ [field]: 5 })).toEqual([
        { path: field, code: "invalid_type" },
      ]);
      expect(errorsOf({ [field]: "a\nb" })).toEqual([
        { path: field, code: "control_character" },
      ]);
    },
  );

  it("balanceTolerance is a decimal text from 0 to 0.05", () => {
    expect(ok({ balanceTolerance: "0" }).ok).toBe(true);
    expect(ok({ balanceTolerance: "0.0500" }).ok).toBe(true);
    expect(errorsOf({ balanceTolerance: "0.0501" })).toEqual([
      { path: "balanceTolerance", code: "out_of_range" },
    ]);
    expect(errorsOf({ balanceTolerance: "-0.01" })).toEqual([
      { path: "balanceTolerance", code: "invalid_value" },
    ]);
    expect(errorsOf({ balanceTolerance: "0,01" })).toEqual([
      { path: "balanceTolerance", code: "invalid_value" },
    ]);
    expect(errorsOf({ balanceTolerance: 0.01 })).toEqual([
      { path: "balanceTolerance", code: "invalid_type" },
    ]);
  });
});
