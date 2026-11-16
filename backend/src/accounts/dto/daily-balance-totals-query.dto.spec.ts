import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import { DailyBalanceTotalsQueryDto } from "./daily-balance-totals-query.dto";
import { CALENDAR_RANGE_MAX_DAYS } from "../../common/validators/calendar-range.validator";

const validate = (query: Record<string, unknown>) =>
  validateSync(
    plainToInstance(DailyBalanceTotalsQueryDto, query, {
      enableImplicitConversion: false,
    }),
    { whitelist: true, forbidNonWhitelisted: true },
  );

const propertiesInError = (query: Record<string, unknown>) =>
  validate(query).map((e) => e.property);

describe("DailyBalanceTotalsQueryDto", () => {
  const valid = { startDate: "2026-06-01", endDate: "2026-06-30" };

  it("accepts a month grid's range", () => {
    expect(validate(valid)).toHaveLength(0);
  });

  it("accepts a single day", () => {
    expect(
      validate({ startDate: "2026-06-01", endDate: "2026-06-01" }),
    ).toHaveLength(0);
  });

  it("requires both dates", () => {
    expect(propertiesInError({})).toEqual(
      expect.arrayContaining(["startDate", "endDate"]),
    );
  });

  it("rejects a day that does not exist", () => {
    // The shape is right and the day is not: 2100 is not a leap year, and a
    // value like this reaching Postgres as a date literal is a 500 for what is
    // plainly a client error.
    expect(
      propertiesInError({ startDate: "2100-02-29", endDate: "2100-03-01" }),
    ).toContain("startDate");
    expect(
      propertiesInError({ startDate: "2100-02-01", endDate: "2100-02-29" }),
    ).toContain("endDate");
  });

  it("rejects a malformed date", () => {
    expect(
      propertiesInError({ startDate: "June 1 2026", endDate: "2026-06-30" }),
    ).toContain("startDate");
  });

  it(`accepts exactly ${CALENDAR_RANGE_MAX_DAYS} days`, () => {
    // 2026-06-01 through 2026-09-01 inclusive is 93 days.
    expect(
      validate({ startDate: "2026-06-01", endDate: "2026-09-01" }),
    ).toHaveLength(0);
  });

  it(`rejects ${CALENDAR_RANGE_MAX_DAYS + 1} days`, () => {
    expect(
      propertiesInError({ startDate: "2026-06-01", endDate: "2026-09-02" }),
    ).toContain("endDate");
  });

  it("rejects a range that ends before it starts", () => {
    expect(
      propertiesInError({ startDate: "2026-06-30", endDate: "2026-06-01" }),
    ).toContain("endDate");
  });

  it("parses accountIds from a comma-separated list", () => {
    const dto = plainToInstance(DailyBalanceTotalsQueryDto, {
      ...valid,
      accountIds:
        "3f2504e0-4f89-41d3-9a0c-0305e82c3301,3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    });
    expect(dto.accountIds).toEqual([
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    ]);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it("rejects an account id that is not a UUID", () => {
    expect(propertiesInError({ ...valid, accountIds: "not-a-uuid" })).toContain(
      "accountIds",
    );
  });

  it("rejects an unbounded account list", () => {
    const ids = Array.from(
      { length: 201 },
      (_, i) => `3f2504e0-4f89-41d3-9a0c-${String(i).padStart(12, "0")}`,
    ).join(",");
    expect(propertiesInError({ ...valid, accountIds: ids })).toContain(
      "accountIds",
    );
  });

  it("rejects a display currency that is not a three-letter code", () => {
    expect(
      propertiesInError({ ...valid, displayCurrency: "CANADIAN" }),
    ).toContain("displayCurrency");
  });

  it("accepts an omitted or empty display currency", () => {
    expect(validate({ ...valid })).toHaveLength(0);
    expect(validate({ ...valid, displayCurrency: "" })).toHaveLength(0);
  });

  it("rejects a property the endpoint does not take", () => {
    expect(propertiesInError({ ...valid, allTime: "true" })).toContain(
      "allTime",
    );
  });
});
