import {
  GAP_WINDOW_MAX_DAYS,
  MAX_GAP_WINDOWS,
  MAX_OBSERVATION_GAP_DAYS,
  isSparseRateSeries,
  planRateGapWindows,
  type RateGapWindow,
} from "./rate-gap-plan";

/** Inclusive length of a window, the unit the chunk bound is expressed in. */
function lengthOf(window: RateGapWindow): number {
  return (
    (Date.parse(`${window.end}T00:00:00Z`) -
      Date.parse(`${window.start}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

/** The last calendar day of each month in `[fromYear, toYear]`. */
function monthEnds(fromYear: number, toYear: number): string[] {
  const dates: string[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (let month = 1; month <= 12; month++) {
      // Day 0 of the next month is the last day of this one.
      const last = new Date(Date.UTC(year, month, 0));
      dates.push(last.toISOString().slice(0, 10));
    }
  }
  return dates;
}

describe("planRateGapWindows", () => {
  describe("what counts as a gap", () => {
    it("does not treat a weekend as a gap", () => {
      // Friday's observation answers Saturday, Sunday and Monday, so there is
      // nothing to fetch.
      const plan = planRateGapWindows(
        ["2026-09-04"],
        "2026-09-04",
        "2026-09-07",
      );

      expect(plan.windows).toEqual([]);
      expect(plan.sparseDays).toBe(0);
      expect(plan.unresolvableDays).toBe(0);
    });

    it("does not treat a market's longest ordinary closure as a gap", () => {
      // Christmas Eve to the 2nd of January is nine days, the widest stretch
      // an FX feed goes quiet for without something being wrong. One day
      // inside the bound, deliberately.
      const plan = planRateGapWindows(
        ["2025-12-24", "2026-01-02"],
        "2025-12-24",
        "2026-01-02",
      );

      expect(plan.windows).toEqual([]);
      expect(plan.sparseDays).toBe(0);
    });

    it("plans a month-end-only history, which carry-forward alone calls complete", () => {
      // The defect this bound exists for. Every one of these dates resolves --
      // no two observations are more than 31 days apart, well inside the
      // 45-day carry-forward -- so a planner working on resolvability alone
      // reports nothing to do and the fill stops making progress, while 11
      // months of the year are priced at a rate struck weeks earlier.
      const plan = planRateGapWindows(
        monthEnds(2020, 2020),
        "2020-01-31",
        "2020-12-31",
      );

      expect(plan.unresolvableDays).toBe(0);
      // Eleven holes of roughly 20 days each, between one month end's reach
      // and the next month end.
      expect(plan.sparseDays).toBeGreaterThan(180);
      expect(plan.windows.length).toBeGreaterThan(0);
    });

    it("treats a hole past the carry-forward bound as both sparse and unresolvable", () => {
      // The 20th of April is more than 45 days after the 1st of March, so the
      // days between are answerable by nothing at all -- the stronger of the
      // two failures, and the one a reader is told about.
      const plan = planRateGapWindows(
        ["2026-03-01", "2026-04-20"],
        "2026-03-01",
        "2026-04-20",
      );

      expect(plan.unresolvableDays).toBe(4);
      expect(plan.sparseDays).toBe(39);
      expect(plan.windows).toEqual([
        // Padded back by the boundary lead, so the gap's first day has an
        // observation to carry forward from.
        { start: "2026-02-26", end: "2026-04-19" },
      ]);
    });

    it("plans the whole span when nothing is stored", () => {
      const plan = planRateGapWindows([], "2026-01-01", "2026-01-31");

      expect(plan.unresolvableDays).toBe(31);
      expect(plan.sparseDays).toBe(31);
      expect(plan.windows).toEqual([
        { start: "2025-12-18", end: "2026-01-31" },
      ]);
    });

    it("lets an observation before the span answer the span's first days", () => {
      // The caller passes observations from before `spanStart` for exactly
      // this reason; without them the span opens on a gap that is already
      // filled.
      const plan = planRateGapWindows(
        ["2025-12-30"],
        "2026-01-01",
        "2026-01-05",
      );

      expect(plan.windows).toEqual([]);
    });

    it("ignores an observation struck after the span", () => {
      // A rate from after a date never stands for it (INV-FX-001), so a row in
      // December is no evidence about January.
      const plan = planRateGapWindows(
        ["2026-12-31"],
        "2026-01-01",
        "2026-01-31",
      );

      expect(plan.unresolvableDays).toBe(31);
      expect(plan.windows).toHaveLength(1);
    });

    it("reads unsorted, duplicated input as the set of dates it is", () => {
      const sorted = planRateGapWindows(
        ["2026-03-01", "2026-04-20"],
        "2026-03-01",
        "2026-04-20",
      );
      const scrambled = planRateGapWindows(
        ["2026-04-20", "2026-03-01", "2026-04-20", "2026-03-01"],
        "2026-03-01",
        "2026-04-20",
      );

      expect(scrambled).toEqual(sorted);
    });

    it("plans nothing for a span that ends before it starts", () => {
      const plan = planRateGapWindows([], "2026-02-01", "2026-01-01");

      expect(plan).toEqual({
        windows: [],
        unresolvableDays: 0,
        sparseDays: 0,
      });
    });

    it("separates the two bounds, so a caller cannot conflate them", () => {
      // Same observations, read under each bound in turn: the density bound
      // sees a hole the carry-forward bound does not.
      const observations = ["2026-03-01", "2026-04-01"];
      const strict = planRateGapWindows(
        observations,
        "2026-03-01",
        "2026-04-01",
        {
          densityDays: MAX_OBSERVATION_GAP_DAYS,
          maxAgeDays: MAX_OBSERVATION_GAP_DAYS,
        },
      );
      const lenient = planRateGapWindows(
        observations,
        "2026-03-01",
        "2026-04-01",
        { densityDays: 45, maxAgeDays: 45 },
      );

      expect(strict.unresolvableDays).toBeGreaterThan(0);
      expect(lenient.unresolvableDays).toBe(0);
      expect(lenient.windows).toEqual([]);
    });
  });

  describe("the windows it asks for", () => {
    it("packs a year of monthly holes into one request, not twelve", () => {
      // A request covering a year costs what a request covering a fortnight
      // costs and overwrites every date it spans, so the twelve holes in a
      // month-end-only year are one call. Planning one window per hole is what
      // would make a decade of sparse history take fifteen presses to fill.
      const plan = planRateGapWindows(
        monthEnds(2020, 2020),
        "2020-01-31",
        "2020-12-31",
      );

      expect(plan.windows).toHaveLength(1);
      expect(lengthOf(plan.windows[0])).toBeLessThanOrEqual(
        GAP_WINDOW_MAX_DAYS,
      );
    });

    it("packs a decade of monthly holes into about one request a year", () => {
      const plan = planRateGapWindows(
        monthEnds(2010, 2019),
        "2010-01-31",
        "2019-12-31",
      );

      // One per year, give or take where a window boundary lands -- not one
      // per month, which would be 119.
      expect(plan.windows.length).toBeLessThanOrEqual(12);
      expect(plan.windows.length).toBeGreaterThanOrEqual(9);
      for (const window of plan.windows) {
        expect(lengthOf(window)).toBeLessThanOrEqual(GAP_WINDOW_MAX_DAYS);
      }
    });

    it("keeps holes more than a window apart in separate requests", () => {
      // The year-long bound is what stops the packing swallowing a dense
      // decade between two distant holes and re-fetching all of it.
      const plan = planRateGapWindows(
        ["2020-01-01", "2020-01-02", "2024-01-01"],
        "2020-01-01",
        "2024-01-01",
      );

      expect(plan.windows.length).toBeGreaterThan(1);
      const last = plan.windows[plan.windows.length - 1];
      expect(last.end).toBe("2023-12-31");
    });

    it("splits a multi-year gap into windows the provider still answers daily", () => {
      const plan = planRateGapWindows([], "2020-01-01", "2022-06-30");

      expect(plan.windows).toHaveLength(3);
      for (const window of plan.windows) {
        expect(lengthOf(window)).toBeLessThanOrEqual(GAP_WINDOW_MAX_DAYS);
      }
      // Contiguous and complete: the chunking must not drop a day between one
      // window and the next.
      expect(plan.windows[0].start).toBe("2019-12-18");
      expect(plan.windows[2].end).toBe("2022-06-30");
      for (let i = 1; i < plan.windows.length; i++) {
        const previousEnd = Date.parse(`${plan.windows[i - 1].end}T00:00:00Z`);
        const start = Date.parse(`${plan.windows[i].start}T00:00:00Z`);
        expect(start - previousEnd).toBe(86_400_000);
      }
    });

    it("never asks for a date past the end of the span", () => {
      const plan = planRateGapWindows([], "2026-01-01", "2026-01-05");

      expect(plan.windows[0].end).toBe("2026-01-05");
    });
  });

  describe("what it leaves to the caller", () => {
    it("plans every window the span needs, so the caller can budget them", () => {
      // The cap is not applied here on purpose: a pair whose provider history
      // starts years after the reader's data does plans a run of windows that
      // can never be filled, and capping the plan would let those consume the
      // budget while the fillable ones are never reached.
      const plan = planRateGapWindows([], "2010-01-01", "2020-01-01");

      expect(plan.windows.length).toBeGreaterThan(MAX_GAP_WINDOWS);
      expect(plan.windows[0].start).toBe("2009-12-18");
      expect(plan.windows[plan.windows.length - 1].end).toBe("2020-01-01");
    });
  });
});

describe("isSparseRateSeries", () => {
  it("is not sparse for a weekday series opening on a Monday after a Saturday start", () => {
    // 2017-07-15 is a Saturday.
    const dates = ["2017-07-17", "2017-07-18", "2017-07-21", "2017-07-24"];
    expect(isSparseRateSeries(dates, "2017-07-15", "2017-07-25")).toBe(false);
  });

  it("is sparse for one bar over a month", () => {
    expect(isSparseRateSeries(["2017-08-17"], "2017-07-18", "2017-08-31")).toBe(
      true,
    );
  });

  it("is sparse for an empty series", () => {
    expect(isSparseRateSeries([], "2017-07-18", "2017-08-31")).toBe(true);
  });

  it("is sparse when the gap between two bars exceeds the bound", () => {
    expect(
      isSparseRateSeries(
        ["2017-07-03", "2017-07-14", "2017-07-15"],
        "2017-07-03",
        "2017-07-15",
      ),
    ).toBe(true);
  });

  it("is sparse when the series stops well before the window closes", () => {
    expect(
      isSparseRateSeries(
        ["2017-07-03", "2017-07-04"],
        "2017-07-03",
        "2017-07-31",
      ),
    ).toBe(true);
  });

  it("ignores bars outside the window", () => {
    expect(
      isSparseRateSeries(
        ["2017-06-01", "2017-09-01"],
        "2017-07-01",
        "2017-07-05",
      ),
    ).toBe(true);
  });
});
