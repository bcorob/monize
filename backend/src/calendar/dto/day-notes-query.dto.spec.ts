import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import { DayNotesQueryDto } from "./day-notes-query.dto";
import { CALENDAR_RANGE_MAX_DAYS } from "../../common/validators/calendar-range.validator";

const errorsFor = (query: Record<string, unknown>) =>
  validateSync(plainToInstance(DayNotesQueryDto, query), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe("DayNotesQueryDto", () => {
  it("accepts a month grid's range", () => {
    expect(
      errorsFor({ startDate: "2026-06-01", endDate: "2026-06-30" }),
    ).toEqual([]);
  });

  it("requires both dates", () => {
    expect(errorsFor({})).toEqual(
      expect.arrayContaining(["startDate", "endDate"]),
    );
  });

  it("rejects a day that does not exist", () => {
    expect(
      errorsFor({ startDate: "2100-02-29", endDate: "2100-03-01" }),
    ).toContain("startDate");
  });

  it(`uses the same ${CALENDAR_RANGE_MAX_DAYS}-day cap as the other calendar reads`, () => {
    expect(
      errorsFor({ startDate: "2026-06-01", endDate: "2026-09-01" }),
    ).toEqual([]);
    expect(
      errorsFor({ startDate: "2026-06-01", endDate: "2026-09-02" }),
    ).toContain("endDate");
  });

  it("rejects a range that ends before it starts", () => {
    expect(
      errorsFor({ startDate: "2026-06-30", endDate: "2026-06-01" }),
    ).toContain("endDate");
  });
});
