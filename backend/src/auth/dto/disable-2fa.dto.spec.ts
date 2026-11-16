import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { Disable2faDto } from "./disable-2fa.dto";

const errorsFor = (code: unknown) =>
  validate(plainToInstance(Disable2faDto, { code }));

describe("Disable2faDto", () => {
  it.each(["123456", "abcd-ef01", "ABCD-EF01"])("accepts %s", async (code) => {
    expect(await errorsFor(code)).toHaveLength(0);
  });

  it.each(["12345", "1234567", "abcdef01", "abcd_ef01", "ghij-klmn", 123456])(
    "rejects %p",
    async (code) => {
      expect(await errorsFor(code)).not.toHaveLength(0);
    },
  );
});
