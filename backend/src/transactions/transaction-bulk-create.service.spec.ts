import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { TransactionBulkCreateService } from "./transaction-bulk-create.service";
import {
  CreateTransactionOutcome,
  TransactionsService,
} from "./transactions.service";
import { JointRegisterService } from "./joint-register.service";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import { Transaction } from "./entities/transaction.entity";
import { TransferResult } from "./transaction-transfer.service";
import { BulkCreateTransactionsDto } from "./dto/bulk-create.dto";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { CreateTransferDto } from "./dto/create-transfer.dto";

const OWN_ACCOUNT = "acc-own";
const JOINT_ACCOUNT = "acc-joint";
const OTHER_ACCOUNT = "acc-other";
const actor = { effectiveUserId: "user-1", realUserId: "user-1" };

const txDto = (
  over: Partial<CreateTransactionDto> = {},
): CreateTransactionDto => ({
  accountId: OWN_ACCOUNT,
  transactionDate: "2026-09-01",
  amount: -10,
  currencyCode: "CAD",
  ...over,
});

const transferDto = (
  over: Partial<CreateTransferDto> = {},
): CreateTransferDto => ({
  fromAccountId: OWN_ACCOUNT,
  toAccountId: OTHER_ACCOUNT,
  transactionDate: "2026-09-01",
  amount: 50,
  ...over,
});

const row = (id: string) => ({ id }) as Transaction;

