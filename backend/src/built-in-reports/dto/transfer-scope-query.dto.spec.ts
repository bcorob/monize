import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { IncomeVsExpensesQueryDto } from "./income-vs-expenses-query.dto";
import { CashFlowQueryDto } from "./cash-flow-query.dto";

const ID = "11111111-1111-4111-8111-111111111111";

describe.each([
  ["IncomeVsExpensesQueryDto", IncomeVsExpensesQueryDto],
  ["CashFlowQueryDto", CashFlowQueryDto],
] as const)("%s transferScopeAccountIds (spec 10.8.1)", (_name, Dto) => {
  async function check(extra: Record<string, unknown>) {
    const dto = plainToInstance(Dto, { endDate: "2025-12-31", ...extra });
    return { dto, errors: await validate(dto) };
  }

  it("is optional (today's request)", async () => {
    const { dto, errors } = await check({});
    expect(errors).toEqual([]);
    expect(dto.transferScopeAccountIds).toBeUndefined();
  });

  it("splits a comma-separated list of ids", async () => {
    const { dto, errors } = await check({
      transferScopeAccountIds: `${ID}, ${ID}`,
    });
    expect(errors).toEqual([]);
    expect(dto.transferScopeAccountIds).toEqual([ID, ID]);
  });

  it("refuses a non-UUID id", async () => {
    const { errors } = await check({ transferScopeAccountIds: "not-a-uuid" });
    expect(errors.map((e) => e.property)).toEqual(["transferScopeAccountIds"]);
  });

  it("refuses more than 200 ids", async () => {
    const { errors } = await check({
      transferScopeAccountIds: Array.from({ length: 201 }, () => ID).join(","),
    });
    expect(errors.map((e) => e.property)).toEqual(["transferScopeAccountIds"]);
  });
});
