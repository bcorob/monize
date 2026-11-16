import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { InvestmentSplitDto } from "../../transactions/dto/create-transaction-split.dto";
import { CreateInvestmentTransactionDto } from "./create-investment-transaction.dto";
import { TransferSecurityDto } from "./transfer-security.dto";
import { UpdateInvestmentTransactionDto } from "./update-investment-transaction.dto";

const UUID = "11111111-1111-5111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";

const bases: Array<[string, new () => object, Record<string, unknown>]> = [
  [
    "CreateInvestmentTransactionDto",
    CreateInvestmentTransactionDto,
    { accountId: ACCOUNT, action: "BUY", transactionDate: "2026-10-15" },
  ],
  ["UpdateInvestmentTransactionDto", UpdateInvestmentTransactionDto, {}],
  [
    "TransferSecurityDto",
    TransferSecurityDto,
    {
      fromAccountId: ACCOUNT,
      toAccountId: "33333333-3333-4333-8333-333333333333",
      securityId: "44444444-4444-4444-8444-444444444444",
      transactionDate: "2026-10-15",
      quantity: 1,
      costPerShare: 100,
    },
  ],
  ["InvestmentSplitDto", InvestmentSplitDto, { action: "BUY" }],
];

describe.each(bases)(
  "%s: the optional bondInstrumentId",
  (_name, Dto, base) => {
    const errorsOf = async (value: unknown) =>
      (
        await validate(
          plainToInstance(Dto, { ...base, bondInstrumentId: value }) as object,
          { whitelist: true, forbidNonWhitelisted: true },
        )
      ).filter((e) => e.property === "bondInstrumentId");

    it("is optional and nullable", async () => {
      expect(await errorsOf(undefined)).toEqual([]);
      expect(await errorsOf(null)).toEqual([]);
    });

    it("accepts a UUID and stores it in one canonical (lower-case) spelling", async () => {
      expect(await errorsOf(UUID)).toEqual([]);
      expect(
        (
          plainToInstance(Dto, {
            ...base,
            bondInstrumentId: UUID.toUpperCase(),
          }) as { bondInstrumentId?: string }
        ).bondInstrumentId,
      ).toBe(UUID);
    });

    it.each(["", "EDO1036", "not-a-uuid", 7, {}, [UUID]])(
      "refuses %p",
      async (value) => {
        expect((await errorsOf(value)).length).toBeGreaterThan(0);
      },
    );
  },
);
