import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  DetectMortgageTypeDto,
  MAX_MORTGAGE_TYPE_SAMPLES,
} from "./detect-mortgage-type.dto";

// Mirrors the global ValidationPipe (whitelist + forbidNonWhitelisted), so a
// field the DTO does not declare is refused here as it is on the route.
const validateStrict = (payload: object) =>
  validate(plainToInstance(DetectMortgageTypeDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const sample = { principal: 833.33, interest: 500, balanceBefore: 300000 };
const valid = {
  samples: [sample, { principal: 833.33, interest: 498.61 }],
  interestRate: 2,
  paymentFrequency: "MONTHLY",
};

describe("DetectMortgageTypeDto", () => {
  it("accepts samples with and without a balance, and a null rate", async () => {
    expect(await validateStrict(valid)).toHaveLength(0);
    expect(await validateStrict({ ...valid, interestRate: null })).toHaveLength(
      0,
    );
  });

  it("accepts one sample or none, which the detector answers with a reason", async () => {
    expect(await validateStrict({ ...valid, samples: [sample] })).toHaveLength(
      0,
    );
    expect(await validateStrict({ ...valid, samples: [] })).toHaveLength(0);
  });

  it.each([
    ["a field the DTO does not declare", { ...valid, userId: "someone" }],
    [
      "a field a sample does not declare",
      { ...valid, samples: [{ ...sample, date: "2024-01-01" }, sample] },
    ],
    [
      "more samples than the bound",
      {
        ...valid,
        samples: Array.from(
          { length: MAX_MORTGAGE_TYPE_SAMPLES + 1 },
          () => sample,
        ),
      },
    ],
    [
      "a negative principal",
      { ...valid, samples: [{ ...sample, principal: -1 }, sample] },
    ],
    [
      "a zero balance",
      { ...valid, samples: [{ ...sample, balanceBefore: 0 }, sample] },
    ],
    [
      "an amount past the money bound",
      { ...valid, samples: [{ ...sample, interest: 1e13 }, sample] },
    ],
    ["a rate above 100", { ...valid, interestRate: 101 }],
    ["an unknown frequency", { ...valid, paymentFrequency: "QUARTERLY" }],
    ["a missing frequency", { samples: valid.samples }],
    ["samples that are not an array", { ...valid, samples: sample }],
  ])("refuses %s", async (_label, payload) => {
    expect((await validateStrict(payload)).length).toBeGreaterThan(0);
  });
});
