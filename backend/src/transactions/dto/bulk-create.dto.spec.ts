import "reflect-metadata";
import { validate, ValidationError } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  BULK_CREATE_MAX_ITEMS,
  BulkCreateTransactionsDto,
} from "./bulk-create.dto";
import { UpdateTransactionDto } from "./update-transaction.dto";

/** The options the global ValidationPipe validates every body with. */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

function buildDto(data: unknown): BulkCreateTransactionsDto {
  return plainToInstance(BulkCreateTransactionsDto, data);
}

/** Constraint names anywhere in the (nested) error tree. */
function constraintNames(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.keys(e.constraints ?? {}),
    ...constraintNames(e.children ?? []),
  ]);
}

const accountA = "d290f1ee-6c54-4b01-90e6-d701748f0851";
const accountB = "8f14e45f-ceea-467a-9575-9c9c1f2e8b3a";

const transaction = {
  accountId: accountA,
  transactionDate: "2026-09-01",
  amount: -12.5,
  currencyCode: "CAD",
  externalId: "bank-row-1",
};

const transfer = {
  fromAccountId: accountA,
  toAccountId: accountB,
  transactionDate: "2026-09-02",
  amount: 100,
  externalId: "bank-row-2",
};

describe("BulkCreateTransactionsDto", () => {
  it("accepts transaction rows and transfer rows, each with an externalId", async () => {
    const errors = await validate(
      buildDto({ items: [{ transaction }, { transfer }] }),
      PIPE_OPTIONS,
    );

    expect(errors).toHaveLength(0);
  });

  it("rejects a row carrying neither a transaction nor a transfer", async () => {
    const errors = await validate(buildDto({ items: [{}] }), PIPE_OPTIONS);

    expect(constraintNames(errors)).toContain("eachItemHasOneKind");
  });

  it("rejects a row carrying both, so the request fails before any row is written", async () => {
    const errors = await validate(
      buildDto({ items: [{ transaction }, { transaction, transfer }] }),
      PIPE_OPTIONS,
    );

    expect(constraintNames(errors)).toContain("eachItemHasOneKind");
  });

  it("rejects a row whose transfer is null and which has no transaction", async () => {
    const errors = await validate(
      buildDto({ items: [{ transfer: null }] }),
      PIPE_OPTIONS,
    );

    expect(constraintNames(errors)).toContain("eachItemHasOneKind");
  });

  it("validates the nested row exactly as the single-row route does", async () => {
    const errors = await validate(
      buildDto({
        items: [{ transaction: { ...transaction, amount: "lots" } }],
      }),
      PIPE_OPTIONS,
    );

    expect(constraintNames(errors)).toContain("isNumber");
  });

  it("refuses a field the single-row body does not have", async () => {
    const errors = await validate(
      buildDto({ items: [{ transaction: { ...transaction, userId: "x" } }] }),
      PIPE_OPTIONS,
    );

    expect(constraintNames(errors)).toContain("whitelistValidation");
  });

  it("rejects an empty list and one longer than the cap", async () => {
    const empty = await validate(buildDto({ items: [] }), PIPE_OPTIONS);
    const tooMany = await validate(
      buildDto({
        items: Array.from({ length: BULK_CREATE_MAX_ITEMS + 1 }, () => ({
          transaction,
        })),
      }),
      PIPE_OPTIONS,
    );

    expect(constraintNames(empty)).toContain("arrayMinSize");
    expect(constraintNames(tooMany)).toContain("arrayMaxSize");
  });

  it("rejects an empty externalId and one longer than the column", async () => {
    const errors = await validate(
      buildDto({
        items: [
          { transaction: { ...transaction, externalId: "" } },
          { transfer: { ...transfer, externalId: "x".repeat(256) } },
        ],
      }),
      PIPE_OPTIONS,
    );

    expect(constraintNames(errors)).toEqual(
      expect.arrayContaining(["isNotEmpty", "maxLength"]),
    );
  });
});

describe("UpdateTransactionDto", () => {
  it("does not accept an externalId: the key is set once, by the create", async () => {
    const dto = plainToInstance(UpdateTransactionDto, {
      externalId: "bank-row-1",
    });

    const errors = await validate(dto, PIPE_OPTIONS);

    expect(constraintNames(errors)).toContain("whitelistValidation");
  });
});
