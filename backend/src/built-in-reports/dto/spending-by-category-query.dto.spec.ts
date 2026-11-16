import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { SpendingByCategoryQueryDto } from "./spending-by-category-query.dto";

const base = { endDate: "2025-12-31" };

async function errorsFor(extra: Record<string, unknown>) {
  const dto = plainToInstance(SpendingByCategoryQueryDto, {
    ...base,
    ...extra,
  });
  return { dto, errors: await validate(dto) };
}

describe("SpendingByCategoryQueryDto tag filter", () => {
  it("accepts a request with neither tag param (today's request)", async () => {
    const { errors } = await errorsFor({});
    expect(errors).toEqual([]);
  });

  it("accepts a key and a value, trimmed", async () => {
    const { dto, errors } = await errorsFor({
      tagKey: " scope ",
      tagValue: " household ",
    });
    expect(errors).toEqual([]);
    expect(dto.tagKey).toBe("scope");
    expect(dto.tagValue).toBe("household");
  });

  it("refuses a key without a value", async () => {
    const { errors } = await errorsFor({ tagKey: "scope" });
    expect(errors.map((e) => e.property)).toEqual(["tagValue"]);
  });

  it("refuses a value without a key", async () => {
    const { errors } = await errorsFor({ tagValue: "household" });
    expect(errors.map((e) => e.property)).toEqual(["tagKey"]);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["a repeated key (array)", ["a", "b"]],
    ["too long", "x".repeat(101)],
  ])("refuses a %s tag value", async (_name, value) => {
    const { errors } = await errorsFor({ tagKey: "scope", tagValue: value });
    expect(errors.map((e) => e.property)).toContain("tagValue");
  });
});
