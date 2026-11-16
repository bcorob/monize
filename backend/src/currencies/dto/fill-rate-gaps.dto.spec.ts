import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { FillRateGapsDto } from "./fill-rate-gaps.dto";

const build = (payload: unknown) => plainToInstance(FillRateGapsDto, payload);

describe("FillRateGapsDto", () => {
  it("accepts a three-letter code", async () => {
    const dto = build({ code: "EUR" });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.code).toBe("EUR");
  });

  it("uppercases a lowercase code before validation", async () => {
    const dto = build({ code: "eur" });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.code).toBe("EUR");
  });

  it("rejects a code that is not three characters", async () => {
    const errors = await validate(build({ code: "EU" }));
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("code");
    expect(errors[0].constraints).toHaveProperty("isLength");
  });

  it("rejects a three-character code that is not letters", async () => {
    const errors = await validate(build({ code: "E1R" }));
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty("matches");
  });

  it("rejects a non-string code", async () => {
    const errors = await validate(build({ code: 123 }));
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty("isString");
  });

  it("rejects a missing code", async () => {
    const errors = await validate(build({}));
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("code");
  });
});
