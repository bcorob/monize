import { BadRequestException } from "@nestjs/common";

import {
  ParseCalendarDatePipe,
  ParseOptionalCalendarDatePipe,
} from "./parse-calendar-date.pipe";

describe("ParseCalendarDatePipe", () => {
  const pipe = new ParseCalendarDatePipe();

  it("passes a real calendar date through unchanged", () => {
    expect(pipe.transform("2026-07-20")).toBe("2026-07-20");
    expect(pipe.transform("2024-02-29")).toBe("2024-02-29"); // a leap day
  });

  it("rejects a day that does not exist", () => {
    for (const value of ["2026-02-30", "9999-99-99", "2026-13-01"]) {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    }
  });

  it("rejects a value that is not YYYY-MM-DD", () => {
    for (const value of ["07/20/2026", "2026-7-20", "", "today"]) {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    }
  });

  /**
   * Express parses a repeated key into an array, so a parameter declared
   * `string` need not be one. A format check written as a regular expression
   * `.test` coerces the array to text and passes it, after which the value is
   * sliced and compared as a date (CodeQL
   * `js/type-confusion-through-parameter-tampering`).
   */
  it("rejects a repeated parameter rather than coercing it to text", () => {
    for (const value of [
      ["2026-07-20"],
      ["2026-07-20", "2026-07-21"],
      { toString: () => "2026-07-20" },
      20260720,
      null,
      undefined,
    ]) {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    }
  });
});

describe("ParseOptionalCalendarDatePipe", () => {
  const pipe = new ParseOptionalCalendarDatePipe();

  it("treats an absent or blank bound as no bound", () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform("")).toBeUndefined();
  });

  it("holds a bound that is present to the same check", () => {
    expect(pipe.transform("2026-07-20")).toBe("2026-07-20");
    expect(() => pipe.transform("2026-02-30")).toThrow(BadRequestException);
    expect(() => pipe.transform(["2026-07-20"])).toThrow(BadRequestException);
    expect(() => pipe.transform(["2026-07-20", "2026-07-21"])).toThrow(
      BadRequestException,
    );
  });
});
