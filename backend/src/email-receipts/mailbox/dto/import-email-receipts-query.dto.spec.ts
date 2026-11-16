import { ValidationPipe } from "@nestjs/common";
import { ImportEmailReceiptsQueryDto } from "./import-email-receipts-query.dto";

describe("ImportEmailReceiptsQueryDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const check = (value: unknown) =>
    pipe.transform(value, {
      type: "query",
      metatype: ImportEmailReceiptsQueryDto,
    }) as Promise<ImportEmailReceiptsQueryDto>;

  it("accepts no query, true and false", async () => {
    await expect(check({})).resolves.toEqual({});
    await expect(check({ process: "true" })).resolves.toMatchObject({
      process: "true",
    });
    await expect(check({ process: "false" })).resolves.toMatchObject({
      process: "false",
    });
  });

  it.each([["yes"], ["1"], [""], ["FALSE"], [["false", "true"]], [false]])(
    "refuses %p",
    async (value) => {
      await expect(check({ process: value })).rejects.toMatchObject({
        status: 400,
      });
    },
  );

  it("refuses an unknown query key", async () => {
    await expect(check({ other: "1" })).rejects.toMatchObject({ status: 400 });
  });
});
