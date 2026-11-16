import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { MonthlyCategoryBreakdownQueryDto } from "./monthly-category-breakdown-query.dto";

const ID = "11111111-1111-4111-8111-111111111111";

async function check(extra: Record<string, unknown>) {
  const dto = plainToInstance(MonthlyCategoryBreakdownQueryDto, {
    endDate: "2025-12-31",
    ...extra,
  });
  return { dto, errors: await validate(dto) };
}

describe("MonthlyCategoryBreakdownQueryDto", () => {
  it("accepts a request with no account filter (today's request)", async () => {
    const { dto, errors } = await check({});
    expect(errors).toEqual([]);
    expect(dto.accountIds).toBeUndefined();
  });

  it("splits a comma-separated list of ids", async () => {
    const { dto, errors } = await check({ accountIds: `${ID}, ${ID}` });
    expect(errors).toEqual([]);
    expect(dto.accountIds).toEqual([ID, ID]);
  });

  it("refuses a non-UUID id", async () => {
    const { errors } = await check({ accountIds: "not-a-uuid" });
    expect(errors.map((e) => e.property)).toEqual(["accountIds"]);
  });

  it("refuses more than 200 ids", async () => {
    const { errors } = await check({
      accountIds: Array.from({ length: 201 }, () => ID).join(","),
    });
    expect(errors.map((e) => e.property)).toEqual(["accountIds"]);
  });
});
