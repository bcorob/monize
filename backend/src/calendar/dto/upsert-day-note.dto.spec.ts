import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import { UpsertDayNoteDto } from "./upsert-day-note.dto";
import { CALENDAR_DAY_NOTE_MAX_LENGTH } from "../../common/calendar-day-note";

const validate = (body: unknown) =>
  validateSync(plainToInstance(UpsertDayNoteDto, { body }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe("UpsertDayNoteDto", () => {
  it("accepts a note", () => {
    expect(validate("Rent moved to the 15th")).toEqual([]);
  });

  it("trims before validating, so whitespace buys no length", () => {
    const dto = plainToInstance(UpsertDayNoteDto, { body: "  hello  " });
    expect(dto.body).toBe("hello");
    expect(
      validate(" ".repeat(20) + "x".repeat(CALENDAR_DAY_NOTE_MAX_LENGTH)),
    ).toEqual([]);
  });

  it("rejects a blank body rather than reading it as a delete", () => {
    // Deleting is its own verb. Inferring it from an empty field would make an
    // accidentally cleared textarea destroy the note on save.
    expect(validate("")).not.toEqual([]);
    expect(validate("   ")).not.toEqual([]);
    expect(validate("\n\t ")).not.toEqual([]);
  });

  it("rejects a missing or non-string body", () => {
    expect(validate(undefined)).not.toEqual([]);
    expect(validate(42)).not.toEqual([]);
    expect(validate({ text: "hi" })).not.toEqual([]);
  });

  it(`accepts exactly ${CALENDAR_DAY_NOTE_MAX_LENGTH} characters and rejects one more`, () => {
    expect(validate("x".repeat(CALENDAR_DAY_NOTE_MAX_LENGTH))).toEqual([]);
    expect(validate("x".repeat(CALENDAR_DAY_NOTE_MAX_LENGTH + 1))).not.toEqual(
      [],
    );
  });

  it("rejects a property the endpoint does not take", () => {
    const errors = validateSync(
      plainToInstance(UpsertDayNoteDto, { body: "hi", date: "2026-06-14" }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.map((e) => e.property)).toContain("date");
  });
});
