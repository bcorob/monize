import {
  MAX_FILL_MONTHS,
  fillSeriesRates,
  planSeriesRateFill,
} from "./series-rate-fill";

const silentLogger = { warn: jest.fn(), log: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe("planSeriesRateFill", () => {
  it("returns nothing for an empty series", () => {
    expect(planSeriesRateFill([])).toEqual([]);
  });

  it("returns nothing when every point converted", () => {
    expect(
      planSeriesRateFill([
        { date: "2026-01-01", missingRatePairs: [] },
        { date: "2026-01-02", missingRatePairs: [] },
      ]),
    ).toEqual([]);
  });

  it("collapses a month of daily points into one fetch unit", () => {
    const points: Array<{ date: string; missingRatePairs: string[] }> = [];
    for (let day = 1; day <= 28; day++) {
      points.push({
        date: `2026-01-${String(day).padStart(2, "0")}`,
        missingRatePairs: ["EUR->PLN"],
      });
    }

    const units = planSeriesRateFill(points);

    expect(units).toEqual([
      {
        month: "2026-01",
        date: "2026-01-01",
        pairs: [{ from: "EUR", to: "PLN" }],
      },
    ]);
  });

  it("uses the earliest date in the month whatever order the points arrive in", () => {
    const units = planSeriesRateFill([
      { date: "2026-03-20", missingRatePairs: ["USD->PLN"] },
      { date: "2026-03-04", missingRatePairs: ["USD->PLN"] },
      { date: "2026-03-11", missingRatePairs: ["USD->PLN"] },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0].date).toBe("2026-03-04");
  });

  it("treats a pair and its reverse as one unit of work", () => {
    // One provider call is persisted in both directions, so fetching EUR->PLN
    // and PLN->EUR separately would be the same call twice.
    const units = planSeriesRateFill([
      { date: "2026-02-03", missingRatePairs: ["EUR->PLN", "PLN->EUR"] },
    ]);

    expect(units[0].pairs).toEqual([{ from: "EUR", to: "PLN" }]);
  });

  it("keeps distinct pairs in one month and splits distinct months", () => {
    const units = planSeriesRateFill([
      { date: "2026-01-05", missingRatePairs: ["EUR->PLN", "USD->PLN"] },
      { date: "2026-02-05", missingRatePairs: ["USD->PLN"] },
    ]);

    expect(units).toEqual([
      {
        month: "2026-01",
        date: "2026-01-05",
        pairs: [
          { from: "EUR", to: "PLN" },
          { from: "USD", to: "PLN" },
        ],
      },
      {
        month: "2026-02",
        date: "2026-02-05",
        pairs: [{ from: "USD", to: "PLN" }],
      },
    ]);
  });

  it("fills the newest months when the range is wider than the cap", () => {
    const points: Array<{ date: string; missingRatePairs: string[] }> = [];
    for (let i = 0; i < 40; i++) {
      const year = 2023 + Math.floor(i / 12);
      const month = String((i % 12) + 1).padStart(2, "0");
      points.push({
        date: `${year}-${month}-01`,
        missingRatePairs: ["EUR->PLN"],
      });
    }

    const units = planSeriesRateFill(points);

    expect(units).toHaveLength(MAX_FILL_MONTHS);
    // Newest kept, oldest dropped and left for the report to name as missing.
    expect(units[units.length - 1].month).toBe("2026-04");
    expect(units[0].month).toBe("2024-05");
  });

  it("honours an explicit cap, including zero", () => {
    const points = [
      { date: "2026-01-01", missingRatePairs: ["EUR->PLN"] },
      { date: "2026-02-01", missingRatePairs: ["EUR->PLN"] },
      { date: "2026-03-01", missingRatePairs: ["EUR->PLN"] },
    ];

    expect(planSeriesRateFill(points, 2).map((u) => u.month)).toEqual([
      "2026-02",
      "2026-03",
    ]);
    expect(planSeriesRateFill(points, 0)).toEqual([]);
  });

  it("ignores a pair with no rate to fetch and a point with no usable date", () => {
    const units = planSeriesRateFill([
      {
        date: "2026-01-05",
        missingRatePairs: ["EUR->EUR", "EUR", "->PLN", ""],
      },
      { date: "not-a-date", missingRatePairs: ["USD->PLN"] },
    ]);

    expect(units).toEqual([]);
  });
});

describe("fillSeriesRates", () => {
  const gaps = [
    { date: "2026-01-04", missingRatePairs: ["EUR->PLN"] },
    { date: "2026-02-04", missingRatePairs: ["EUR->PLN"] },
  ];

  it("calls the provider once per month-pair unit", async () => {
    const filler = { ensureRatesForDate: jest.fn().mockResolvedValue(20) };

    const stored = await fillSeriesRates(filler, gaps, undefined, silentLogger);

    expect(stored).toBe(40);
    expect(filler.ensureRatesForDate).toHaveBeenCalledTimes(2);
    expect(filler.ensureRatesForDate).toHaveBeenNthCalledWith(
      1,
      [{ from: "EUR", to: "PLN" }],
      "2026-01-04",
    );
    expect(filler.ensureRatesForDate).toHaveBeenNthCalledWith(
      2,
      [{ from: "EUR", to: "PLN" }],
      "2026-02-04",
    );
  });

  it("makes no provider call when the caller opted out", async () => {
    const filler = { ensureRatesForDate: jest.fn().mockResolvedValue(20) };

    const stored = await fillSeriesRates(
      filler,
      gaps,
      { fetchMissing: false },
      silentLogger,
    );

    expect(stored).toBe(0);
    expect(filler.ensureRatesForDate).not.toHaveBeenCalled();
  });

  it("makes no provider call when nothing is missing", async () => {
    const filler = { ensureRatesForDate: jest.fn() };

    expect(
      await fillSeriesRates(
        filler,
        [{ date: "2026-01-04", missingRatePairs: [] }],
        undefined,
        silentLogger,
      ),
    ).toBe(0);
    expect(filler.ensureRatesForDate).not.toHaveBeenCalled();
  });

  it("does nothing when no exchange-rate service is wired in", async () => {
    expect(
      await fillSeriesRates(undefined, gaps, undefined, silentLogger),
    ).toBe(0);
  });

  it("logs and keeps going when one unit throws", async () => {
    const warn = jest.fn();
    const filler = {
      ensureRatesForDate: jest
        .fn()
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValueOnce(7),
    };

    const stored = await fillSeriesRates(filler, gaps, undefined, {
      warn,
      log: jest.fn(),
    });

    expect(stored).toBe(7);
    expect(filler.ensureRatesForDate).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("2026-01 failed: provider down"),
    );
  });
});
