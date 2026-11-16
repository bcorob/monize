import { ConflictException } from "@nestjs/common";
import {
  assertOccurrencePin,
  assertScheduleHasOccurrence,
} from "./occurrence-pin";

// A26-S08-01: the occurrence the server would act on is the override's date and
// id when an override sits on the cursor slot, else the cursor and no override.
describe("assertOccurrencePin", () => {
  const override = { id: "ovr-1", overrideDate: "2026-09-04" };

  it("accepts the cursor with no override", () => {
    expect(() =>
      assertOccurrencePin("2026-09-01", null, {
        occurrenceDate: "2026-09-01",
        overrideId: null,
      }),
    ).not.toThrow();
  });

  it("accepts the override's date and id", () => {
    expect(() =>
      assertOccurrencePin("2026-09-01", override, {
        occurrenceDate: "2026-09-04",
        overrideId: "ovr-1",
      }),
    ).not.toThrow();
  });

  it("reads a Date override date as its calendar day", () => {
    expect(() =>
      assertOccurrencePin(
        "2026-09-01",
        { id: "ovr-1", overrideDate: new Date("2026-09-04T00:00:00.000Z") },
        { occurrenceDate: "2026-09-04", overrideId: "ovr-1" },
      ),
    ).not.toThrow();
  });

  it("refuses a pin on a slot the cursor has left", () => {
    expect(() =>
      assertOccurrencePin("2026-10-01", null, {
        occurrenceDate: "2026-09-01",
        overrideId: null,
      }),
    ).toThrow(ConflictException);
  });

  it("refuses the cursor's own date when an override moved the occurrence", () => {
    expect(() =>
      assertOccurrencePin("2026-09-01", override, {
        occurrenceDate: "2026-09-01",
        overrideId: null,
      }),
    ).toThrow(ConflictException);
  });

  it("refuses an override that appeared on the same date", () => {
    expect(() =>
      assertOccurrencePin(
        "2026-09-01",
        { id: "ovr-2", overrideDate: "2026-09-01" },
        { occurrenceDate: "2026-09-01", overrideId: null },
      ),
    ).toThrow(ConflictException);
  });

  it("refuses a pin naming an override that is gone", () => {
    expect(() =>
      assertOccurrencePin("2026-09-01", null, {
        occurrenceDate: "2026-09-04",
        overrideId: "ovr-1",
      }),
    ).toThrow(ConflictException);
  });

  it("refuses a pin naming another override at the same date", () => {
    expect(() =>
      assertOccurrencePin("2026-09-01", override, {
        occurrenceDate: "2026-09-04",
        overrideId: "ovr-other",
      }),
    ).toThrow(ConflictException);
  });
});

describe("assertScheduleHasOccurrence", () => {
  it("accepts an unbounded schedule and a positive count", () => {
    expect(() =>
      assertScheduleHasOccurrence({
        nextDueDate: "2026-09-01",
        occurrencesRemaining: null,
        endDate: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertScheduleHasOccurrence({
        nextDueDate: "2026-09-01",
        occurrencesRemaining: 1,
        endDate: null,
      }),
    ).not.toThrow();
  });

  it("accepts a cursor on end_date", () => {
    expect(() =>
      assertScheduleHasOccurrence({
        nextDueDate: "2026-09-01",
        occurrencesRemaining: null,
        endDate: "2026-09-01",
      }),
    ).not.toThrow();
  });

  it("refuses a zero count", () => {
    expect(() =>
      assertScheduleHasOccurrence({
        nextDueDate: "2026-09-01",
        occurrencesRemaining: 0,
        endDate: null,
      }),
    ).toThrow(ConflictException);
  });

  it("refuses a cursor past end_date", () => {
    expect(() =>
      assertScheduleHasOccurrence({
        nextDueDate: "2026-10-01",
        occurrencesRemaining: null,
        endDate: new Date("2026-09-30T00:00:00.000Z"),
      }),
    ).toThrow(ConflictException);
  });
});
