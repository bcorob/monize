import {
  PeriodBoundaryValue,
  decidePeriodResult,
} from "./portfolio-period-result.util";

/** A boundary day with every component known, unless a case says otherwise. */
const day = (
  date: string,
  value: number,
  overrides: Partial<PeriodBoundaryValue> = {},
): PeriodBoundaryValue => ({
  date,
  value,
  fxComplete: true,
  pricesComplete: true,
  cashComplete: true,
  missingRatePairs: [],
  unpricedSecurityIds: [],
  unknownCashAccountIds: [],
  ...overrides,
});

const complete = (value: number) => ({
  complete: true,
  value,
  missingPairs: [] as string[],
});

describe("decidePeriodResult", () => {
  /**
   * The issue's reproduction (#1392). A price that never moves, two deposits of
   * 10,000 each, the second inside the window. `last - first` says the portfolio
   * gained 10,000 and returned 100 per cent; the market did nothing.
   *
   * This is the adversarial case of the formula: a naive difference passes every
   * other case in this file and fails exactly this one.
   */
  it("reports a deposit as a flow and not as a gain", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-09-17", 20_000),
      flow: complete(10_000),
    });

    expect(decision.valueChange).toBe(10_000);
    expect(decision.netExternalFlows).toBe(10_000);
    expect(decision.investmentResult).toBe(0);
    expect(decision.returnPercent).toBe(0);
    expect(decision.returnMethod).toBe("simple");
    expect(decision.complete).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it("keeps the market's part of a period that also took a deposit", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-09-17", 22_000),
      flow: complete(10_000),
    });

    expect(decision.valueChange).toBe(12_000);
    expect(decision.investmentResult).toBe(2_000);
    expect(decision.returnPercent).toBe(20);
  });

  it("nets a withdrawal out of the value change", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-06-30", 7_000),
      flow: complete(-3_000),
    });

    expect(decision.valueChange).toBe(-3_000);
    expect(decision.netExternalFlows).toBe(-3_000);
    expect(decision.investmentResult).toBe(0);
    expect(decision.returnPercent).toBe(0);
  });

  /**
   * Cash moved between two accounts that are both in the scope never crossed the
   * boundary, so `loadExternalFlowSubtotals` returns nothing for it and the
   * period's flow is a known zero -- not unknown, and not the moved amount.
   */
  it("treats a transfer inside the scope as no flow at all", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-06-30", 10_500),
      flow: complete(0),
    });

    expect(decision.netExternalFlows).toBe(0);
    expect(decision.investmentResult).toBe(500);
    expect(decision.returnPercent).toBe(5);
  });

  it("withholds the flow and the result when a flow day has no rate", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-06-30", 21_000),
      flow: { complete: false, value: 9_000, missingPairs: ["EUR->USD"] },
    });

    expect(decision.netExternalFlows).toBeNull();
    expect(decision.investmentResult).toBeNull();
    expect(decision.returnPercent).toBeNull();
    // The part that did convert stays reportable, under its own name only.
    expect(decision.knownFlowSubtotal).toBe(9_000);
    // The value change is the one figure the missing rate does not touch.
    expect(decision.valueChange).toBe(11_000);
    expect(decision.missingRatePairs).toEqual(["EUR->USD"]);
    expect(decision.reasons).toEqual(["missingRatePairs"]);
    expect(decision.complete).toBe(false);
  });

  it.each([
    ["first", "start"],
    ["last", "end"],
  ])(
    "withholds the value change when the %s point is a subtotal",
    (_label, which) => {
      const incomplete = day("2026-01-02", 10_000, {
        pricesComplete: false,
        unpricedSecurityIds: ["sec-1"],
      });
      const decision = decidePeriodResult({
        start: which === "start" ? incomplete : day("2026-01-02", 10_000),
        end: which === "end" ? incomplete : day("2026-06-30", 20_000),
        flow: complete(10_000),
      });

      expect(decision.valueChange).toBeNull();
      expect(decision.investmentResult).toBeNull();
      expect(decision.returnPercent).toBeNull();
      expect(decision.reasons).toEqual(["incompletePrices"]);
      expect(decision.unpricedSecurityIds).toEqual(["sec-1"]);
      // The flow itself is still known, and says so.
      expect(decision.netExternalFlows).toBe(10_000);
    },
  );

  it("names every cause a boundary day carries", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000, {
        cashComplete: false,
        unknownCashAccountIds: ["acct-2"],
        fxComplete: false,
        missingRatePairs: ["CAD->USD"],
      }),
      end: day("2026-06-30", 20_000),
      flow: complete(0),
    });

    expect(decision.reasons.sort()).toEqual([
      "incompleteCash",
      "missingRatePairs",
    ]);
    expect(decision.unknownCashAccountIds).toEqual(["acct-2"]);
    expect(decision.missingRatePairs).toEqual(["CAD->USD"]);
  });

  /**
   * A cash account with no balance for a boundary day makes that day a
   * subtotal on its own, with neither a price nor a rate missing. Asserted
   * alone because the case that names every cause carries three false bits at
   * once, and would still read as incomplete with this one ignored.
   */
  it("withholds the value change when only a boundary's cash is incomplete", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000, {
        cashComplete: false,
        unknownCashAccountIds: ["acct-2"],
      }),
      end: day("2026-06-30", 20_000),
      flow: complete(10_000),
    });

    expect(decision.valueChange).toBeNull();
    expect(decision.investmentResult).toBeNull();
    expect(decision.startValue).toBeNull();
    expect(decision.reasons).toEqual(["incompleteCash"]);
    expect(decision.unknownCashAccountIds).toEqual(["acct-2"]);
  });

  it("reads an absent cashComplete as no information, not as incomplete", () => {
    const decision = decidePeriodResult({
      start: {
        date: "2026-01-02",
        value: 10_000,
        fxComplete: true,
        pricesComplete: true,
      },
      end: {
        date: "2026-06-30",
        value: 11_000,
        fxComplete: true,
        pricesComplete: true,
      },
      flow: complete(0),
    });

    expect(decision.valueChange).toBe(1_000);
    expect(decision.complete).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  /**
   * A trade settled outside the valued cash accounts raised the value with no
   * flow to subtract, so the difference is not the market's (#1389). Both
   * measured figures survive; only their difference is withheld.
   */
  it("withholds the result when a trade settled outside the valued cash", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-06-30", 20_000),
      flow: complete(0),
      unmeasuredFlows: {
        externallySettledTrades: 1,
        externalShareTransfers: 0,
        mixedSplitParents: 0,
      },
    });

    expect(decision.valueChange).toBe(10_000);
    expect(decision.netExternalFlows).toBe(0);
    expect(decision.investmentResult).toBeNull();
    expect(decision.returnPercent).toBeNull();
    expect(decision.complete).toBe(false);
    expect(decision.reasons).toEqual(["externallySettledTrade"]);
  });

  it("withholds the result when a mixed split parent is in the window", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-06-30", 20_000),
      flow: complete(0),
      unmeasuredFlows: {
        externallySettledTrades: 0,
        externalShareTransfers: 0,
        mixedSplitParents: 3,
      },
    });

    expect(decision.investmentResult).toBeNull();
    expect(decision.reasons).toEqual(["mixedSplit"]);
  });

  it("counts of zero are a measured period, not an unknown one", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 10_000),
      end: day("2026-06-30", 11_000),
      flow: complete(0),
      unmeasuredFlows: {
        externallySettledTrades: 0,
        externalShareTransfers: 0,
        mixedSplitParents: 0,
      },
    });

    expect(decision.investmentResult).toBe(1_000);
    expect(decision.complete).toBe(true);
  });

  it("reads an absent completeness bit as no information, not as incomplete", () => {
    const decision = decidePeriodResult({
      start: { date: "2026-01-02", value: 10_000 },
      end: { date: "2026-06-30", value: 11_000 },
      flow: complete(0),
    });

    expect(decision.valueChange).toBe(1_000);
    expect(decision.complete).toBe(true);
  });

  it("reports the money but no percentage from a zero start", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 0),
      end: day("2026-06-30", 5_000),
      flow: complete(5_000),
    });

    expect(decision.valueChange).toBe(5_000);
    expect(decision.netExternalFlows).toBe(5_000);
    expect(decision.investmentResult).toBe(0);
    expect(decision.returnPercent).toBeNull();
    expect(decision.reasons).toEqual(["zeroStart"]);
    expect(decision.complete).toBe(false);
  });

  it("refuses a percentage over a negative starting value", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", -500),
      end: day("2026-06-30", -400),
      flow: complete(0),
    });

    expect(decision.investmentResult).toBe(100);
    expect(decision.returnPercent).toBeNull();
    expect(decision.reasons).toEqual(["zeroStart"]);
  });

  it("knows nothing about a window the scope produced no value for", () => {
    const decision = decidePeriodResult({
      start: null,
      end: null,
      flow: complete(0),
    });

    expect(decision.startValue).toBeNull();
    expect(decision.valueChange).toBeNull();
    expect(decision.investmentResult).toBeNull();
    expect(decision.reasons).toEqual(["noValueSeries"]);
  });

  it("rounds the difference once, at the storage precision", () => {
    const decision = decidePeriodResult({
      start: day("2026-01-02", 647.67),
      end: day("2026-06-30", 949.37),
      flow: complete(301.7),
    });

    expect(decision.valueChange).toBe(301.7);
    expect(decision.investmentResult).toBe(0);
  });
});
