import { buildSchedule } from "./period-schedule";

const ends = (purchase: string, count: number, months: number) =>
  buildSchedule(purchase, count, months).map((p) => p.end);

describe("buildSchedule (ROR annex 3)", () => {
  it("purchase on the 1st", () => {
    expect(ends("2026-10-01", 12, 1)).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
      "2027-05-01",
      "2027-06-01",
      "2027-07-01",
      "2027-08-01",
      "2027-09-01",
      "2027-10-01",
    ]);
  });

  it("purchase on the 29th clamps in February only", () => {
    const schedule = buildSchedule("2026-10-29", 12, 1);
    expect(schedule[3]).toMatchObject({
      index: 4,
      start: "2027-01-29",
      end: "2027-02-28",
      days: 30,
    });
    expect(schedule[4]).toMatchObject({
      index: 5,
      start: "2027-02-28",
      end: "2027-03-29",
      days: 29,
    });
  });

  it("purchase on the 30th", () => {
    const schedule = buildSchedule("2026-10-30", 12, 1);
    expect(schedule[3].end).toBe("2027-02-28");
    expect(schedule[4]).toMatchObject({
      start: "2027-02-28",
      end: "2027-03-30",
    });
  });

  it("purchase on the 31st", () => {
    expect(ends("2026-10-31", 12, 1)).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
      "2027-10-31",
    ]);
  });

  it("purchase on the 28th has no clamping", () => {
    expect(ends("2026-10-28", 5, 1)[3]).toBe("2027-02-28");
  });

  it("chains periods and takes maturity from the last end", () => {
    const schedule = buildSchedule("2026-10-31", 12, 1);
    schedule.slice(1).forEach((period, i) => {
      expect(period.start).toBe(schedule[i].end);
    });
    expect(schedule[schedule.length - 1].end).toBe("2027-10-31");
  });

  it("builds an annual schedule across a leap year", () => {
    const schedule = buildSchedule("2026-10-15", 3, 12);
    expect(schedule.map((p) => [p.start, p.end, p.days])).toEqual([
      ["2026-10-15", "2027-10-15", 365],
      ["2027-10-15", "2028-10-15", 366],
      ["2028-10-15", "2029-10-15", 365],
    ]);
  });

  it("refuses a nonsensical shape", () => {
    expect(() => buildSchedule("2026-10-15", 0, 12)).toThrow(RangeError);
    expect(() => buildSchedule("2026-10-15", 3, 0)).toThrow(RangeError);
    expect(() => buildSchedule("2026-10-15", 1.5, 12)).toThrow(RangeError);
    expect(() => buildSchedule("2026-10-15", 3, 1.5)).toThrow(RangeError);
  });
});
