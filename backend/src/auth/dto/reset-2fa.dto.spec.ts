import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { Reset2faDto } from "./reset-2fa.dto";

const errorsFor = (body: Record<string, unknown>) =>
  validate(plainToInstance(Reset2faDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe("Reset2faDto", () => {
  it.each(["123456", "abcd-ef01", "ABCD-EF01"])(
    "accepts a password with code %s",
    async (code) => {
      expect(await errorsFor({ currentPassword: "pw", code })).toHaveLength(0);
    },
  );

  it("refuses a missing code: there is no password-only reset", async () => {
    const errors = await errorsFor({ currentPassword: "pw" });
    expect(errors.map((e) => e.property)).toContain("code");
  });

  it.each(["", "12345", "1234567", "abcdef01", "ghij-klmn", 123456])(
    "rejects code %p",
    async (code) => {
      const errors = await errorsFor({ currentPassword: "pw", code });
      expect(errors.map((e) => e.property)).toContain("code");
    },
  );

  it("refuses a missing or overlong password", async () => {
    expect(
      (await errorsFor({ code: "123456" })).map((e) => e.property),
    ).toContain("currentPassword");
    expect(
      (
        await errorsFor({ currentPassword: "x".repeat(129), code: "123456" })
      ).map((e) => e.property),
    ).toContain("currentPassword");
  });

  it("refuses a field it does not know", async () => {
    const errors = await errorsFor({
      currentPassword: "pw",
      code: "123456",
      userId: "someone-else",
    });
    expect(errors.map((e) => e.property)).toContain("userId");
  });
});
