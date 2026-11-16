import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import {
  DailyMovementDetailQueryDto,
  DailyMovementsQueryDto,
} from "./daily-movements-query.dto";
import { CALENDAR_RANGE_MAX_DAYS } from "../../common/validators/calendar-range.validator";

const errorsFor = <T extends object>(
  cls: new () => T,
  query: Record<string, unknown>,
) =>
  validateSync(plainToInstance(cls, query), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe("DailyMovementsQueryDto", () => {
  const valid = { startDate: "2026-09-01", endDate: "2026-09-30" };

  it("accepts a month's range", () => {
    expect(errorsFor(DailyMovementsQueryDto, valid)).toEqual([]);
  });

  it("requires both dates", () => {
    expect(errorsFor(DailyMovementsQueryDto, {})).toEqual(
      expect.arrayContaining(["startDate", "endDate"]),
    );
  });

  it("rejects a day that does not exist", () => {
    expect(
      errorsFor(DailyMovementsQueryDto, {
        startDate: "2100-02-29",
        endDate: "2100-03-01",
      }),
    ).toContain("startDate");
  });

  it(`caps the range at ${CALENDAR_RANGE_MAX_DAYS} days, the same constant the other calendar read models use`, () => {
    expect(
      errorsFor(DailyMovementsQueryDto, {
        startDate: "2026-06-01",
        endDate: "2026-09-01",
      }),
    ).toEqual([]);
    expect(
      errorsFor(DailyMovementsQueryDto, {
        startDate: "2026-06-01",
        endDate: "2026-09-02",
      }),
    ).toContain("endDate");
  });

  it("rejects a range that ends before it starts", () => {
    expect(
      errorsFor(DailyMovementsQueryDto, {
        startDate: "2026-09-30",
        endDate: "2026-09-01",
      }),
    ).toContain("endDate");
  });

  it("parses accountIds from a comma-separated list", () => {
    const dto = plainToInstance(DailyMovementsQueryDto, {
      ...valid,
      accountIds:
        "3f2504e0-4f89-41d3-9a0c-0305e82c3301,3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    });
    expect(dto.accountIds).toHaveLength(2);
    expect(validateSync(dto)).toEqual([]);
  });

  it("rejects a non-UUID account id and an unbounded list", () => {
    expect(
      errorsFor(DailyMovementsQueryDto, { ...valid, accountIds: "nope" }),
    ).toContain("accountIds");

    const ids = Array.from(
      { length: 201 },
      (_, i) => `3f2504e0-4f89-41d3-9a0c-${String(i).padStart(12, "0")}`,
    ).join(",");
    expect(
      errorsFor(DailyMovementsQueryDto, { ...valid, accountIds: ids }),
    ).toContain("accountIds");
  });

  it("rejects a display currency that is not a three-letter code", () => {
    expect(
      errorsFor(DailyMovementsQueryDto, {
        ...valid,
        displayCurrency: "CANADIAN",
      }),
    ).toContain("displayCurrency");
  });

  it("rejects a property the endpoint does not take", () => {
    expect(
      errorsFor(DailyMovementsQueryDto, { ...valid, date: "2026-09-01" }),
    ).toContain("date");
  });
});

describe("DailyMovementDetailQueryDto", () => {
  it("accepts one real day", () => {
    expect(
      errorsFor(DailyMovementDetailQueryDto, { date: "2026-09-11" }),
    ).toEqual([]);
  });

  it("requires the day and rejects one that does not exist", () => {
    expect(errorsFor(DailyMovementDetailQueryDto, {})).toContain("date");
    expect(
      errorsFor(DailyMovementDetailQueryDto, { date: "2100-02-29" }),
    ).toContain("date");
  });

  it("takes the same scope fields as the month endpoint", () => {
    const dto = plainToInstance(DailyMovementDetailQueryDto, {
      date: "2026-09-11",
      accountIds: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      displayCurrency: "CAD",
    });
    expect(dto.accountIds).toEqual(["3f2504e0-4f89-41d3-9a0c-0305e82c3301"]);
    expect(validateSync(dto)).toEqual([]);
  });

  it("rejects a range on the single-day endpoint", () => {
    expect(
      errorsFor(DailyMovementDetailQueryDto, {
        date: "2026-09-11",
        startDate: "2026-09-01",
      }),
    ).toContain("startDate");
  });
});
