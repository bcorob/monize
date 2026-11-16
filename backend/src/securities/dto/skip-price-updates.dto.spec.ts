import { validate } from "class-validator";
import { CreateSecurityDto } from "./create-security.dto";
import { UpdateSecurityDto } from "./update-security.dto";

describe.each([CreateSecurityDto, UpdateSecurityDto])(
  "skipPriceUpdates DTO %p",
  (Dto) => {
    const errorsFor = async (value: unknown) =>
      (
        await validate(Object.assign(new Dto(), { skipPriceUpdates: value }))
      ).filter((e) => e.property === "skipPriceUpdates");

    it.each([undefined, false, true])(
      "accepts omission or explicit boolean %s",
      async (value) => {
        expect(await errorsFor(value)).toEqual([]);
      },
    );

    // The entity treats the field as non-nullable, so null is refused rather
    // than read as "no change".
    it.each([null, "true", 1])("rejects non-booleans %s", async (value) => {
      expect(await errorsFor(value)).toHaveLength(1);
    });
  },
);
