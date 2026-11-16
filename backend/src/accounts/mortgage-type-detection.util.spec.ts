import { readFileSync } from "fs";
import { join } from "path";
import {
  detectMortgageType,
  MORTGAGE_TYPE_DETECTION_REASONS,
  MortgageTypeDetection,
  MortgageTypeSample,
} from "./mortgage-type-detection.util";
import { MortgagePaymentFrequency } from "./mortgage-amortization.util";

interface DetectionCase {
  name: string;
  quotedAnnualRate: number | null;
  frequency: MortgagePaymentFrequency | null;
  samples: MortgageTypeSample[];
  expected: MortgageTypeDetection;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "mortgage-type-detection-cases.json"), "utf8"),
) as { cases: DetectionCase[] };

describe("mortgage-type-detection-cases.json", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(
      detectMortgageType(c.samples, c.quotedAnnualRate, c.frequency),
    ).toEqual(c.expected);
  });

  it("refuses with a reason the client can word, never a bare null", () => {
    for (const c of fixture.cases.filter((row) => row.expected.type === null)) {
      expect(MORTGAGE_TYPE_DETECTION_REASONS).toContain(c.expected.reason);
      expect(c.expected.confidence).toBe("low");
    }
  });

  it("covers every reason the detector can give", () => {
    const covered = new Set(fixture.cases.map((c) => c.expected.reason));
    covered.add("INVALID_SAMPLE");
    expect([...covered].sort()).toEqual(
      [...MORTGAGE_TYPE_DETECTION_REASONS].sort(),
    );
  });
});

describe("detectMortgageType", () => {
  const annuity: MortgageTypeSample[] = [
    { principal: 432.9, interest: 1500, balanceBefore: 300000 },
    { principal: 435.06, interest: 1497.84, balanceBefore: 299567.1 },
  ];

  it.each([
    ["a negative principal", { principal: -1, interest: 500 }],
    ["a negative interest", { principal: 833.33, interest: -500 }],
    ["a principal that is not a number", { principal: NaN, interest: 500 }],
    [
      "a balance that is not positive",
      { principal: 833.33, interest: 500, balanceBefore: 0 },
    ],
  ])("refuses %s as an invalid sample", (_label, bad) => {
    expect(detectMortgageType([bad, annuity[1]], 6, "MONTHLY")).toEqual({
      type: null,
      confidence: "low",
      reason: "INVALID_SAMPLE",
    });
  });

  it("checks only the samples that carry a balance", () => {
    expect(
      detectMortgageType(
        [annuity[0], { principal: 435.06, interest: 1497.84 }],
        6,
        "MONTHLY",
      ),
    ).toEqual({
      type: "ANNUITY",
      confidence: "high",
      reason: "CONSTANT_INSTALLMENT_NOMINAL",
    });
  });

  it("cannot check the compounding without a frequency", () => {
    expect(detectMortgageType(annuity, 6, null)).toEqual({
      type: "ANNUITY",
      confidence: "low",
      reason: "CONSTANT_INSTALLMENT_RATE_UNCHECKED",
    });
  });

  it("holds a sample one cent off its neighbours within the tolerance", () => {
    expect(
      detectMortgageType(
        [
          { principal: 833.33, interest: 500 },
          { principal: 833.34, interest: 498.6 },
        ],
        2,
        "MONTHLY",
      ).type,
    ).toBe("LINEAR");
  });

  it("does not hold a sample two cents off", () => {
    expect(
      detectMortgageType(
        [
          { principal: 0, interest: 500 },
          { principal: 0.02, interest: 500 },
        ],
        2,
        "MONTHLY",
      ),
    ).toEqual({ type: null, confidence: "low", reason: "NO_RULE_FITS" });
  });

  it("refuses an installment that falls and then rises again", () => {
    expect(
      detectMortgageType(
        [
          { principal: 833.33, interest: 500 },
          { principal: 833.33, interest: 498.61 },
          { principal: 833.33, interest: 510 },
        ],
        2,
        "MONTHLY",
      ).reason,
    ).toBe("NO_RULE_FITS");
  });
});
