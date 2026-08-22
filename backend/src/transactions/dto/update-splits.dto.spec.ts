import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { UpdateSplitsDto } from "./update-splits.dto";

function buildDto(data: any): UpdateSplitsDto {
  return plainToInstance(UpdateSplitsDto, data, {
    enableImplicitConversion: true,
  });
}

describe("UpdateSplitsDto", () => {
  const validSplit = {
    categoryId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
    amount: 50.0,
  };

  it("accepts valid splits array", async () => {
    const dto = buildDto({ splits: [validSplit] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts empty splits array", async () => {
    const dto = buildDto({ splits: [] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects missing splits field", async () => {
    const dto = buildDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("splits");
  });

  it("rejects non-array splits", async () => {
    const dto = buildDto({ splits: "not-an-array" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("splits");
  });

  it("rejects more than 100 splits", async () => {
    const splits = Array.from({ length: 101 }, () => ({ ...validSplit }));
    const dto = buildDto({ splits });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("splits");
    expect(errors[0].constraints).toHaveProperty("arrayMaxSize");
  });

  it("accepts exactly 100 splits", async () => {
    const splits = Array.from({ length: 100 }, () => ({ ...validSplit }));
    const dto = buildDto({ splits });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // R7-F1: `sourceSplitId` is scheduled-transaction split correlation metadata
  // (issue #1167). It must NOT leak into the shared ordinary-transaction split
  // serializer, because the ordinary CreateTransactionSplitDto does not declare
  // it and the global pipe rejects unknown properties -- so a serializer that
  // emitted it would 400 every ordinary split edit and duplicate. These run the
  // payload through the ACTUAL production ValidationPipe (whitelist +
  // forbidNonWhitelisted + transform), which the raw `validate()` cases above do
  // not exercise.
  describe("R7-F1: sourceSplitId must not reach the ordinary split DTO", () => {
    // Same options main.ts installs globally.
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const metadata = {
      type: "body" as const,
      metatype: UpdateSplitsDto,
      data: "",
    };

    it("accepts an ordinary split with no sourceSplitId (the serializer's output)", async () => {
      await expect(
        pipe.transform({ splits: [{ ...validSplit }] }, metadata),
      ).resolves.toBeDefined();
    });

    it("rejects an ordinary split that carries sourceSplitId", async () => {
      await expect(
        pipe.transform(
          { splits: [{ ...validSplit, sourceSplitId: "not-a-real-field" }] },
          metadata,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
