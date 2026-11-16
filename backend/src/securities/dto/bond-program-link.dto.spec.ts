import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateSecurityDto } from "./create-security.dto";
import { UpdateSecurityDto } from "./update-security.dto";

const UUID = "11111111-1111-5111-8111-111111111111";

describe.each([CreateSecurityDto, UpdateSecurityDto])(
  "bond program link DTO %p",
  (Dto) => {
    const errors = async (value: unknown) =>
      (
        await validate(Object.assign(new Dto(), { bondProgramId: value }), {
          skipMissingProperties: false,
        })
      ).filter((e) => e.property === "bondProgramId");

    it.each([undefined, null, UUID])(
      "accepts omission, null (unlink) or a UUID: %s",
      async (value) => {
        expect(await errors(value)).toEqual([]);
      },
    );

    it.each(["", "not-a-uuid", 42, "11111111-1111-5111-8111-11111111111g"])(
      "rejects anything else: %p",
      async (value) => {
        expect(await errors(value)).toHaveLength(1);
      },
    );
  },
);

describe.each([CreateSecurityDto, UpdateSecurityDto])(
  "bond program link spelling in %p",
  (Dto) => {
    it("is canonicalized to lower case, so the same program is never a different link", () => {
      const dto = plainToInstance(Dto, {
        bondProgramId: UUID.toUpperCase(),
      });
      expect(dto.bondProgramId).toBe(UUID);
    });

    it("leaves null (unlink) and an absent id alone", () => {
      expect(
        plainToInstance(Dto, { bondProgramId: null }).bondProgramId,
      ).toBeNull();
      expect(plainToInstance(Dto, {}).bondProgramId).toBeUndefined();
    });
  },
);

describe.each([CreateSecurityDto, UpdateSecurityDto])(
  "the auto-fetch switch of %p",
  (Dto) => {
    const errors = async (value: unknown) =>
      (
        await validate(Object.assign(new Dto(), { bondAutoFetch: value }), {
          skipMissingProperties: false,
        })
      ).filter((e) => e.property === "bondAutoFetch");

    it.each([undefined, true, false])("accepts %p", async (value) => {
      expect(await errors(value)).toEqual([]);
    });

    it.each(["true", 1, null, {}])("rejects %p", async (value) => {
      expect(await errors(value)).toHaveLength(1);
    });
  },
);
