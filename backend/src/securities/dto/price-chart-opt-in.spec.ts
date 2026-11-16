import { validate } from "class-validator";
import { CreateSecurityDto } from "./create-security.dto";
import { UpdateSecurityDto } from "./update-security.dto";

describe.each([CreateSecurityDto, UpdateSecurityDto])(
  "price chart opt-in DTO %p",
  (Dto) => {
    it.each([undefined, false, true])(
      "accepts omission or explicit boolean %s",
      async (value) => {
        const dto = Object.assign(new Dto(), { priceChartEnabled: value });
        expect(
          (await validate(dto)).filter(
            (e) => e.property === "priceChartEnabled",
          ),
        ).toEqual([]);
      },
    );
    it.each([null, "true", 1])("rejects non-booleans %s", async (value) => {
      const dto = Object.assign(new Dto(), { priceChartEnabled: value });
      expect(
        (await validate(dto)).filter((e) => e.property === "priceChartEnabled"),
      ).toHaveLength(1);
    });
  },
);
