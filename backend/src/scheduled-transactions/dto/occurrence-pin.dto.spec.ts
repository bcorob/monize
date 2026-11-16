import "reflect-metadata";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { PostScheduledTransactionDto } from "./post-scheduled-transaction.dto";
import { SkipScheduledTransactionDto } from "./skip-scheduled-transaction.dto";

// A26-S08-01: Post and Skip carry the occurrence the person was looking at.
// The date is required at the HTTP boundary; the override id is a UUID or null.
// Run through the production ValidationPipe configuration (main.ts).
describe.each([
  ["PostScheduledTransactionDto", PostScheduledTransactionDto],
  ["SkipScheduledTransactionDto", SkipScheduledTransactionDto],
])("%s occurrence pin", (_name, metatype) => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = { type: "body" as const, metatype, data: "" };
  const UUID = "11111111-2222-4333-8444-555555555555";
  const run = (body: Record<string, unknown>) => pipe.transform(body, metadata);

  it("accepts a date with no override id, a null id and a UUID", async () => {
    await expect(
      run({ expectedOccurrenceDate: "2026-09-01" }),
    ).resolves.toBeDefined();
    await expect(
      run({ expectedOccurrenceDate: "2026-09-01", expectedOverrideId: null }),
    ).resolves.toBeDefined();
    await expect(
      run({ expectedOccurrenceDate: "2026-09-01", expectedOverrideId: UUID }),
    ).resolves.toBeDefined();
  });

  it("rejects a missing expectedOccurrenceDate", async () => {
    await expect(run({})).rejects.toBeInstanceOf(BadRequestException);
    await expect(run({ expectedOverrideId: UUID })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    "2026-9-1",
    "2026-02-30",
    "not-a-date",
    "2026-09-01T00:00:00Z",
    20260901,
  ])("rejects the date %p", async (value) => {
    await expect(run({ expectedOccurrenceDate: value })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects an expectedOverrideId that is not a UUID", async () => {
    await expect(
      run({
        expectedOccurrenceDate: "2026-09-01",
        expectedOverrideId: "override-0",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
