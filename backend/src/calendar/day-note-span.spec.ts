import { BadRequestException } from "@nestjs/common";

import { CALENDAR_DAY_NOTE_MAX_SPAN_DAYS } from "../common/calendar-day-note";
import { resolveDayNoteSpan } from "./day-note-span";

describe("resolveDayNoteSpan", () => {
  const body = "Away";

  it("writes the day in the URL alone when neither date is named", () => {
    // Most notes are one day, and the client that writes one should not have to
    // repeat the date it is already addressing.
    expect(resolveDayNoteSpan("2026-06-14", { body })).toEqual({
      startDate: "2026-06-14",
      endDate: "2026-06-14",
      body,
    });
  });

  it("ends a note on its own first day when only a start is named", () => {
    expect(
      resolveDayNoteSpan("2026-06-14", { body, startDate: "2026-06-14" }),
    ).toEqual({ startDate: "2026-06-14", endDate: "2026-06-14", body });
  });

  it("keeps a span the day was opened from the middle of", () => {
    expect(
      resolveDayNoteSpan("2026-06-16", {
        body,
        startDate: "2026-06-14",
        endDate: "2026-06-18",
      }),
    ).toEqual({ startDate: "2026-06-14", endDate: "2026-06-18", body });
  });

  it("accepts the span's own first and last day as the anchor", () => {
    for (const anchor of ["2026-06-14", "2026-06-18"]) {
      expect(
        resolveDayNoteSpan(anchor, {
          body,
          startDate: "2026-06-14",
          endDate: "2026-06-18",
        }).startDate,
      ).toBe("2026-06-14");
    }
  });

  it("refuses a span that ends before it starts", () => {
    expect(() =>
      resolveDayNoteSpan("2026-06-14", {
        body,
        startDate: "2026-06-14",
        endDate: "2026-06-13",
      }),
    ).toThrow(BadRequestException);
  });

  it("refuses a span that does not cover the day it was written from", () => {
    expect(() =>
      resolveDayNoteSpan("2026-06-16", {
        body,
        startDate: "2026-06-20",
        endDate: "2026-06-22",
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveDayNoteSpan("2026-06-16", {
        body,
        startDate: "2026-06-10",
        endDate: "2026-06-12",
      }),
    ).toThrow(BadRequestException);
  });

  describe("the span bound", () => {
    // The constant counts the days BEYOND the first, which is what
    // `end_date - note_date` is; the longest note therefore covers one more day
    // than the constant names. Both ends are tested because an off-by-one here
    // is a 400 for a note the database would have taken, or a constraint
    // violation for one the resolver let through.
    const start = "2026-01-01";
    const dayAfter = (days: number) =>
      new Date(Date.parse(`${start}T00:00:00.000Z`) + days * 86_400_000)
        .toISOString()
        .slice(0, 10);

    it("accepts the longest span the CHECK constraint allows", () => {
      const endDate = dayAfter(CALENDAR_DAY_NOTE_MAX_SPAN_DAYS);
      expect(
        resolveDayNoteSpan(start, { body, startDate: start, endDate }).endDate,
      ).toBe(endDate);
    });

    it("refuses one day more", () => {
      expect(() =>
        resolveDayNoteSpan(start, {
          body,
          startDate: start,
          endDate: dayAfter(CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1),
        }),
      ).toThrow(BadRequestException);
    });
  });
});
