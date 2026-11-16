import { enumerateDaysYMD, monthEndSampleDates } from "./series-dates.util";

/**
 * The implementation this replaces, written out so the regression below can
 * show what it did rather than assert what it did. `new Date("2026-06-01T00:00:00")`
 * is LOCAL midnight; `offsetMinutes` is the process zone's offset east of UTC
 * (Europe/Warsaw in summer is +120), so the instant is that many minutes before
 * UTC midnight and `toISOString()` reads the day before.
 *
 * Simulated rather than run under a real `TZ`, because Node caches the zone at
 * first use and a spec that changes `process.env.TZ` mid-run proves nothing
 * about the process CI actually uses.
 */
function legacyEnumerateDays(
  start: string,
  end: string,
  offsetMinutes: number,
): string[] {
  const atLocalMidnight = (ymd: string): number => {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y, m - 1, d) - offsetMinutes * 60_000;
  };
  const dates: string[] = [];
  const d = new Date(atLocalMidnight(start));
  const endD = new Date(atLocalMidnight(end));
  while (d <= endD) {
    dates.push(d.toISOString().substring(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

describe("enumerateDaysYMD", () => {
  const cases: Array<{
    name: string;
    start: string;
    end: string;
    expected: string[];
  }> = [
    {
      name: "a single day",
      start: "2026-06-01",
      end: "2026-06-01",
      expected: ["2026-06-01"],
    },
    {
      name: "the window the defect was reported on",
      start: "2026-06-01",
      end: "2026-06-03",
      expected: ["2026-06-01", "2026-06-02", "2026-06-03"],
    },
    {
      name: "a spring-forward DST boundary (Europe/Warsaw, 2026-03-29)",
      start: "2026-03-28",
      end: "2026-03-30",
      expected: ["2026-03-28", "2026-03-29", "2026-03-30"],
    },
    {
      name: "a fall-back DST boundary (America/New_York, 2026-11-01)",
      start: "2026-10-31",
      end: "2026-11-02",
      expected: ["2026-10-31", "2026-11-01", "2026-11-02"],
    },
    {
      name: "a month boundary in a leap year",
      start: "2024-02-27",
      end: "2024-03-01",
      expected: ["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"],
    },
    {
      name: "a year boundary",
      start: "2025-12-30",
      end: "2026-01-02",
      expected: ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"],
    },
    {
      name: "a reversed window",
      start: "2026-06-03",
      end: "2026-06-01",
      expected: [],
    },
  ];

  it.each(cases)("$name", ({ start, end, expected }) => {
    expect(enumerateDaysYMD(start, end)).toEqual(expected);
  });

  it("returns the same keys whatever offset the process runs at", () => {
    // The function reads no clock and builds no local Date, so there is nothing
    // for a zone to shift. Asserted against the legacy shape at UTC, where the
    // two agree, to pin that this is a fix and not a different enumeration.
    expect(enumerateDaysYMD("2026-06-01", "2026-06-03")).toEqual(
      legacyEnumerateDays("2026-06-01", "2026-06-03", 0),
    );
  });

  it("differs from the local-Date implementation east of Greenwich", () => {
    // Europe/Warsaw in June: +02:00. Every key is a day early and the last
    // requested day is never emitted, which is exactly what made the first day
    // of a range miss its cash row and report zero.
    const legacy = legacyEnumerateDays("2026-06-01", "2026-06-03", 120);
    expect(legacy).toEqual(["2026-05-31", "2026-06-01", "2026-06-02"]);
    expect(enumerateDaysYMD("2026-06-01", "2026-06-03")).not.toEqual(legacy);
  });

  it("agrees with the local-Date implementation west of Greenwich", () => {
    // America/New_York in June: -04:00, so local midnight is 04:00 UTC and the
    // keys happen to come out right. The defect was invisible in CI (UTC) and
    // to anyone west of Greenwich, which is why it needed a table test rather
    // than a run in the ambient zone.
    expect(legacyEnumerateDays("2026-06-01", "2026-06-03", -240)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
  });

  it("emits the first and the last day the caller asked for", () => {
    const days = enumerateDaysYMD("2026-01-15", "2026-02-14");
    expect(days[0]).toBe("2026-01-15");
    expect(days[days.length - 1]).toBe("2026-02-14");
    expect(days).toHaveLength(31);
  });
});

describe("monthEndSampleDates", () => {
  it.each([
    {
      name: "a mid-month start opens on its own day, then that month's end",
      start: "2024-09-29",
      end: "2024-12-10",
      expected: [
        "2024-09-29",
        "2024-09-30",
        "2024-10-31",
        "2024-11-30",
        "2024-12-10",
      ],
    },
    {
      name: "a start on the 1st still reaches its own month's end",
      start: "2026-03-01",
      end: "2026-05-15",
      expected: ["2026-03-01", "2026-03-31", "2026-04-30", "2026-05-15"],
    },
    {
      name: "a start that is itself a month-end appears once (YTD)",
      start: "2025-12-31",
      end: "2026-02-10",
      expected: ["2025-12-31", "2026-01-31", "2026-02-10"],
    },
    {
      name: "an end on a month-end appears once",
      start: "2026-01-10",
      end: "2026-02-28",
      expected: ["2026-01-10", "2026-01-31", "2026-02-28"],
    },
    {
      name: "a leap-year February ends on the 29th",
      start: "2024-02-10",
      end: "2024-03-05",
      expected: ["2024-02-10", "2024-02-29", "2024-03-05"],
    },
    {
      name: "a window inside one month is its two ends",
      start: "2026-06-03",
      end: "2026-06-20",
      expected: ["2026-06-03", "2026-06-20"],
    },
    {
      name: "a one-day window is that day",
      start: "2026-06-03",
      end: "2026-06-03",
      expected: ["2026-06-03"],
    },
    {
      name: "a reversed window is no days",
      start: "2026-06-04",
      end: "2026-06-03",
      expected: [],
    },
  ])("$name", ({ start, end, expected }) => {
    expect(monthEndSampleDates(start, end)).toEqual(expected);
  });

  it("crosses a year end", () => {
    expect(monthEndSampleDates("2025-11-15", "2026-01-15")).toEqual([
      "2025-11-15",
      "2025-11-30",
      "2025-12-31",
      "2026-01-15",
    ]);
  });
});
