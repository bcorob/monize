import {
  BaselinePosition,
  LATE_PRICE_TOLERANCE_DAYS,
  PriceObservation,
  latePriceAdjustment,
  parseBaselinePositions,
  snapshotPositions,
} from "./portfolio-price-freshness.util";

/** The baseline was captured on this Friday. */
const BASELINE = "2026-09-11";

const position = (over: Partial<BaselinePosition> = {}): BaselinePosition => ({
  securityId: "s1",
  quantity: 10,
  close: 100,
  priceDate: BASELINE,
  currency: "USD",
  ...over,
});

const latest =
  (map: Record<string, PriceObservation>) =>
  (id: string): PriceObservation | null =>
    map[id] ?? null;

const usd = (currency: string): number | null =>
  currency === "USD" ? 1 : null;

describe("latePriceAdjustment", () => {
  it("counts nothing for a close struck on the baseline date", () => {
    const result = latePriceAdjustment(
      [position()],
      BASELINE,
      latest({ s1: { close: 120, date: "2026-09-14" } }),
      usd,
    );
    expect(result).toEqual({
      complete: true,
      total: 0,
      items: [],
      missing: [],
    });
  });

  it("counts nothing for a close inside the tolerance (a feed a session behind)", () => {
    // A Monday baseline whose latest close is the previous Thursday is four
    // calendar days old: the fund publishes late, and its moves are the
    // period's own rather than a catch-up.
    const monday = "2026-09-14";
    const thursday = "2026-09-10";
    expect(LATE_PRICE_TOLERANCE_DAYS).toBe(4);
    const result = latePriceAdjustment(
      [position({ priceDate: thursday })],
      monday,
      latest({ s1: { close: 130, date: "2026-09-14" } }),
      usd,
    );
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("restates a close carried from before the tolerance once its new close arrives", () => {
    // Issue #1391's 94% component: priced in June, repriced now. The jump is
    // 10 x (130 - 100) = 300, removed from the movement and named.
    const result = latePriceAdjustment(
      [position({ priceDate: "2026-06-30" })],
      BASELINE,
      latest({ s1: { close: 130, date: "2026-09-14" } }),
      usd,
    );
    expect(result).toEqual({
      complete: true,
      total: 300,
      items: [
        {
          securityId: "s1",
          fromDate: "2026-06-30",
          toDate: "2026-09-14",
          value: 300,
        },
      ],
      missing: [],
    });
  });

  it("does nothing while a carried close is still the latest (#1435)", () => {
    // A hand-priced holding with no new price contributes the same close to
    // both ends; it neither restates the baseline nor blocks the run.
    const result = latePriceAdjustment(
      [position({ priceDate: "2026-06-30" })],
      BASELINE,
      latest({ s1: { close: 100, date: "2026-06-30" } }),
      usd,
    );
    expect(result).toEqual({
      complete: true,
      total: 0,
      items: [],
      missing: [],
    });
  });

  it("treats a corrected close on the same date as a late price too", () => {
    const result = latePriceAdjustment(
      [position({ priceDate: "2026-06-30" })],
      BASELINE,
      latest({ s1: { close: 90, date: "2026-06-30" } }),
      usd,
    );
    expect(result.total).toBe(-100);
  });

  it("values the jump at today's rate into the reporting currency", () => {
    const result = latePriceAdjustment(
      [position({ priceDate: "2026-06-30", currency: "EUR" })],
      BASELINE,
      latest({ s1: { close: 130, date: "2026-09-14" } }),
      (currency) => (currency === "EUR" ? 1.1 : null),
    );
    expect(result.total).toBe(330);
  });

  it("reports a late close it cannot convert, rather than counting it as zero", () => {
    const result = latePriceAdjustment(
      [position({ priceDate: "2026-06-30", currency: "JPY" })],
      BASELINE,
      latest({ s1: { close: 130, date: "2026-09-14" } }),
      usd,
    );
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["s1"]);
  });

  it("reports a late position whose observations are gone", () => {
    const result = latePriceAdjustment(
      [position({ priceDate: "2026-06-30" })],
      BASELINE,
      latest({}),
      usd,
    );
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["s1"]);
  });

  it("sums several late closes without float drift", () => {
    const result = latePriceAdjustment(
      [
        position({ securityId: "a", priceDate: "2026-06-30", quantity: 1 }),
        position({ securityId: "b", priceDate: "2026-06-30", quantity: 1 }),
      ],
      BASELINE,
      latest({
        a: { close: 100.1, date: "2026-09-14" },
        b: { close: 100.2, date: "2026-09-14" },
      }),
      usd,
    );
    expect(result.total).toBe(0.3);
  });
});

describe("snapshotPositions", () => {
  it("sums one security across accounts and records the close that priced it", () => {
    const snapshot = snapshotPositions(
      [
        { securityId: "b", currencyCode: "USD", quantity: 5 },
        { securityId: "a", currencyCode: "EUR", quantity: 2 },
        { securityId: "b", currencyCode: "USD", quantity: 3 },
      ],
      latest({
        a: { close: 50, date: "2026-09-11" },
        b: { close: 10, date: "2026-06-30" },
      }),
    );
    expect(snapshot).toEqual([
      {
        securityId: "a",
        quantity: 2,
        close: 50,
        priceDate: "2026-09-11",
        currency: "EUR",
      },
      {
        securityId: "b",
        quantity: 8,
        close: 10,
        priceDate: "2026-06-30",
        currency: "USD",
      },
    ]);
  });

  it("leaves out a position closed to zero", () => {
    expect(
      snapshotPositions(
        [
          { securityId: "a", currencyCode: "USD", quantity: 5 },
          { securityId: "a", currencyCode: "USD", quantity: -5 },
        ],
        latest({}),
      ),
    ).toEqual([]);
  });

  it("refuses to record a held position it has no close for", () => {
    expect(
      snapshotPositions(
        [{ securityId: "a", currencyCode: "USD", quantity: 5 }],
        latest({}),
      ),
    ).toBeNull();
  });
});

describe("parseBaselinePositions", () => {
  it("reads back what snapshotPositions writes, as an object or as JSON text", () => {
    const stored = [position()];
    expect(parseBaselinePositions(stored)).toEqual(stored);
    expect(parseBaselinePositions(JSON.stringify(stored))).toEqual(stored);
    expect(parseBaselinePositions([])).toEqual([]);
  });

  it("treats an absent or malformed snapshot as none", () => {
    expect(parseBaselinePositions(null)).toBeNull();
    expect(parseBaselinePositions("not json")).toBeNull();
    expect(parseBaselinePositions({})).toBeNull();
    expect(
      parseBaselinePositions([{ ...position(), priceDate: "yesterday" }]),
    ).toBeNull();
    expect(
      parseBaselinePositions([{ ...position(), close: "100" }]),
    ).toBeNull();
  });
});
