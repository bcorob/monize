import {
  DatedRate,
  FX_MAX_RATE_AGE_DAYS,
  describeFxGap,
  resolveFxRate,
} from "./fx-rate-resolver";

/**
 * Issue #1390: a 285-day hole in `exchange_rates` was back-filled with a rate
 * first observed nine months *after* the valuation date, and four resolvers
 * disagreed about which rate a session should use. These are the rules that
 * replaced them; every row here fails on the previous behaviour.
 */
function lookupFrom(
  stored: Record<string, DatedRate[]>,
): (from: string, to: string) => DatedRate[] | undefined {
  return (from, to) => stored[`${from}->${to}`];
}

const TODAY = "2026-09-16";

describe("resolveFxRate", () => {
  describe("the policy table", () => {
    const cases: Array<{
      name: string;
      stored: Record<string, DatedRate[]>;
      from: string;
      to: string;
      onDate: string;
      expected: {
        status: string;
        rate: number | null;
        observedOn?: string | null;
        direction?: string | null;
        reason?: string | null;
      };
    }> = [
      {
        // The reported defect: the only stored EUR rate is dated June 2026 and
        // the valuation is March 2026. `findBestRate` used to return it.
        name: "a valuation that predates the whole history is unknown, not the earliest rate",
        stored: { "EUR->USD": [{ date: "2026-06-20", rate: 1.12 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-03-01",
        expected: { status: "unknown", rate: null, reason: "only_after_date" },
      },
      {
        name: "a rate 285 days older than the date is unknown, not carried forward",
        stored: { "EUR->USD": [{ date: "2025-09-05", rate: 1.1 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-17",
        expected: {
          status: "unknown",
          rate: null,
          reason: "stale_observation",
        },
      },
      {
        name: "an old direct observation does not block a fresh inverse one",
        stored: {
          "EUR->USD": [{ date: "2026-01-02", rate: 1.1 }],
          "USD->EUR": [{ date: "2026-06-15", rate: 0.8 }],
        },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-17",
        expected: {
          status: "resolved",
          rate: 1.25,
          observedOn: "2026-06-15",
          direction: "inverse",
        },
      },
      {
        name: "direct and inverse observed the same day: direct wins",
        stored: {
          "EUR->USD": [{ date: "2026-06-15", rate: 1.2 }],
          "USD->EUR": [{ date: "2026-06-15", rate: 0.8 }],
        },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-17",
        expected: {
          status: "resolved",
          rate: 1.2,
          observedOn: "2026-06-15",
          direction: "direct",
        },
      },
      {
        // 2026-06-19 is a Friday, 2026-06-22 the Monday after it.
        name: "Friday's rate stands for the Monday after it",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 1.15 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: {
          status: "resolved",
          rate: 1.15,
          observedOn: "2026-06-19",
          direction: "direct",
        },
      },
      {
        name: "a zero stored rate is absent, not a rate of zero",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 0 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: { status: "unknown", rate: null, reason: "no_observation" },
      },
      {
        name: "a negative stored rate is absent",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: -1.15 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: { status: "unknown", rate: null, reason: "no_observation" },
      },
      {
        name: "equal codes resolve to 1",
        stored: {},
        from: "EUR",
        to: "EUR",
        onDate: "2026-06-22",
        expected: {
          status: "same_currency",
          rate: 1,
          observedOn: null,
          direction: "identity",
        },
      },
      {
        name: "a missing source code is unknown, never 1",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 1.15 }] },
        from: "",
        to: "USD",
        onDate: "2026-06-22",
        expected: {
          status: "unknown",
          rate: null,
          reason: "unknown_currency",
        },
      },
      {
        name: "a missing target code is unknown, never 1",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 1.15 }] },
        from: "EUR",
        to: "",
        onDate: "2026-06-22",
        expected: {
          status: "unknown",
          rate: null,
          reason: "unknown_currency",
        },
      },
      {
        name: "a pair nobody ever observed is unknown",
        stored: {},
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: { status: "unknown", rate: null, reason: "no_observation" },
      },
      {
        name: "the newest admissible observation on or before the date wins",
        stored: {
          "EUR->USD": [
            { date: "2026-06-10", rate: 1.1 },
            { date: "2026-06-18", rate: 1.2 },
            { date: "2026-06-25", rate: 1.3 },
          ],
        },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: {
          status: "resolved",
          rate: 1.2,
          observedOn: "2026-06-18",
          direction: "direct",
        },
      },
    ];

    it.each(cases)("$name", ({ stored, from, to, onDate, expected }) => {
      const result = resolveFxRate(from, to, onDate, lookupFrom(stored), {
        today: TODAY,
      });
      expect(result.status).toBe(expected.status);
      if (expected.rate === null) expect(result.rate).toBeNull();
      else expect(result.rate).toBeCloseTo(expected.rate, 10);
      if (expected.observedOn !== undefined) {
        expect(result.observedOn).toBe(expected.observedOn);
      }
      if (expected.direction !== undefined) {
        expect(result.direction).toBe(expected.direction);
      }
      if (expected.reason !== undefined) {
        expect(result.reason).toBe(expected.reason);
      }
    });
  });

  it("never consults the history for equal codes", () => {
    const lookup = jest.fn();
    expect(
      resolveFxRate("EUR", "EUR", "2026-06-22", lookup, { today: TODAY }).rate,
    ).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("accepts an observation exactly on the age bound and refuses the day past it", () => {
    const onDate = "2026-06-22";
    const onTheBound = new Date(Date.parse(`${onDate}T00:00:00Z`));
    onTheBound.setUTCDate(onTheBound.getUTCDate() - FX_MAX_RATE_AGE_DAYS);
    const pastIt = new Date(onTheBound.getTime() - 86_400_000);
    const at = (d: Date) => d.toISOString().slice(0, 10);

    expect(
      resolveFxRate(
        "EUR",
        "USD",
        onDate,
        lookupFrom({ "EUR->USD": [{ date: at(onTheBound), rate: 1.1 }] }),
        { today: TODAY },
      ).rate,
    ).toBe(1.1);
    expect(
      resolveFxRate(
        "EUR",
        "USD",
        onDate,
        lookupFrom({ "EUR->USD": [{ date: at(pastIt), rate: 1.1 }] }),
        { today: TODAY },
      ),
    ).toMatchObject({ status: "unknown", reason: "stale_observation" });
  });

  it("clamps a future valuation date to today rather than refusing it", () => {
    const result = resolveFxRate(
      "EUR",
      "USD",
      "2099-01-01",
      lookupFrom({ "EUR->USD": [{ date: TODAY, rate: 1.17 }] }),
      { today: TODAY },
    );
    expect(result).toMatchObject({ rate: 1.17, observedOn: TODAY });
  });

  describe("live mode", () => {
    it("takes the freshest observation rather than one on or before the date", () => {
      const result = resolveFxRate(
        "EUR",
        "USD",
        "2026-09-01",
        lookupFrom({
          "EUR->USD": [
            { date: "2026-09-01", rate: 1.1 },
            { date: "2026-09-15", rate: 1.2 },
          ],
        }),
        { mode: "live", today: TODAY },
      );
      expect(result).toMatchObject({ rate: 1.2, observedOn: "2026-09-15" });
    });

    it("is still bounded by the same age limit", () => {
      const result = resolveFxRate(
        "EUR",
        "USD",
        TODAY,
        lookupFrom({ "EUR->USD": [{ date: "2025-09-05", rate: 1.1 }] }),
        { mode: "live", today: TODAY },
      );
      expect(result).toMatchObject({
        status: "unknown",
        reason: "stale_observation",
      });
    });
  });

  it("does not depend on the order observations arrive in", () => {
    const ascending: DatedRate[] = [
      { date: "2026-06-10", rate: 1.1 },
      { date: "2026-06-18", rate: 1.2 },
    ];
    const descending = [...ascending].reverse();
    const at = (rows: DatedRate[]) =>
      resolveFxRate(
        "EUR",
        "USD",
        "2026-06-22",
        lookupFrom({ "EUR->USD": rows }),
        {
          today: TODAY,
        },
      );
    expect(at(descending)).toEqual(at(ascending));
  });

  /**
   * Issue #1409: the resolver used to read every stored observation of a pair
   * on every lookup, and every row cost two `Date.parse` calls. The
   * since-inception portfolio walk asks for a rate on each of ~9,700 days
   * against an index holding ~9,700 rows per direction, so one pair alone
   * blocked the event loop for 66 seconds -- long enough for the readiness
   * probe to fail and the pod to leave the Service.
   *
   * The answer must be the one the scan gave, row for row. `scanForBest` is
   * that scan, kept here as the reference the fast path is measured against:
   * the same rules, written the slow way.
   */
  describe("the lookup that replaced the scan", () => {
    interface Best {
      rate: number | null;
      observedOn: string | null;
      reason: string | null;
    }

    function scanForBest(
      rows: DatedRate[],
      inverse: DatedRate[],
      onDate: string,
      mode: "historical" | "live",
      today: string,
    ): Best {
      const maxAgeDays = FX_MAX_RATE_AGE_DAYS;
      const requested = onDate.slice(0, 10);
      const reference =
        mode === "live" ? today : requested > today ? today : requested;
      const days = (from: string, to: string) =>
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000;
      let sawAfter = false;
      let sawStale = false;
      let best: { date: string; rate: number; direction: string } | null = null;
      for (const [direction, series] of [
        ["direct", rows],
        ["inverse", inverse],
      ] as const) {
        let inDirection: { date: string; rate: number } | null = null;
        for (const row of series) {
          const observed = Number(row.rate);
          if (!Number.isFinite(observed) || observed <= 0) continue;
          const date = row.date.slice(0, 10);
          if (!date) continue;
          const age = days(date, reference);
          if (age < 0 && mode === "historical") {
            sawAfter = true;
            continue;
          }
          if (Math.abs(age) > maxAgeDays) {
            sawStale = true;
            continue;
          }
          if (inDirection !== null && date <= inDirection.date) continue;
          inDirection = {
            date,
            rate: direction === "direct" ? observed : 1 / observed,
          };
        }
        if (inDirection === null) continue;
        // The more recent admissible observation wins; a tie goes to direct,
        // which is read first here.
        if (best === null || inDirection.date > best.date) {
          best = { ...inDirection, direction };
        }
      }
      if (best === null) {
        return {
          rate: null,
          observedOn: null,
          reason: sawStale
            ? "stale_observation"
            : sawAfter
              ? "only_after_date"
              : "no_observation",
        };
      }
      return { rate: best.rate, observedOn: best.date, reason: null };
    }

    /** A deterministic generator: a seeded LCG, so a failure reproduces. */
    function randomSeries(seed: number, count: number): DatedRate[] {
      let state = seed;
      const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
      const rows: DatedRate[] = [];
      for (let i = 0; i < count; i++) {
        const day = next() % 400;
        const date = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000)
          .toISOString()
          .slice(0, 10);
        // Zero, negative and duplicate dates are all part of the input space.
        const rate = [1.1, 1.25, 0, -1, 1.3][next() % 5];
        rows.push({ date, rate });
      }
      return rows;
    }

    it("answers what the scan answered, over randomized histories", () => {
      for (let seed = 1; seed <= 60; seed++) {
        const direct = randomSeries(seed, 12);
        const inverse = randomSeries(seed + 5000, 12);
        for (const mode of ["historical", "live"] as const) {
          for (const day of [0, 60, 150, 399]) {
            const onDate = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000)
              .toISOString()
              .slice(0, 10);
            const expected = scanForBest(
              direct,
              inverse,
              onDate,
              mode,
              "2027-06-01",
            );
            const actual = resolveFxRate(
              "EUR",
              "USD",
              onDate,
              lookupFrom({ "EUR->USD": direct, "USD->EUR": inverse }),
              { mode, today: "2027-06-01" },
            );
            expect({
              rate: actual.rate,
              observedOn: actual.observedOn,
              reason: actual.reason,
              seed,
              mode,
              onDate,
            }).toEqual({ ...expected, seed, mode, onDate });
          }
        }
      }
    });

    it("keeps a day-by-day walk over a 26-year history off the event loop", () => {
      const rows: DatedRate[] = [];
      const dates: string[] = [];
      for (let i = 0; i < 9_700; i++) {
        const date = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000)
          .toISOString()
          .slice(0, 10);
        dates.push(date);
        rows.push({ date, rate: 1.3 + (i % 100) / 1000 });
      }
      const inverse = rows.map((row) => ({
        date: row.date,
        rate: 1 / row.rate,
      }));
      const lookup = lookupFrom({ "USD->CAD": rows, "CAD->USD": inverse });

      const started = Date.now();
      for (const date of dates) {
        expect(
          resolveFxRate("USD", "CAD", date, lookup, { today: "2026-09-16" })
            .rate,
        ).not.toBeNull();
      }
      // The scan took 66 s for exactly this shape. The budget is deliberately
      // two orders of magnitude above what the lookup costs (~0.1 s) rather
      // than a tight timing assertion: what it fails is a return to work that
      // grows with the history, not a slow machine.
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 30_000);
  });

  it("names each gap differently so a reader learns which repair applies", () => {
    const lines = (
      [
        "unknown_currency",
        "invalid_date",
        "no_observation",
        "only_after_date",
        "stale_observation",
      ] as const
    ).map((reason) => describeFxGap("EUR->USD", "2026-03-01", reason));
    expect(new Set(lines).size).toBe(5);
    expect(lines.every((line) => line.includes("EUR->USD"))).toBe(true);
  });

  /**
   * `onDate` is declared `string` and on the request path it is a query
   * parameter: `?date=x&date=y` reaches the handler as an array. Every rule in
   * this module is a lexicographic comparison of `YYYY-MM-DD` strings, and an
   * array satisfies none of them while passing every one by coercion -- the
   * resolver used to hand back a rate for a day nobody named (CodeQL
   * `js/type-confusion-through-parameter-tampering`).
   */
  describe("a valuation date that does not name a day", () => {
    const stored = { "EUR->USD": [{ date: "2026-06-18", rate: 1.2 }] };

    it("refuses an array in place of the date rather than resolving it", () => {
      const result = resolveFxRate(
        "EUR",
        "USD",
        ["2026-06-22"] as unknown as string,
        lookupFrom(stored),
        { today: TODAY },
      );
      expect(result).toMatchObject({
        status: "unknown",
        rate: null,
        observedOn: null,
        reason: "invalid_date",
      });
    });

    it("refuses a repeated parameter, which coercion would read as one date", () => {
      const result = resolveFxRate(
        "EUR",
        "USD",
        ["2026-06-22", "2026-06-23"] as unknown as string,
        lookupFrom(stored),
        { today: TODAY },
      );
      expect(result.rate).toBeNull();
      expect(result.reason).toBe("invalid_date");
    });

    it("refuses a string that is not a calendar date, in live mode too", () => {
      for (const mode of ["historical", "live"] as const) {
        expect(
          resolveFxRate("EUR", "USD", "yesterday", lookupFrom(stored), {
            today: TODAY,
            mode,
          }),
        ).toMatchObject({ rate: null, reason: "invalid_date" });
      }
    });
  });
});
