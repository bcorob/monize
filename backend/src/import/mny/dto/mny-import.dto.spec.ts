import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { MnyAccountOptionDto } from "./mny-import.dto";

async function overrideResult(currencyOverride: unknown) {
  const dto = plainToInstance(MnyAccountOptionDto, {
    handle: 1,
    include: true,
    currencyOverride,
  });
  const errors = await validate(dto);
  return {
    error: errors.find((e) => e.property === "currencyOverride"),
    value: dto.currencyOverride,
  };
}

describe("MnyAccountOptionDto currencyOverride validation", () => {
  it.each(["q#!", "US", "USDD", "U5D", 123])("rejects %p", async (value) => {
    expect((await overrideResult(value)).error).toBeDefined();
  });

  it.each([null, undefined, ""])("treats %p as no override", async (value) => {
    expect((await overrideResult(value)).error).toBeUndefined();
  });

  it("accepts a code and upper-cases a lower-case one", async () => {
    expect((await overrideResult("CAD")).error).toBeUndefined();
    const lower = await overrideResult("pln");
    expect(lower.error).toBeUndefined();
    expect(lower.value).toBe("PLN");
  });
});
