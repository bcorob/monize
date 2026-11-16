import {
  BOUNDARY_LAG_DAYS,
  addMonthsUtc,
  cadenceMonths,
  evaluate,
  historyAction,
  momentumSnapshot,
  parseYmd,
  periodFor,
  priceAsOf,
  rankEquities,
  recentPeriods,
  trailingReturnPercent,
  PricePoint,
} from "./gem-momentum.util";

const series = (points: Array<[string, number]>): PricePoint[] =>
  points.map(([date, close]) => ({ date, close }));

/** ISO date `days` before `date`, for pinning the boundary-lag rule. */
const ymdBefore = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** ISO date `days` after `date`. */
const ymdAfter = (date: string, days: number): string => ymdBefore(date, -days);

/**
 * The observation that proves a boundary has been reached, at a price no
 * assertion uses.
 *
 * A span is settled only once the series holds a close dated at or after its
 * far boundary -- otherwise "the market was shut that day" is indistinguishable
 * from "the close is not fetched yet". A live series always has one, because
 * the quote job keeps adding closes; a fixture that stops dead on the boundary
 * describes a series no running system produces, so it gets this marker rather
 * than an exemption.
 */
const settled = (boundary: string): [string, number] => [
  ymdAfter(boundary, 1),
  999,
];

describe("gem-momentum.util", () => {
  describe("date helpers", () => {
    it("parses a date-only string as UTC midnight", () => {
      expect(parseYmd("2025-08-01").toISOString()).toBe(
        "2025-08-01T00:00:00.000Z",
      );
    });

    it("clamps a month shift to the target month's last day", () => {
      expect(addMonthsUtc(parseYmd("2025-03-31"), -1).toISOString()).toContain(
        "2025-02-28",
      );
      expect(addMonthsUtc(parseYmd("2024-01-31"), 1).toISOString()).toContain(
        "2024-02-29",
      );
    });

    it("maps cadence to a month step", () => {
      expect(cadenceMonths("MONTHLY")).toBe(1);
      expect(cadenceMonths("QUARTERLY")).toBe(3);
    });
  });

  describe("periodFor", () => {
    it("decides a monthly period on the last day of the previous month", () => {
      expect(periodFor("2025-08-14", "MONTHLY")).toEqual({
        evaluatedOn: "2025-07-31",
        effectiveFrom: "2025-08-01",
      });
    });

    it("aligns a quarterly period to the calendar quarter", () => {
      expect(periodFor("2025-08-14", "QUARTERLY")).toEqual({
        evaluatedOn: "2025-06-30",
        effectiveFrom: "2025-07-01",
      });
      expect(periodFor("2025-01-02", "QUARTERLY")).toEqual({
        evaluatedOn: "2024-12-31",
        effectiveFrom: "2025-01-01",
      });
    });
  });

  describe("recentPeriods", () => {
    it("returns the requested number of periods, oldest first", () => {
      const periods = recentPeriods("2025-08-14", "MONTHLY", 3);
      expect(periods.map((p) => p.effectiveFrom)).toEqual([
        "2025-06-01",
        "2025-07-01",
        "2025-08-01",
      ]);
      expect(periods.map((p) => p.evaluatedOn)).toEqual([
        "2025-05-31",
        "2025-06-30",
        "2025-07-31",
      ]);
    });

    it("steps by quarters for a quarterly strategy", () => {
      expect(
        recentPeriods("2025-08-14", "QUARTERLY", 2).map((p) => p.effectiveFrom),
      ).toEqual(["2025-04-01", "2025-07-01"]);
    });

    it("returns nothing for a non-positive count", () => {
      expect(recentPeriods("2025-08-14", "MONTHLY", 0)).toEqual([]);
    });
  });

  describe("priceAsOf", () => {
    const prices = series([
      ["2025-01-02", 100],
      ["2025-01-03", 101],
      ["2025-01-06", 103],
    ]);

    it("returns the close on the date when one exists", () => {
      expect(priceAsOf(prices, "2025-01-03")).toBe(101);
    });

    it("falls back to the most recent earlier close", () => {
      expect(priceAsOf(prices, "2025-01-05")).toBe(101);
      expect(priceAsOf(prices, "2025-02-01")).toBe(103);
    });

    it("returns null before the series starts", () => {
      expect(priceAsOf(prices, "2024-12-31")).toBeNull();
      expect(priceAsOf([], "2025-01-03")).toBeNull();
    });
  });

  describe("trailingReturnPercent", () => {
    const prices = series([
      ["2024-07-31", 100],
      ["2025-07-31", 115.42],
    ]);

    it("computes a total return in percent", () => {
      expect(trailingReturnPercent(prices, "2024-07-31", "2025-07-31")).toBe(
        15.42,
      );
    });

    it("prices a boundary the market was shut on with a close near it", () => {
      // The last day of a month is regularly a weekend, so the close that
      // stands for it is a day or two earlier. Inside a fortnight it counts.
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-26", 100],
            ["2025-07-29", 115.42],
            settled("2025-07-31"),
          ]),
          "2024-07-31",
          "2025-07-31",
        ),
      ).toBe(15.42);
    });

    it("defers a boundary the series has not reached yet", () => {
      // The other half of the lag rule. A close two days before the boundary
      // can stand for it, but only once something dated at or after the
      // boundary proves the market was shut on it rather than that the quote
      // job has not run. Opening the report at 09:00 on 1 August, before 31
      // July's close is stored, must not answer July from 30 July's close --
      // the signal path materializes that answer permanently.
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 100],
            ["2025-07-30", 115.42],
          ]),
          "2024-07-31",
          "2025-07-31",
        ),
      ).toBeNull();

      // ...and answers it as soon as the boundary is behind the series, still
      // from the close that stands for it rather than from the newer one.
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 100],
            ["2025-07-30", 115.42],
            ["2025-08-01", 400],
          ]),
          "2024-07-31",
          "2025-07-31",
        ),
      ).toBe(15.42);
    });

    it("refuses a zero close at either boundary", () => {
      // The DTO admits `@Min(0)`, so a typo can store a zero. Read as a known
      // price it becomes a -100% period at the exit and an Infinity at the
      // entry; both are unknown instead.
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 100],
            ["2025-07-30", 0],
            settled("2025-07-31"),
          ]),
          "2024-07-31",
          "2025-07-31",
        ),
      ).toBeNull();
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 0],
            ["2025-07-30", 100],
            settled("2025-07-31"),
          ]),
          "2024-07-31",
          "2025-07-31",
        ),
      ).toBeNull();
    });

    it("draws the line at BOUNDARY_LAG_DAYS, to the day", () => {
      // The rule the whole report hangs on, pinned from both sides so a change
      // to the constant fails here rather than quietly re-pricing history: a
      // close exactly `BOUNDARY_LAG_DAYS` before the boundary stands for it,
      // one day older does not.
      const boundary = "2025-07-31";
      const justInside = ymdBefore(boundary, BOUNDARY_LAG_DAYS);
      const justOutside = ymdBefore(boundary, BOUNDARY_LAG_DAYS + 1);

      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 100],
            [justInside, 115.42],
            settled(boundary),
          ]),
          "2024-07-31",
          boundary,
        ),
      ).toBe(15.42);
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 100],
            [justOutside, 115.42],
            settled(boundary),
          ]),
          "2024-07-31",
          boundary,
        ),
      ).toBeNull();
    });

    it("refuses a boundary whose nearest close is months old", () => {
      // A security last quoted in March answers a lookup for 31 July and one
      // for 31 July a year later with the same number: a trailing return of
      // exactly zero, computed from a single observation, indistinguishable
      // from a market that went nowhere. That figure decides which instrument
      // the report tells the user to buy, so it must be unknown instead.
      const stale = series([
        ["2024-03-15", 100],
        ["2025-07-29", 115.42],
      ]);
      expect(
        trailingReturnPercent(stale, "2024-07-31", "2025-07-31"),
      ).toBeNull();

      const stopped = series([["2024-07-31", 100]]);
      expect(
        trailingReturnPercent(stopped, "2024-07-31", "2025-07-31"),
      ).toBeNull();
    });

    it("is unknown when a price is missing or the base is not positive", () => {
      expect(
        trailingReturnPercent(prices, "2020-01-01", "2025-07-31"),
      ).toBeNull();
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 0],
            ["2025-07-31", 10],
          ]),
          "2024-07-31",
          "2025-07-31",
        ),
      ).toBeNull();
    });
  });

  describe("momentumSnapshot", () => {
    // A26-M27: the roles of one evaluation are priced at one session. The
    // ex-US feed had no closes 2026-09-19..09-30 (an outage), so its newest
    // close on or before the boundary is 09-18 while the other roles hold the
    // boundary's own close; it resumes on 10-01, which used to read as
    // "settled".
    const gapAtBoundary = {
      US_EQUITY: series([
        ["2025-09-30", 100],
        ["2026-09-30", 110],
        ["2026-10-01", 110],
      ]),
      EX_US_EQUITY: series([
        ["2025-09-30", 100],
        ["2026-09-18", 104],
        ["2026-10-01", 113],
      ]),
      SAFE: series([
        ["2025-09-30", 100],
        ["2026-09-30", 103],
        ["2026-10-01", 103],
      ]),
    };

    it("does not price a role across a feed gap at the boundary", () => {
      const m = momentumSnapshot(gapAtBoundary, "2026-09-30", 12);

      expect(m.EX_US_EQUITY).toBeNull();
      expect(m.US_EQUITY).toBe(10);
      expect(m.SAFE).toBe(3);
      // RISK-ON needs every mapped market's momentum: the period defers
      // instead of recommending US equity off a 12-day-old ex-US close.
      expect(evaluate(m, ["US_EQUITY", "EX_US_EQUITY", "SAFE"])).toBeNull();
    });

    it("still prices a role whose market was shut a day or two at the boundary", () => {
      const m = momentumSnapshot(
        {
          ...gapAtBoundary,
          EX_US_EQUITY: series([
            ["2025-09-30", 100],
            ["2026-09-28", 112],
            ["2026-10-01", 113],
          ]),
        },
        "2026-09-30",
        12,
      );

      expect(m.EX_US_EQUITY).toBe(12);
    });

    it("computes each role's lookback return and marks gaps unknown", () => {
      const snapshot = momentumSnapshot(
        {
          US_EQUITY: series([
            ["2024-07-31", 100],
            ["2025-07-31", 115],
          ]),
          SAFE: series([
            ["2024-07-31", 100],
            ["2025-07-31", 104],
          ]),
          EM_EQUITY: series([["2025-07-31", 50]]), // history too short
          EX_US_EQUITY: [],
        },
        "2025-07-31",
        12,
      );
      expect(snapshot.US_EQUITY).toBe(15);
      expect(snapshot.SAFE).toBe(4);
      expect(snapshot.EM_EQUITY).toBeNull();
      expect(snapshot.EX_US_EQUITY).toBeNull();
    });

    it("reports a role whose quotes stopped as unknown, not as flat", () => {
      // A delisted or simply unfetched instrument keeps answering both ends of
      // the window from its last close. Momentum of zero is a real reading a
      // real market can produce, so nothing downstream can tell the two apart
      // -- and here it would hand a RISK-OFF to a safe asset nobody is pricing
      // or drop the strongest equity market out of the ranking.
      const snapshot = momentumSnapshot(
        {
          US_EQUITY: series([
            ["2024-07-31", 100],
            ["2025-07-31", 115],
          ]),
          SAFE: series([["2024-02-29", 104]]), // last quote 17 months old
        },
        "2025-07-31",
        12,
      );
      expect(snapshot.US_EQUITY).toBe(15);
      expect(snapshot.SAFE).toBeNull();
      // And the absolute test has no benchmark, so no signal comes out of it.
      expect(evaluate(snapshot, ["US_EQUITY", "SAFE"])).toBeNull();
    });

    it("is why the series must be adjusted closes: a split flips the signal", () => {
      // Not a test of this function -- it is a test of what it is fed, which
      // is `GemPriceService.loadSeries`. On raw closes a 4-for-1 split turns a
      // 20% year into a 70% collapse, and the absolute-momentum test hands the
      // whole allocation to the safe asset on the strength of a corporate
      // action. The adjusted series restates the pre-split close, so the same
      // year reads as the 20% it was.
      const raw = momentumSnapshot(
        {
          US_EQUITY: series([
            ["2024-07-31", 400], // pre-split price, unadjusted
            ["2025-07-31", 120], // 4-for-1 split plus a 20% year
          ]),
          SAFE: series([
            ["2024-07-31", 100],
            ["2025-07-31", 104],
          ]),
        },
        "2025-07-31",
        12,
      );
      expect(raw.US_EQUITY).toBe(-70);
      expect(evaluate(raw, ["US_EQUITY", "SAFE"])?.state).toBe("RISK_OFF");

      const adjusted = momentumSnapshot(
        {
          US_EQUITY: series([
            ["2024-07-31", 100], // 400 restated for the split
            ["2025-07-31", 120],
          ]),
          SAFE: series([
            ["2024-07-31", 100],
            ["2025-07-31", 104],
          ]),
        },
        "2025-07-31",
        12,
      );
      expect(adjusted.US_EQUITY).toBe(20);
      expect(evaluate(adjusted, ["US_EQUITY", "SAFE"])?.state).toBe("RISK_ON");
    });

    it("is why the series must be adjusted closes: a distribution is return", () => {
      // A bond ETF paying 4% and flat in price is the benchmark equities are
      // measured against. Ignore the distribution and it reads as 0%, which
      // makes every mediocre equity year look like a win.
      const priceOnly = momentumSnapshot(
        {
          SAFE: series([
            ["2024-07-31", 100],
            ["2025-07-31", 100],
          ]),
        },
        "2025-07-31",
        12,
      );
      expect(priceOnly.SAFE).toBe(0);

      const totalReturn = momentumSnapshot(
        {
          SAFE: series([
            ["2024-07-31", 96.15], // adjusted back for the distributions paid
            ["2025-07-31", 100],
          ]),
        },
        "2025-07-31",
        12,
      );
      expect(totalReturn.SAFE).toBeCloseTo(4, 1);
    });
  });

  describe("rankEquities", () => {
    it("ranks known equity momentum strongest first and drops unknowns", () => {
      const ranked = rankEquities({
        US_EQUITY: 15.42,
        EX_US_EQUITY: 8.31,
        EM_EQUITY: 29.87,
        SAFE: 4.21,
      });
      expect(ranked.map((entry) => entry.role)).toEqual([
        "EM_EQUITY",
        "US_EQUITY",
        "EX_US_EQUITY",
      ]);
    });

    it("keeps only eligible roles and breaks ties on canonical order", () => {
      const ranked = rankEquities(
        { US_EQUITY: 5, EX_US_EQUITY: 5, EM_EQUITY: null },
        ["US_EQUITY", "EX_US_EQUITY"],
      );
      expect(ranked.map((entry) => entry.role)).toEqual([
        "US_EQUITY",
        "EX_US_EQUITY",
      ]);
    });
  });

  describe("evaluate", () => {
    describe("when an assigned equity market has no momentum", () => {
      it("refuses to name a winner from the markets that did report", () => {
        // The bug: EM is assigned but unmeasurable, so it was silently dropped
        // and the report recommended switching into the best of the other two
        // -- a concrete monetary operation decided by which market happened to
        // have data. The market that was missing could have won.
        expect(
          evaluate(
            {
              US_EQUITY: 15.42,
              EX_US_EQUITY: 8.31,
              EM_EQUITY: null,
              SAFE: 4.21,
            },
            ["US_EQUITY", "EX_US_EQUITY", "EM_EQUITY", "SAFE"],
          ),
        ).toBeNull();
      });

      it("still evaluates RISK-OFF, which that market cannot change", () => {
        // The absolute test is the US leg against the benchmark. Equities have
        // lost it, so the allocation is the safe asset whatever emerging
        // markets did -- refusing to answer here would throw away a signal
        // that is not in doubt.
        expect(
          evaluate(
            {
              US_EQUITY: 1.2,
              EX_US_EQUITY: 8.31,
              EM_EQUITY: null,
              SAFE: 4.21,
            },
            ["US_EQUITY", "EX_US_EQUITY", "EM_EQUITY", "SAFE"],
          ),
        ).toMatchObject({ state: "RISK_OFF", targetRole: "SAFE" });
      });

      it("does not block on a market the user never assigned", () => {
        // A deliberate two-asset variant -- one equity leg and a safe asset --
        // is a configuration, not a gap, and evaluates as it always did.
        expect(
          evaluate({ US_EQUITY: 15.42, SAFE: 4.21 }, ["US_EQUITY", "SAFE"]),
        ).toMatchObject({ state: "RISK_ON", targetRole: "US_EQUITY" });
      });
    });

    it("is RISK_ON with the strongest equity market as target", () => {
      const outcome = evaluate({
        US_EQUITY: 15.42,
        EX_US_EQUITY: 8.31,
        EM_EQUITY: 29.87,
        SAFE: 4.21,
      });
      expect(outcome).toMatchObject({
        state: "RISK_ON",
        targetRole: "EM_EQUITY",
        spreadPp: 11.21,
        leadPp: 14.45,
      });
    });

    it("is RISK_OFF with the safe asset as target when equities lose", () => {
      const outcome = evaluate({
        US_EQUITY: -1.28,
        EX_US_EQUITY: 1.45,
        EM_EQUITY: 3.12,
        SAFE: 3.76,
      });
      expect(outcome).toMatchObject({
        state: "RISK_OFF",
        targetRole: "SAFE",
        spreadPp: -5.04,
        leadPp: null,
      });
      // The ranking is still computed -- it just does not drive the allocation.
      expect(outcome?.ranking).toHaveLength(3);
    });

    it("treats an equal reading as RISK_OFF (equities must win outright)", () => {
      expect(evaluate({ US_EQUITY: 4, SAFE: 4 })?.state).toBe("RISK_OFF");
    });

    it("cannot evaluate without both absolute-test inputs", () => {
      expect(evaluate({ US_EQUITY: 10, SAFE: null })).toBeNull();
      expect(evaluate({ US_EQUITY: null, SAFE: 2 })).toBeNull();
      expect(evaluate({})).toBeNull();
    });

    it("has no target while RISK_ON with no eligible equity instrument", () => {
      const outcome = evaluate({ US_EQUITY: 10, SAFE: 2 }, []);
      expect(outcome).toMatchObject({ state: "RISK_ON", targetRole: null });
      expect(outcome?.leadPp).toBeNull();
    });

    it("measures against the risk-free leg when one is assigned", () => {
      // Equities beat the bond fund but not T-bills: the two roles disagree, so
      // which one is the yardstick decides the signal.
      const momentum = { US_EQUITY: 3, SAFE: 1, RISK_FREE: 5 };
      const withRiskFree = evaluate(momentum, [
        "US_EQUITY",
        "SAFE",
        "RISK_FREE",
      ]);
      expect(withRiskFree).toMatchObject({
        state: "RISK_OFF",
        benchmarkRole: "RISK_FREE",
        spreadPp: -2,
        // RISK-OFF still moves into the safe asset, not into the yardstick.
        targetRole: "SAFE",
      });
    });

    it("falls back to the safe asset when no risk-free leg is assigned", () => {
      const outcome = evaluate({ US_EQUITY: 3, SAFE: 1, RISK_FREE: 5 }, [
        "US_EQUITY",
        "SAFE",
      ]);
      // The risk-free momentum is present but unmapped, so it is not consulted:
      // a configuration made before the split evaluates exactly as it used to.
      expect(outcome).toMatchObject({
        state: "RISK_ON",
        benchmarkRole: "SAFE",
        spreadPp: 2,
      });
    });

    it("holds the risk-free leg when it is the only defensive instrument", () => {
      const outcome = evaluate({ US_EQUITY: -4, RISK_FREE: 2 }, [
        "US_EQUITY",
        "RISK_FREE",
      ]);
      expect(outcome).toMatchObject({
        state: "RISK_OFF",
        benchmarkRole: "RISK_FREE",
        targetRole: "RISK_FREE",
      });
    });

    it("cannot evaluate when the assigned risk-free leg has no momentum", () => {
      // SAFE has a reading, but it is not the benchmark any more -- guessing
      // with it would report a spread the strategy did not measure.
      expect(
        evaluate({ US_EQUITY: 10, SAFE: 2, RISK_FREE: null }, [
          "US_EQUITY",
          "SAFE",
          "RISK_FREE",
        ]),
      ).toBeNull();
    });
  });

  describe("historyAction", () => {
    it("labels the first allocation, a switch and a hold", () => {
      expect(historyAction("EM_EQUITY", null)).toBe("BUY");
      expect(historyAction("EM_EQUITY", "US_EQUITY")).toBe("SWITCH");
      expect(historyAction("EM_EQUITY", "EM_EQUITY")).toBe("HOLD");
      expect(historyAction(null, "EM_EQUITY")).toBe("HOLD");
    });
  });
});
