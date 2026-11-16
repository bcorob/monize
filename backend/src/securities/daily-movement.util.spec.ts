import {
  DailyMovementInput,
  decideDailyMovement,
  valueReasons,
} from "./daily-movement.util";

const complete = (value: number) => ({ value, complete: true, reasons: [] });

const base: DailyMovementInput = {
  isTradingDay: true,
  today: complete(101_200),
  previous: complete(100_000),
  flow: { complete: true, value: 1000 },
};

describe("decideDailyMovement", () => {
  /**
   * Truth table B of `docs/specs/calendar-view.md`, row by row. The
   * client renders from `complete` and `reasons` and re-derives none of this, so
   * this table is the whole policy.
   */
  describe("truth table B", () => {
    it("row 1: not a trading day is BLANK, whatever else is true", () => {
      const decision = decideDailyMovement({ ...base, isTradingDay: false });
      expect(decision).toEqual({
        movement: null,
        movementPercent: null,
        complete: false,
        reasons: ["notTradingDay"],
      });
    });

    it("row 2: everything known gives the percentage (example 3)", () => {
      // MV(09-10) 100,000; MV(09-11) 101,200; a 1,000 deposit that day.
      // 101,200 - 100,000 - 1,000 = +200.00 -> +0.20%.
      expect(decideDailyMovement(base)).toEqual({
        movement: 200,
        movementPercent: 0.2,
        complete: true,
        reasons: [],
      });
    });

    it("row 2: exactly zero is a complete answer, not a missing one", () => {
      const decision = decideDailyMovement({
        ...base,
        today: complete(100_000),
        flow: { complete: true, value: 0 },
      });
      expect(decision.movement).toBe(0);
      expect(decision.movementPercent).toBe(0);
      expect(decision.complete).toBe(true);
    });

    it("row 3: MV(d) incomplete is UNKNOWN, carrying its own causes", () => {
      const decision = decideDailyMovement({
        ...base,
        today: {
          value: 90_000,
          complete: false,
          reasons: ["unpricedHolding", "missingRate"],
        },
      });
      expect(decision.movement).toBeNull();
      expect(decision.complete).toBe(false);
      expect(decision.reasons).toEqual(["unpricedHolding", "missingRate"]);
    });

    it("row 4: MV(d-1) incomplete is UNKNOWN", () => {
      const decision = decideDailyMovement({
        ...base,
        previous: { value: 90_000, complete: false, reasons: ["missingRate"] },
      });
      expect(decision.movement).toBeNull();
      expect(decision.reasons).toEqual(["missingRate"]);
    });

    it("row 4: no day before at all is noPriorValue (example 5's neighbour)", () => {
      const decision = decideDailyMovement({ ...base, previous: null });
      expect(decision.movement).toBeNull();
      expect(decision.reasons).toEqual(["noPriorValue"]);
    });

    it("row 5: an unconvertible flow is UNKNOWN, never treated as zero", () => {
      const decision = decideDailyMovement({
        ...base,
        flow: { complete: false, value: 0 },
      });
      expect(decision.movement).toBeNull();
      expect(decision.movementPercent).toBeNull();
      expect(decision.reasons).toEqual(["flowIncomplete"]);
    });

    it("row 6: a zero baseline has no percentage but a known movement (example 5)", () => {
      const decision = decideDailyMovement({
        ...base,
        today: complete(500),
        previous: complete(0),
        flow: { complete: true, value: 0 },
      });
      // The cell is blank because `complete` is false; the day panel may still
      // show the absolute figure, which is why `movement` survives.
      expect(decision.movementPercent).toBeNull();
      expect(decision.complete).toBe(false);
      expect(decision.reasons).toEqual(["zeroBaseline"]);
      expect(decision.movement).toBe(500);
    });
  });

  describe("the guards are ordered, so the first cause is the one reported", () => {
    it("a non-trading day is blank even when every value is missing", () => {
      expect(
        decideDailyMovement({
          isTradingDay: false,
          today: null,
          previous: null,
          flow: { complete: false, value: 0 },
        }).reasons,
      ).toEqual(["notTradingDay"]);
    });

    it("an incomplete MV(d) is reported before an incomplete flow", () => {
      expect(
        decideDailyMovement({
          ...base,
          today: { value: 1, complete: false, reasons: ["unpricedHolding"] },
          flow: { complete: false, value: 0 },
        }).reasons,
      ).toEqual(["unpricedHolding"]);
    });
  });

  describe("arithmetic", () => {
    it("subtracts the flow, so a deposit is not a gain (example 3)", () => {
      const withoutFlow = decideDailyMovement({
        ...base,
        flow: { complete: true, value: 0 },
      });
      expect(withoutFlow.movement).toBe(1200);
      expect(decideDailyMovement(base).movement).toBe(200);
    });

    it("reports a loss as a negative movement and percentage", () => {
      const decision = decideDailyMovement({
        ...base,
        today: complete(99_000),
        flow: { complete: true, value: 0 },
      });
      expect(decision.movement).toBe(-1000);
      expect(decision.movementPercent).toBe(-1);
    });

    it("rounds the percentage as a ratio, not as money", () => {
      const decision = decideDailyMovement({
        ...base,
        today: complete(100_123.456),
        previous: complete(100_000),
        flow: { complete: true, value: 0 },
      });
      // 123.456 / 100,000 = 0.123456% -> 0.12% at the movement's own precision.
      expect(decision.movementPercent).toBe(0.12);
      // ...while the money keeps its four decimals.
      expect(decision.movement).toBe(123.456);
    });

    it("rounds the delta once, rather than accumulating three 4dp values", () => {
      const decision = decideDailyMovement({
        isTradingDay: true,
        today: complete(0.3),
        previous: complete(0.1),
        flow: { complete: true, value: 0.2 },
      });
      // `=== 0` rather than `toBe(0)`: the subtraction lands on negative zero,
      // which is zero (and serializes as `0`), but which toBe distinguishes.
      expect(decision.movement === 0).toBe(true);
    });

    it("uses a negative baseline's magnitude for the ratio's sign correctly", () => {
      // A net-short portfolio: MV(d-1) is negative, so a rise in value is a
      // negative percentage of it. The arithmetic is reported as it falls out
      // rather than being massaged, because a sign nobody can explain is worse
      // than one that follows the formula.
      const decision = decideDailyMovement({
        isTradingDay: true,
        today: complete(-900),
        previous: complete(-1000),
        flow: { complete: true, value: 0 },
      });
      expect(decision.movement).toBe(100);
      expect(decision.movementPercent).toBe(-10);
    });
  });
});

describe("valueReasons", () => {
  it("names each cause separately, because each has its own repair", () => {
    expect(valueReasons({ fxComplete: true, pricesComplete: true })).toEqual(
      [],
    );
    expect(valueReasons({ fxComplete: true, pricesComplete: false })).toEqual([
      "unpricedHolding",
    ]);
    expect(valueReasons({ fxComplete: false, pricesComplete: true })).toEqual([
      "missingRate",
    ]);
    expect(valueReasons({ fxComplete: false, pricesComplete: false })).toEqual([
      "unpricedHolding",
      "missingRate",
    ]);
    // A cash account that reported no balance for the day is its own cause:
    // the repair is neither a price nor a rate (#1389).
    expect(
      valueReasons({
        fxComplete: true,
        pricesComplete: true,
        cashComplete: false,
      }),
    ).toEqual(["cashIncomplete"]);
  });

  it("reads an absent flag as no information, not as incomplete", () => {
    // An older backend mid-deploy sends neither flag. Reporting a cause it
    // never claimed would withhold every day of the month.
    expect(valueReasons({})).toEqual([]);
  });
});