describe("TransactionBulkCreateService", () => {
  let transactionsService: {
    createWithOutcome: jest.Mock<Promise<CreateTransactionOutcome>>;
    createTransferWithOutcome: jest.Mock<
      Promise<{ transfer: TransferResult; created: boolean }>
    >;
  };
  let jointRegister: {
    createWithOutcome: jest.Mock<Promise<CreateTransactionOutcome>>;
  };
  let crossOwnerAccess: { isAccountOwnedBy: jest.Mock<Promise<boolean>> };
  let service: TransactionBulkCreateService;
  /** The order rows reached the services in, by externalId. */
  let written: string[];

  beforeEach(() => {
    written = [];
    let next = 0;
    transactionsService = {
      createWithOutcome: jest.fn(async (_userId, dto: CreateTransactionDto) => {
        written.push(dto.externalId ?? "");
        return { transaction: row(`tx-${++next}`), created: true };
      }),
      createTransferWithOutcome: jest.fn(
        async (_userId, dto: CreateTransferDto) => {
          written.push(dto.externalId ?? "");
          next += 1;
          return {
            transfer: {
              fromTransaction: row(`from-${next}`),
              toTransaction: row(`to-${next}`),
            },
            created: true,
          };
        },
      ),
    };
    jointRegister = {
      createWithOutcome: jest.fn(async () => ({
        transaction: row("tx-joint"),
        created: true,
      })),
    };
    crossOwnerAccess = {
      isAccountOwnedBy: jest.fn(
        async (accountId: string) => accountId !== JOINT_ACCOUNT,
      ),
    };
    service = new TransactionBulkCreateService(
      transactionsService as unknown as TransactionsService,
      crossOwnerAccess as unknown as CrossOwnerAccessService,
      jointRegister as unknown as JointRegisterService,
    );
  });

  const run = (items: BulkCreateTransactionsDto["items"]) =>
    service.createMany(actor, { items });

  it("creates each row through the single-row service call and reports it by index", async () => {
    const result = await run([
      { transaction: txDto({ externalId: "a" }) },
      { transfer: transferDto({ externalId: "b" }) },
    ]);

    expect(result).toEqual({
      created: 2,
      existing: 0,
      failed: 0,
      results: [
        { index: 0, kind: "transaction", status: "created", id: "tx-1" },
        {
          index: 1,
          kind: "transfer",
          status: "created",
          id: "from-2",
          linkedTransactionId: "to-2",
        },
      ],
    });
    expect(transactionsService.createWithOutcome).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ externalId: "a" }),
      { actorIsNotOwner: false },
    );
    expect(transactionsService.createTransferWithOutcome).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ externalId: "b" }),
      actor,
    );
  });

  it("writes rows in date order, keeping the request's order within a date, and still reports by index", async () => {
    const result = await run([
      {
        transaction: txDto({
          externalId: "late",
          transactionDate: "2026-09-03",
        }),
      },
      {
        transaction: txDto({
          externalId: "first",
          transactionDate: "2026-09-01",
        }),
      },
      {
        transfer: transferDto({
          externalId: "mid-1",
          transactionDate: "2026-09-02",
        }),
      },
      {
        transaction: txDto({
          externalId: "mid-2",
          transactionDate: "2026-09-02",
        }),
      },
    ]);

    expect(written).toEqual(["first", "mid-1", "mid-2", "late"]);
    expect(result.results.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(result.results[0].id).toBe("tx-4");
  });

  it("routes a row in an account the caller does not own through the joint register", async () => {
    const result = await run([
      { transaction: txDto({ accountId: JOINT_ACCOUNT }) },
    ]);

    expect(crossOwnerAccess.isAccountOwnedBy).toHaveBeenCalledWith(
      JOINT_ACCOUNT,
      "user-1",
    );
    expect(jointRegister.createWithOutcome).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ accountId: JOINT_ACCOUNT }),
    );
    expect(transactionsService.createWithOutcome).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      status: "created",
      id: "tx-joint",
    });
  });

  it("reports a row whose externalId already named a row as existing", async () => {
    transactionsService.createWithOutcome.mockResolvedValueOnce({
      transaction: row("tx-old"),
      created: false,
    });
    transactionsService.createTransferWithOutcome.mockResolvedValueOnce({
      transfer: {
        fromTransaction: row("from-old"),
        toTransaction: row("to-old"),
      },
      created: false,
    });

    const result = await run([
      { transaction: txDto({ externalId: "a" }) },
      { transfer: transferDto({ externalId: "b" }) },
    ]);

    expect(result).toMatchObject({ created: 0, existing: 2, failed: 0 });
    expect(result.results).toEqual([
      { index: 0, kind: "transaction", status: "existing", id: "tx-old" },
      {
        index: 1,
        kind: "transfer",
        status: "existing",
        id: "from-old",
        linkedTransactionId: "to-old",
      },
    ]);
  });

  it("reports a failed row with the status and message the single-row route answers, and goes on", async () => {
    transactionsService.createWithOutcome
      .mockRejectedValueOnce(new NotFoundException("Account not found"))
      .mockRejectedValueOnce(
        new BadRequestException({
          message: "Currency is inactive",
          errorCode: "CURRENCY_INACTIVE",
        }),
      );

    const result = await run([
      { transaction: txDto() },
      { transaction: txDto() },
      { transaction: txDto() },
    ]);

    expect(result).toMatchObject({ created: 1, existing: 0, failed: 2 });
    expect(result.results[0]).toEqual({
      index: 0,
      kind: "transaction",
      status: "failed",
      error: { statusCode: 404, message: "Account not found" },
    });
    expect(result.results[1].error).toEqual({
      statusCode: 400,
      message: "Currency is inactive",
      errorCode: "CURRENCY_INACTIVE",
    });
    expect(result.results[2].status).toBe("created");
  });

  it("forwards a refusal's structured errors list, as the single-row route does", async () => {
    const problems = [{ path: "actions[0]", code: "invalid" }];
    transactionsService.createWithOutcome.mockRejectedValueOnce(
      new BadRequestException({ message: "Rule invalid", errors: problems }),
    );

    const result = await run([{ transaction: txDto() }]);

    expect(result.results[0].error).toEqual({
      statusCode: 400,
      message: "Rule invalid",
      errors: problems,
    });
  });

  it("answers a row-level-security refusal with 403, as the global filter does", async () => {
    const originalMode = process.env.RLS_MODE;
    process.env.RLS_MODE = "enforce";
    try {
      transactionsService.createWithOutcome.mockRejectedValueOnce(
        new QueryFailedError(
          "INSERT",
          [],
          Object.assign(
            new Error(
              'new row violates row-level security policy for table "transactions"',
            ),
            { code: "42501" },
          ),
        ),
      );

      const result = await run([{ transaction: txDto() }]);

      expect(result.results[0].error).toEqual({
        statusCode: 403,
        message: "Access denied",
      });
    } finally {
      if (originalMode === undefined) delete process.env.RLS_MODE;
      else process.env.RLS_MODE = originalMode;
    }
  });

  it("maps a database refusal as the global filter does, and hides an unexpected error's detail", async () => {
    const dbError = (code: string) =>
      new QueryFailedError(
        "INSERT",
        [],
        Object.assign(new Error("db said no"), { code }),
      );
    transactionsService.createWithOutcome
      .mockRejectedValueOnce(dbError("23505"))
      .mockRejectedValueOnce(dbError("23503"))
      .mockRejectedValueOnce(new Error("connection reset: secret detail"));
    transactionsService.createTransferWithOutcome.mockRejectedValueOnce(
      new ConflictException("This externalId is already used"),
    );

    const result = await run([
      { transaction: txDto() },
      { transaction: txDto() },
      { transaction: txDto() },
      { transfer: transferDto() },
    ]);

    expect(result.results.map((r) => r.error?.statusCode)).toEqual([
      409, 400, 500, 409,
    ]);
    expect(result.results[2].error?.message).toBe("Internal server error");
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });
});
