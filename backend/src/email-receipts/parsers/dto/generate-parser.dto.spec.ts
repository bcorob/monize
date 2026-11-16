import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { GenerateParserWithAiDto } from "./email-receipt-parser.dto";

const R1 = "30000000-0000-4000-8000-000000000001";
const R2 = "30000000-0000-4000-8000-000000000002";
const T1 = "40000000-0000-4000-8000-000000000001";

const errors = async (body: Record<string, unknown>): Promise<string[]> =>
  (
    await validate(plainToInstance(GenerateParserWithAiDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe("GenerateParserWithAiDto", () => {
  it("accepts a receipt request with paired samples, as before", async () => {
    expect(
      await errors({
        domain: "shop.example.com",
        samples: [{ receiptId: R1, transactionId: T1 }],
      }),
    ).toEqual([]);
  });

  // Which array the kind needs is the service's check
  // (email-receipt-parser-generate.service.spec.ts); here, each is bounded
  // whenever it is sent, whatever the kind.
  it("bounds the other kind's array too, so neither is ever unbounded", async () => {
    expect(
      await errors({
        domain: "shop.example.com",
        samples: [{ receiptId: R1, transactionId: T1 }],
        tradeReceiptIds: [R1, R2, R1, R2, R1, R2],
      }),
    ).toContain("tradeReceiptIds");
    expect(
      await errors({
        domain: "wealthsimple.com",
        kind: "trade",
        tradeReceiptIds: [R1],
        samples: [{ receiptId: "x", transactionId: T1 }],
      }),
    ).toContain("samples");
  });

  it("accepts a trade request with emails only", async () => {
    expect(
      await errors({
        domain: "wealthsimple.com",
        kind: "trade",
        tradeReceiptIds: [R1, R2],
      }),
    ).toEqual([]);
  });

  it.each([
    ["no emails", { tradeReceiptIds: [] }],
    ["a repeated email", { tradeReceiptIds: [R1, R1] }],
    ["more than five emails", { tradeReceiptIds: [R1, R2, R1, R2, R1, R2] }],
    ["an id that is not a uuid", { tradeReceiptIds: ["x"] }],
  ])("refuses a trade request with %s", async (_why, body) => {
    expect(
      await errors({ domain: "wealthsimple.com", kind: "trade", ...body }),
    ).toContain("tradeReceiptIds");
  });

  it("refuses an unknown kind", async () => {
    expect(
      await errors({
        domain: "shop.example.com",
        kind: "bond",
        samples: [{ receiptId: R1, transactionId: T1 }],
      }),
    ).toContain("kind");
  });
});
