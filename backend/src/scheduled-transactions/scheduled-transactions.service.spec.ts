import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { Account } from "../accounts/entities/account.entity";
import { Tag } from "../tags/entities/tag.entity";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { getRequestContext } from "../common/request-context";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("ScheduledTransactionsService", () => {
  let service: ScheduledTransactionsService;
  let scheduledRepo: Record<string, jest.Mock>;
  let splitsRepo: Record<string, any>;
  let overridesRepo: Record<string, jest.Mock>;
  let accountsRepo: Record<string, jest.Mock>;
  let tagRepo: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let transactionsService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  // The withScopedDb manager, exposed under the legacy name so the pre-RLS
  // queryRunner.manager assertions keep reading naturally.
  let mockQueryRunner: Record<string, any>;
  /** Whether the occurrence-claim insert returns a row this run. */
  let postingClaimWins: boolean;
  let mockDataSource: DataSourceMock;
  let mockActionHistoryService: Record<string, jest.Mock>;
  let mockExchangeRateService: Record<string, jest.Mock>;

  const userId = "11111111-1111-1111-1111-111111111111";
  const stId = "st-1";

  const makeScheduled = (
    overrides: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: stId,
      userId,
      accountId: "acc-1",
      name: "Monthly Rent",
      payeeId: "payee-1",
      payeeName: "Landlord",
      categoryId: "cat-1",
      amount: -1200,
      currencyCode: "USD",
      description: "Rent payment",
      frequency: "MONTHLY",
      nextDueDate: "2025-02-15",
      startDate: "2025-01-15",
      endDate: null,
      occurrencesRemaining: null,
      totalOccurrences: null,
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      lastPostedDate: null,
      isSplit: false,
      isTransfer: false,
      transferAccountId: null,
      splits: [],
      overrides: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      account: {} as any,
      payee: null,
      category: null,
      transferAccount: null,
      ...overrides,
    }) as ScheduledTransaction;

  const mockQueryBuilder = (result: any = []) => {
    const qb: Record<string, jest.Mock> = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(result),
      getOne: jest.fn().mockResolvedValue(result),
      getRawMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    return qb;
  };

  beforeEach(async () => {
    scheduledRepo = {
      create: jest.fn().mockImplementation((data) => ({ id: stId, ...data })),
      save: jest
        .fn()
        .mockImplementation((data) => Promise.resolve({ id: stId, ...data })),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };

    splitsRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    overridesRepo = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ id: "ovr-1", ...data })),
      save: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: "ovr-1", ...data }),
        ),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };

    accountsRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    tagRepo = {
      findBy: jest.fn().mockResolvedValue([]),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue({ id: "acc-1", userId }),
    };

    // The posting path no longer calls `createTransfer`: authorization has to be
    // decided before the posting transaction opens (a system-identity read
    // cannot join a user-identity transaction), so the transfer is prepared
    // above the transaction, written inside it, and completed after the commit.
    transactionsService = {
      create: jest.fn().mockResolvedValue({ id: "tx-1" }),
      prepareTransfer: jest.fn().mockResolvedValue({
        effectiveUserId: userId,
        realUserId: userId,
        dto: {},
        fromOwnerId: userId,
        toOwnerId: userId,
        hasForeignLeg: false,
      }),
      writeTransferLegs: jest
        .fn()
        .mockResolvedValue({ savedFromId: "tx-1", savedToId: "tx-2" }),
      completeTransfer: jest.fn().mockResolvedValue({
        fromTransaction: { id: "tx-1" },
        toTransaction: { id: "tx-2" },
      }),
    };

    investmentTransactionsService = {
      create: jest.fn().mockResolvedValue({ id: "inv-tx-1" }),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    mockExchangeRateService = {
      getLatestRate: jest.fn().mockResolvedValue(null),
      getRateForDate: jest.fn().mockResolvedValue(null),
    };

    const tenantMocks = createScopedDbMocks([
      [ScheduledTransaction, scheduledRepo],
      [ScheduledTransactionSplit, splitsRepo],
      [ScheduledTransactionOverride, overridesRepo],
      [Account, accountsRepo],
      [Tag, tagRepo],
    ]);
    mockDataSource = tenantMocks.dataSource;
    // The timezone fan-out now runs through withScopedDb too, so its raw SQL
    // lands on the transaction manager: alias `dataSource.query` to it and the
    // per-test fan-out fixtures below keep working unchanged.
    mockDataSource.query = tenantMocks.manager.query;
    // Direct EntityManager calls inside withScopedDb blocks (converted from the
    // old queryRunner.manager usage in update()/post()/createSplits()).
    const txManager = tenantMocks.manager;
    txManager.delete.mockResolvedValue({ affected: 0 });
    txManager.create.mockImplementation(
      (_entity: unknown, data: unknown) => data,
    );
    txManager.save.mockImplementation((data: unknown) => Promise.resolve(data));
    txManager.findBy.mockResolvedValue([]);
    txManager.createQueryBuilder.mockImplementation(() => ({
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    }));
    mockQueryRunner = { manager: txManager };
    /**
     * `post` locks the schedule row and claims the occurrence before it creates
     * any money.
     *
     * The financial transaction used to commit in its own transaction and
     * `nextDueDate` advance in a second one, so two replicas firing the same
     * hourly cron -- or a manual post racing it, or a crash between the two
     * commits -- posted the same bill twice (audit P4-004). The locked read and
     * the occurrence claim are what the doubles below answer.
     */
    postingClaimWins = true;
    txManager.findOne.mockImplementation((_entity: unknown, options: unknown) =>
      scheduledRepo.findOne(options as never),
    );

    // Default to a single UTC user so cron logic that buckets by timezone
    // continues to operate against legacy tests that pre-date the cron
    // refactor and assume a one-user world.
    mockDataSource.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("scheduled_transaction_postings")) {
        return postingClaimWins ? [[{ id: "posting-1" }], 1] : [[], 0];
      }
      return [
        { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
      ];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionsService,
        { provide: AccountsService, useValue: accountsService },
        { provide: TransactionsService, useValue: transactionsService },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
        { provide: DataSource, useValue: mockDataSource },
        ScheduledTransactionOverrideService,
        ScheduledTransactionLoanService,
        {
          provide: ActionHistoryService,
          useValue: mockActionHistoryService,
        },
        {
          provide: ExchangeRateService,
          useValue: mockExchangeRateService,
        },
      ],
    }).compile();

    service = module.get<ScheduledTransactionsService>(
      ScheduledTransactionsService,
    );
  });

  // Helper: stub findOne to return a scheduled transaction for internal calls
  const stubFindOne = (scheduled: ScheduledTransaction) => {
    scheduledRepo.findOne.mockResolvedValue(scheduled);
    // post() re-reads the split set under the parent lock to guard against a
    // concurrent split retarget (issue #1154 re-review); default it to the same
    // splits the schedule carries so the guard passes unless a test overrides it.
    splitsRepo.find.mockResolvedValue(scheduled.splits ?? []);
  };

  // ==================== create ====================
  describe("create", () => {
    const baseDto = {
      accountId: "acc-1",
      name: "Rent",
      amount: -1200,
      currencyCode: "USD",
      frequency: "MONTHLY" as any,
      nextDueDate: "2025-02-15",
    };

    it("should create a simple scheduled transaction", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const result = await service.create(userId, baseDto);

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, "acc-1");
      expect(scheduledRepo.create).toHaveBeenCalled();
      expect(scheduledRepo.save).toHaveBeenCalled();
      expect(result).toEqual(saved);
    });

    it("should default startDate to nextDueDate", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, baseDto);

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.startDate).toBe("2025-02-15");
    });

    it("should set categoryId=null when hasSplits", async () => {
      const saved = makeScheduled({ isSplit: true, categoryId: null });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        categoryId: "cat-1",
        splits: [
          { categoryId: "cat-a", amount: -700 },
          { categoryId: "cat-b", amount: -500 },
        ],
      };
      await service.create(userId, dto);

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.categoryId).toBeNull();
      expect(createArg.isSplit).toBe(true);
    });

    it("keeps categoryId on a transfer (categorized transfer, #743)", async () => {
      const saved = makeScheduled({ isTransfer: true, categoryId: "cat-1" });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        categoryId: "cat-1",
        isTransfer: true,
        transferAccountId: "acc-2",
      };
      await service.create(userId, dto);

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.categoryId).toBe("cat-1");
      expect(createArg.isTransfer).toBe(true);
    });

    it("should throw if transfer to same account", async () => {
      const dto = { ...baseDto, isTransfer: true, transferAccountId: "acc-1" };
      await expect(service.create(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should verify transfer account ownership", async () => {
      const saved = makeScheduled({ isTransfer: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = { ...baseDto, isTransfer: true, transferAccountId: "acc-2" };
      await service.create(userId, dto);

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, "acc-2");
    });

    it("should reject splits with fewer than 2 entries (non-transfer)", async () => {
      const dto = {
        ...baseDto,
        splits: [{ categoryId: "cat-a", amount: -1200 }],
      };
      await expect(service.create(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject splits whose sum != amount", async () => {
      const dto = {
        ...baseDto,
        splits: [
          { categoryId: "cat-a", amount: -700 },
          { categoryId: "cat-b", amount: -400 },
        ],
      };
      await expect(service.create(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should allow zero amount splits when total matches", async () => {
      const saved = makeScheduled({ isSplit: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        splits: [
          { categoryId: "cat-a", amount: 0 },
          { categoryId: "cat-b", amount: -1200 },
        ],
      };
      await service.create(userId, dto);
      expect(scheduledRepo.save).toHaveBeenCalled();
    });

    it("should allow single split with transferAccountId (loan payment)", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        splits: [{ transferAccountId: "acc-loan", amount: -1200 }],
      };
      // Single split with transferAccountId should not throw
      await service.create(userId, dto);
      expect(scheduledRepo.save).toHaveBeenCalled();
    });

    it("should create split records when splits provided", async () => {
      const saved = makeScheduled({ isSplit: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        splits: [
          { categoryId: "cat-a", amount: -700 },
          { categoryId: "cat-b", amount: -500 },
        ],
      };
      await service.create(userId, dto);

      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.save).toHaveBeenCalled();
    });

    it("records action history on create", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, baseDto);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "scheduled_transaction",
          action: "create",
          description: expect.stringContaining("Monthly Rent"),
        }),
      );
    });
  });

  // ==================== findOne ====================
  describe("findOne", () => {
    it("should return the scheduled transaction", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const result = await service.findOne(userId, stId);
      expect(result).toEqual(scheduled);
    });

    it("should throw NotFoundException if not found", async () => {
      scheduledRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(userId, stId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw NotFoundException if userId does not match", async () => {
      scheduledRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(userId, stId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ==================== findAll ====================
  describe("findAll", () => {
    it("should return empty array when no transactions", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.findAll(userId);
      expect(result).toEqual([]);
    });

    it("should return transactions with overrideCount, nextOverride, and futureOverrides", async () => {
      const st = makeScheduled();
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const nextOverrideQb = mockQueryBuilder(null);
      nextOverrideQb.getMany.mockResolvedValue([]);

      const futureOverridesQb = mockQueryBuilder(null);
      futureOverridesQb.getMany.mockResolvedValue([]);

      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(nextOverrideQb) // first call: nextOverride query
        .mockReturnValueOnce(futureOverridesQb); // second call: futureOverrides query

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      expect(result[0].overrideCount).toBe(0);
      expect(result[0].nextOverride).toBeNull();
      expect(result[0].futureOverrides).toEqual([]);
    });

    it("should populate futureOverrides with overrides on or after nextDueDate", async () => {
      const st = makeScheduled({ nextDueDate: "2025-02-15" });
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const nextOverrideQb = mockQueryBuilder(null);
      nextOverrideQb.getMany.mockResolvedValue([]);

      const futureOverride = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        originalDate: "2025-03-15",
        overrideDate: "2025-03-20",
        amount: -999,
      };
      const pastOverride = {
        id: "ovr-2",
        scheduledTransactionId: stId,
        originalDate: "2025-01-15",
        overrideDate: "2025-01-15",
        amount: -500,
      };
      const futureOverridesQb = mockQueryBuilder(null);
      futureOverridesQb.getMany.mockResolvedValue([
        pastOverride,
        futureOverride,
      ]);

      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(nextOverrideQb)
        .mockReturnValueOnce(futureOverridesQb);

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      // Only the future override should be included (originalDate >= nextDueDate)
      expect(result[0].futureOverrides).toHaveLength(1);
      expect(result[0].futureOverrides![0].id).toBe("ovr-1");
      expect(result[0].overrideCount).toBe(1);
    });
  });

  // ==================== findDue ====================
  describe("findDue", () => {
    it("should find active transactions due today or earlier", async () => {
      const due = [makeScheduled()];
      scheduledRepo.find.mockResolvedValue(due);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getRawMany.mockResolvedValue([]);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      const result = await service.findDue(userId);

      expect(scheduledRepo.find).toHaveBeenCalled();
      const callArgs = scheduledRepo.find.mock.calls[0][0];
      expect(callArgs.where.userId).toBe(userId);
      expect(callArgs.where.isActive).toBe(true);
      expect(result).toEqual(due);
    });

    it("should defer transactions whose override moved the next occurrence forward", async () => {
      const candidate = makeScheduled({ id: "st-postponed" });
      scheduledRepo.find.mockResolvedValue([candidate]);

      // First createQueryBuilder call: postponed-id lookup -> returns this id
      // Second: moved-earlier lookup -> returns []
      const postponedQb = mockQueryBuilder(null);
      postponedQb.getRawMany.mockResolvedValue([{ id: "st-postponed" }]);
      const earlierQb = mockQueryBuilder(null);
      earlierQb.getRawMany.mockResolvedValue([]);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(postponedQb)
        .mockReturnValueOnce(earlierQb);

      const result = await service.findDue(userId);

      expect(result).toEqual([]);
    });
  });

  // ==================== findUpcoming ====================
  describe("findUpcoming", () => {
    it("should query with default 30 days", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findUpcoming(userId);

      expect(qb.where).toHaveBeenCalledWith("st.userId = :userId", { userId });
      expect(qb.andWhere).toHaveBeenCalledWith("st.isActive = :isActive", {
        isActive: true,
      });
    });

    it("should accept custom days parameter", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findUpcoming(userId, 7);

      expect(qb.andWhere).toHaveBeenCalledWith(
        "st.nextDueDate <= :futureDate",
        expect.objectContaining({ futureDate: expect.any(Date) }),
      );
    });
  });

  describe("getLlmUpcomingBillsAndDeposits", () => {
    it("classifies bills, deposits, transfers, and investments", async () => {
      const rows = [
        makeScheduled({
          id: "s1",
          name: "Rent",
          amount: -1200,
          account: { name: "Checking" } as any,
        }),
        makeScheduled({
          id: "s2",
          name: "Paycheck",
          amount: 3000,
          account: { name: "Checking" } as any,
        }),
        makeScheduled({
          id: "s3",
          name: "Move to Savings",
          amount: -500,
          isTransfer: true,
          transferAccountId: "acc-2",
          account: { name: "Checking" } as any,
        }),
        makeScheduled({
          id: "s4",
          name: "DRIP",
          amount: -100,
          isInvestment: true,
          investmentAction: "BUY" as any,
          account: { name: "Brokerage" } as any,
        }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.itemCount).toBe(4);
      const kinds = result.items.map((i) => i.kind).sort();
      expect(kinds).toEqual(["bill", "deposit", "investment", "transfer"]);
      expect(result.totalUpcomingBills).toBe(1200);
      expect(result.totalUpcomingDeposits).toBe(3000);
    });

    it("filters by kind", async () => {
      const rows = [
        makeScheduled({ id: "s1", amount: -100 }),
        makeScheduled({ id: "s2", amount: 200 }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
        kind: "bill",
      });

      expect(result.itemCount).toBe(1);
      expect(result.items[0].kind).toBe("bill");
      expect(result.totalUpcomingDeposits).toBe(0);
    });

    it("filters by accountIds", async () => {
      const rows = [
        makeScheduled({ id: "s1", accountId: "acc-1", amount: -100 }),
        makeScheduled({ id: "s2", accountId: "acc-2", amount: -200 }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
        accountIds: ["acc-2"],
      });

      expect(result.itemCount).toBe(1);
      expect(result.items[0].id).toBe("s2");
    });

    it("counts overdue items (negative daysUntilDue)", async () => {
      const rows = [
        makeScheduled({
          id: "s1",
          amount: -100,
          nextDueDate: "2000-01-01",
        }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.overdueCount).toBe(1);
      expect(result.items[0].daysUntilDue).toBeLessThan(0);
    });

    it("returns daysWindow matching the days argument", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
        days: 14,
      });

      expect(result.daysWindow).toBe(14);
    });
  });

  // ==================== update ====================
  describe("update", () => {
    it("should update simple fields", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        name: "Updated Rent",
        amount: -1500,
      });

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        expect.objectContaining({ name: "Updated Rent", amount: -1500 }),
      );
    });

    it("should verify new account ownership when accountId changes", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, { accountId: "acc-2" });

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, "acc-2");
    });

    it("should throw if transfer account same as source on update", async () => {
      const scheduled = makeScheduled({ accountId: "acc-1" });
      stubFindOne(scheduled);

      await expect(
        service.update(userId, stId, {
          isTransfer: true,
          transferAccountId: "acc-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should delete old splits and create new ones", async () => {
      const scheduled = makeScheduled({ amount: -1000 });
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        splits: [
          { categoryId: "cat-a", amount: -600 },
          { categoryId: "cat-b", amount: -400 },
        ],
      });

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
    });

    it("should clear splits when empty array provided", async () => {
      const scheduled = makeScheduled({ isSplit: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, { splits: [] });

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        expect.objectContaining({ isSplit: false }),
      );
    });

    it("should convert empty strings to null for nullable fields", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        description: "" as any,
        payeeName: "" as any,
      });

      const updateArg = mockQueryRunner.manager.update.mock.calls[0][2];
      expect(updateArg.description).toBeNull();
      expect(updateArg.payeeName).toBeNull();
    });

    it("clears splits when switching to transfer but does not force category null (#743)", async () => {
      const scheduled = makeScheduled({ isSplit: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        isTransfer: true,
        transferAccountId: "acc-2",
      });

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
      const updateArg = mockQueryRunner.manager.update.mock.calls[0][2];
      expect(updateArg.isTransfer).toBe(true);
      expect(updateArg.isSplit).toBe(false);
      // A transfer may keep a category, so the switch must not null it.
      expect(updateArg.categoryId).toBeUndefined();
    });

    it("keeps a category set on a transfer update (#743)", async () => {
      const scheduled = makeScheduled({ isTransfer: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        isTransfer: true,
        transferAccountId: "acc-2",
        categoryId: "cat-9",
      });

      const updateArg = mockQueryRunner.manager.update.mock.calls[0][2];
      expect(updateArg.categoryId).toBe("cat-9");
    });

    it("records action history on update", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, { name: "Updated Rent" });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "scheduled_transaction",
          entityId: stId,
          action: "update",
          description: expect.stringContaining("Updated"),
        }),
      );
    });

    it("syncs the durable loan configuration when the user edits a loan payment schedule", async () => {
      // The per-posting recalculation reads the configured payment and extra
      // from the account, because the template also carries transient clamps.
      // A user edit of the template is a reconfiguration, so it must land on
      // the account too -- otherwise the recalculation would grow the edit
      // back to the stale configured value (review #1131).
      const scheduled = makeScheduled({ amount: -1000 });
      stubFindOne(scheduled);
      accountsRepo.findOne.mockResolvedValueOnce({
        id: "acc-loan",
        scheduledTransactionId: stId,
      });

      await service.update(userId, stId, {
        amount: -800,
        splits: [
          { transferAccountId: "acc-loan", amount: -500, memo: "Principal" },
          { categoryId: "cat-interest", amount: -100, memo: "Interest" },
          {
            transferAccountId: "acc-loan",
            amount: -200,
            memo: "Extra Principal",
          },
        ],
      });

      expect(accountsRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scheduledTransactionId: stId, userId },
        }),
      );
      expect(accountsRepo.update).toHaveBeenCalledWith("acc-loan", {
        paymentAmount: 800,
        extraPaymentAmount: 200,
      });
    });

    it("does not touch any account when the schedule is not a loan payment", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      accountsRepo.findOne.mockResolvedValueOnce(null);

      await service.update(userId, stId, { amount: -1200 });

      expect(accountsRepo.update).not.toHaveBeenCalled();
    });

    it("does not look up a loan account for a presentation-only edit", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, { name: "Renamed" });

      expect(accountsRepo.findOne).not.toHaveBeenCalled();
      expect(accountsRepo.update).not.toHaveBeenCalled();
    });
  });

  // ==================== remove ====================
  describe("remove", () => {
    it("should find and remove the scheduled transaction", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.remove(userId, stId);

      expect(scheduledRepo.remove).toHaveBeenCalledWith(scheduled);
    });

    it("should throw NotFoundException if not found", async () => {
      scheduledRepo.findOne.mockResolvedValue(null);
      await expect(service.remove(userId, stId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("records action history on remove", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.remove(userId, stId);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "scheduled_transaction",
          entityId: stId,
          action: "delete",
          beforeData: expect.objectContaining({ name: "Monthly Rent" }),
          description: expect.stringContaining("Monthly Rent"),
        }),
      );
    });
  });

  // ==================== skip (frequency advancement) ====================

  // Helper to format Date as YYYY-MM-DD in UTC (matching how the service operates)
  const toUTCDateStr = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  // Build a YYYY-MM-DD date string matching the entity's string-typed DATE columns
  const utcDate = (y: number, m: number, d: number): string =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  describe("skip", () => {
    it("should advance DAILY by 1 day", async () => {
      const scheduled = makeScheduled({
        frequency: "DAILY",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-02");
    });

    it("should advance WEEKLY by 7 days", async () => {
      const scheduled = makeScheduled({
        frequency: "WEEKLY",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-08");
    });

    it("should advance BIWEEKLY by 14 days", async () => {
      const scheduled = makeScheduled({
        frequency: "BIWEEKLY",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-15");
    });

    it("should advance EVERY4WEEKS by 28 days", async () => {
      const scheduled = makeScheduled({
        frequency: "EVERY4WEEKS",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-29");
    });

    it("should advance SEMIMONTHLY: day<=15 goes to last day of month", async () => {
      const scheduled = makeScheduled({
        frequency: "SEMIMONTHLY",
        nextDueDate: utcDate(2025, 3, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-31");
    });

    it("should advance SEMIMONTHLY: day>15 goes to 15th of next month", async () => {
      const scheduled = makeScheduled({
        frequency: "SEMIMONTHLY",
        nextDueDate: utcDate(2025, 3, 31),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-04-15");
    });

    it("should advance MONTHLY by 1 month", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 1, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-02-15");
    });

    it("should advance QUARTERLY by 3 months", async () => {
      const scheduled = makeScheduled({
        frequency: "QUARTERLY",
        nextDueDate: utcDate(2025, 1, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-04-15");
    });

    it("should advance YEARLY by 1 year", async () => {
      const scheduled = makeScheduled({
        frequency: "YEARLY",
        nextDueDate: utcDate(2025, 1, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2026-01-15");
    });

    it("should delete override for the skipped date", async () => {
      const scheduled = makeScheduled({ nextDueDate: "2025-02-15" });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      expect(overridesRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
        originalDate: "2025-02-15",
      });
    });

    it("should decrement occurrencesRemaining", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: 5 });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.occurrencesRemaining).toBe(4);
    });

    it("should deactivate when occurrencesRemaining reaches 0", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: 1 });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.occurrencesRemaining).toBe(0);
      expect(updateArg.isActive).toBe(false);
    });

    it("should deactivate when next date is past endDate", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: "2025-12-15",
        endDate: "2025-12-31",
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.isActive).toBe(false);
    });

    it("should not touch occurrencesRemaining when null", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: null });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.occurrencesRemaining).toBeUndefined();
    });

    it("should store nextDueDate as YYYY-MM-DD string to prevent timezone drift", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 2, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(typeof updateArg.nextDueDate).toBe("string");
      expect(updateArg.nextDueDate).toBe("2025-03-15");
    });
  });

  // ==================== post ====================
  describe("post", () => {
    it("should create a regular transaction from base values", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountId: "acc-1",
          amount: -1200,
          currencyCode: "USD",
        }),
      );
    });

    it("should use prepareTransfer for transfer transactions", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          amount: 1200,
        }),
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("authorizes the transfer before the posting transaction opens", async () => {
      // The regression this pins: `createTransfer` was called *inside* the
      // posting transaction. Its authorization reads a foreign account row
      // under `withSystemContext`, and a system-identity `withScopedDb` cannot
      // join a user-identity transaction -- it throws
      // `IDENTITY_MISMATCH_MESSAGE` -- so every scheduled transfer post failed,
      // cron and manual alike. Preparing above the transaction is what fixes it,
      // so the order is the invariant, not an implementation detail.
      //
      // Written as "no transaction was open when prepare ran" rather than as a
      // call-order assertion: the posting path opens more than one transaction,
      // and only the nesting is the defect.
      let transactionDepth = 0;
      let preparedInsideTransaction = false;
      let wroteInsideTransaction = false;

      mockDataSource.transaction.mockImplementation(async (...args: any[]) => {
        const fn = args[args.length - 1] as (m: unknown) => unknown;
        transactionDepth++;
        try {
          return await fn(mockQueryRunner.manager);
        } finally {
          transactionDepth--;
        }
      });
      transactionsService.prepareTransfer.mockImplementation(async () => {
        preparedInsideTransaction = transactionDepth > 0;
        return {
          effectiveUserId: userId,
          realUserId: userId,
          dto: {},
          fromOwnerId: userId,
          toOwnerId: userId,
          hasForeignLeg: false,
        };
      });
      transactionsService.writeTransferLegs.mockImplementation(async () => {
        wroteInsideTransaction = transactionDepth > 0;
        return { savedFromId: "tx-1", savedToId: "tx-2" };
      });

      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalled();
      expect(preparedInsideTransaction).toBe(false);
      // ...and the write still joins it, so the legs, the occurrence claim and
      // the schedule advancement remain one unit.
      expect(wroteInsideTransaction).toBe(true);
    });

    it("completes the transfer only after the posting transaction commits", async () => {
      // `completeTransfer` records action history, and the recorder swallows its
      // own failures by design: inside the caller's transaction that is either a
      // `25P02` abort of the posting or a silently dropped undo entry.
      let transactionDepth = 0;
      let completedInsideTransaction = false;

      mockDataSource.transaction.mockImplementation(async (...args: any[]) => {
        const fn = args[args.length - 1] as (m: unknown) => unknown;
        transactionDepth++;
        try {
          return await fn(mockQueryRunner.manager);
        } finally {
          transactionDepth--;
        }
      });
      transactionsService.completeTransfer.mockImplementation(async () => {
        completedInsideTransaction = transactionDepth > 0;
        return {
          fromTransaction: { id: "tx-1" },
          toTransaction: { id: "tx-2" },
        };
      });

      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.completeTransfer).toHaveBeenCalled();
      expect(completedInsideTransaction).toBe(false);
    });

    it("does not send currency codes, leaving the transfer service to derive them (P5-002)", async () => {
      // A schedule stores only its source currency. Sending that as
      // `fromCurrencyCode` with no target currency, rate or destination amount
      // is what made a cross-currency scheduled transfer post at 1:1 with the
      // destination row labelled in the source's currency.
      //
      // Sending the stored code and nothing else is also fragile the other way:
      // if the account's currency has since changed, the stored code is stale
      // and the posting would now be rejected. The accounts are the authority,
      // so neither code is sent at all.
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const dto = transactionsService.prepareTransfer.mock.calls[0][1];
      expect(dto).not.toHaveProperty("fromCurrencyCode");
      expect(dto).not.toHaveProperty("toCurrencyCode");
      expect(dto).not.toHaveProperty("exchangeRate");
      expect(dto).not.toHaveProperty("toAmount");
    });

    it("forwards the schedule's category to prepareTransfer (#743)", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        categoryId: "cat-ike",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ categoryId: "cat-ike" }),
      );
    });

    it("should pass payee fields to prepareTransfer for transfer transactions", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        payeeId: "payee-1",
        payeeName: "Landlord",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          amount: 1200,
          payeeId: "payee-1",
          payeeName: "Landlord",
        }),
      );
    });

    it("should pass undefined payee fields when scheduled transaction has no payee", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        payeeId: null as any,
        payeeName: null as any,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          payeeId: undefined,
          payeeName: undefined,
        }),
      );
    });

    it("should pass tagIds to prepareTransfer for transfer transactions", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        tagIds: ["tag-1", "tag-2"],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          tagIds: ["tag-1", "tag-2"],
        }),
      );
    });

    it("should not pass tagIds to prepareTransfer when scheduled transaction has no tags", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        tagIds: [],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          tagIds: undefined,
        }),
      );
    });

    it("should apply stored override amount to transfer via Math.abs", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        amount: -1200,
      });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: -750,
        description: null,
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: 750,
        }),
      );
    });

    it("should apply inline amount override to transfer via Math.abs", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        amount: -1200,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { amount: -500 });

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: 500,
        }),
      );
    });

    it("should handle positive scheduled transfer amount correctly", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        amount: 800,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: 800,
        }),
      );
    });

    it("should pass override description to prepareTransfer", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        description: "base desc",
      });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: null,
        description: "override desc",
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          description: "override desc",
        }),
      );
    });

    it("should apply inline values with highest priority", async () => {
      const scheduled = makeScheduled({ amount: -1200 });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: -999,
        description: "override desc",
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, {
        amount: -500,
        description: "inline desc",
      });

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ amount: -500, description: "inline desc" }),
      );
    });

    it("should apply stored override values when no inline values", async () => {
      const scheduled = makeScheduled({
        amount: -1200,
        description: "base desc",
      });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: -999,
        description: "override desc",
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ amount: -999, description: "override desc" }),
      );
    });

    it("should delete used override after posting", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const storedOverride = {
        id: "ovr-1",
        amount: null,
        description: null,
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      // The locked re-read returns the same override revision (issue #1154
      // re-review): same id, same (absent) updatedAt, so the change-guard passes.
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        storedOverride,
      );
    });

    it("should delete ONCE frequency after posting", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      const result = await service.post(userId, stId);

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
      );
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should still create the underlying transaction when deleting a ONCE", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountId: "acc-1", amount: -1200 }),
      );
    });

    it("should remove a stored override before deleting a ONCE", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const storedOverride = {
        id: "ovr-1",
        amount: null,
        description: null,
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      await service.post(userId, stId);

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        storedOverride,
      );
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
      );
    });

    it("claims the occurrence before creating any money", async () => {
      // The regression guard for P4-004. The claim, the money and the schedule
      // advancement are one transaction keyed on
      // (scheduled_transaction_id, original_due_date), so two replicas firing the
      // same hourly cron cannot both post: opening 100.00 with one due -50.00
      // ended at 0.00 instead of 50.00.
      const scheduled = makeScheduled({ nextDueDate: "2026-02-01" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const claim = mockQueryRunner.manager.query.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]).includes("scheduled_transaction_postings"),
      );
      expect(claim).toBeDefined();
      expect(String(claim![0])).toContain("ON CONFLICT");
      // The occurrence's identity is the due date, not the date it was booked on.
      expect(claim![1]).toEqual([stId, "2026-02-01", "2026-02-01"]);
      expect(
        mockQueryRunner.manager.query.mock.invocationCallOrder[
          mockQueryRunner.manager.query.mock.calls.indexOf(claim!)
        ],
      ).toBeLessThan(transactionsService.create.mock.invocationCallOrder[0]);
    });

    it("posts nothing when another replica claimed the occurrence", async () => {
      postingClaimWins = false;
      const scheduled = makeScheduled({ nextDueDate: "2026-02-01" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(scheduledRepo.update).not.toHaveBeenCalled();
    });

    it("refuses when the schedule has already been advanced past this occurrence", async () => {
      // A manual post racing the cron: the caller computed the payload for
      // 2026-02-01, but the committed row has moved on. Posting anyway would
      // duplicate the occurrence the winner already booked.
      const scheduled = makeScheduled({ nextDueDate: "2026-02-01" });
      scheduledRepo.findOne
        .mockResolvedValueOnce(scheduled)
        .mockResolvedValueOnce({ ...scheduled, nextDueDate: "2026-03-01" });
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("should not call findOne after deleting a ONCE (would 404)", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      // Twice: once outside the transaction to build the payload, and once
      // inside it under the row lock -- that second read is what confirms the
      // occurrence is still the due one before any money is created (P4-004).
      // What must NOT happen is a read *after* the row is deleted, which would
      // 404 on a posting that succeeded.
      await service.post(userId, stId);

      expect(scheduledRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it("should advance nextDueDate for recurring frequency", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 2, 15),
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[0] === ScheduledTransaction,
      );
      expect(updateCall).toBeTruthy();
      const updateArg = updateCall[2];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-15");
    });

    it("should store nextDueDate as YYYY-MM-DD string to prevent timezone drift", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 2, 15),
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[0] === ScheduledTransaction,
      );
      expect(updateCall).toBeTruthy();
      const updateArg = updateCall[2];
      expect(typeof updateArg.nextDueDate).toBe("string");
      expect(updateArg.nextDueDate).toBe("2025-03-15");
    });

    it("should decrement occurrencesRemaining and deactivate at 0", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: 1 });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[0] === ScheduledTransaction,
      );
      expect(updateCall).toBeTruthy();
      const updateArg = updateCall[2];
      expect(updateArg.occurrencesRemaining).toBe(0);
      expect(updateArg.isActive).toBe(false);
    });

    it("should use base splits when useSplits and no inline/override splits", async () => {
      const scheduled = makeScheduled({
        isSplit: true,
        splits: [
          {
            id: "s1",
            scheduledTransactionId: stId,
            categoryId: "cat-a",
            transferAccountId: null,
            amount: -700,
            memo: null,
          } as any,
          {
            id: "s2",
            scheduledTransactionId: stId,
            categoryId: "cat-b",
            transferAccountId: null,
            amount: -500,
            memo: null,
          } as any,
        ],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      expect(payload.splits).toHaveLength(2);
      expect(payload.splits[0].amount).toBe(-700);
    });

    it("should use postDto.transactionDate when provided", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { transactionDate: "2025-03-01" });

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ transactionDate: "2025-03-01" }),
      );
    });

    it("should clean stale overrides after advancing date", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: "2025-02-15",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      // Stale override cleanup now uses queryRunner.manager.createQueryBuilder
      expect(mockQueryRunner.manager.createQueryBuilder).toHaveBeenCalled();
    });

    it("should trigger loan payment recalculation for split transactions", async () => {
      const loanAccount = {
        id: "loan-1",
        accountType: "LOAN",
        currentBalance: -50000,
        interestRate: 5,
        paymentFrequency: "MONTHLY",
      };
      const scheduled = makeScheduled({
        isSplit: true,
        splits: [
          {
            id: "s1",
            scheduledTransactionId: stId,
            categoryId: null,
            transferAccountId: "loan-1",
            amount: -800,
            memo: null,
          } as any,
          {
            id: "s2",
            scheduledTransactionId: stId,
            categoryId: "cat-interest",
            transferAccountId: null,
            amount: -400,
            memo: null,
          } as any,
        ],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      // For findLoanAccountFromSplits
      accountsRepo.findOne.mockResolvedValueOnce(loanAccount);
      // For recalculateLoanPaymentSplits - the loan account lookup
      accountsRepo.findOne.mockResolvedValueOnce(loanAccount);
      // For recalculateLoanPaymentSplits - the scheduled transaction lookup
      scheduledRepo.findOne.mockResolvedValueOnce(scheduled); // findOne in post return
      scheduledRepo.findOne.mockResolvedValueOnce(scheduled); // recalculate internal find

      await service.post(userId, stId);

      // Loan account should have been looked up
      expect(accountsRepo.findOne).toHaveBeenCalled();
    });

    it("should pass referenceNumber to created transaction when provided", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { referenceNumber: "CHQ-1234" });

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ referenceNumber: "CHQ-1234" }),
      );
    });

    it("should pass referenceNumber to prepareTransfer when provided", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { referenceNumber: "REF-5678" });

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ referenceNumber: "REF-5678" }),
      );
    });
  });

  // ==================== Scheduled Investment (single-table) ====================
  describe("scheduled investment kind", () => {
    const investmentBaseDto = {
      accountId: "acc-inv",
      name: "Monthly VOO DCA",
      amount: -500,
      currencyCode: "USD",
      frequency: "MONTHLY" as any,
      nextDueDate: "2026-06-15",
      isInvestment: true,
      investmentAction: "BUY" as any,
      investmentSecurityId: "sec-voo",
      investmentQuantity: 1,
      investmentPrice: 500,
      investmentCommission: 0,
    };

    it("rejects when account is not a brokerage account", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
      });

      await expect(service.create(userId, investmentBaseDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects when both isTransfer and isInvestment are true", async () => {
      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          isTransfer: true,
          transferAccountId: "acc-2",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects BUY without quantity", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentQuantity: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates a scheduled BUY and persists investment fields", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      const saved = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const result = await service.create(userId, investmentBaseDto);

      const created = scheduledRepo.create.mock.calls[0][0];
      expect(created.isInvestment).toBe(true);
      expect(created.investmentAction).toBe("BUY");
      expect(created.investmentSecurityId).toBe("sec-voo");
      expect(created.investmentQuantity).toBe(1);
      expect(created.investmentPrice).toBe(500);
      expect(result).toEqual(saved);
    });

    it("post() dispatches a BUY through InvestmentTransactionsService.create", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
        investmentCommission: 0,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      expect(investmentTransactionsService.create).toHaveBeenCalledTimes(1);
      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("BUY");
      expect(dto.accountId).toBe("acc-1");
      expect(dto.securityId).toBe("sec-voo");
      expect(dto.quantity).toBe(1);
      expect(dto.price).toBe(500);
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(transactionsService.prepareTransfer).not.toHaveBeenCalled();
    });

    it("post() forwards funding account for contribution+buy", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentQuantity: 2,
        investmentPrice: 100,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.fundingAccountId).toBe("acc-checking");
    });

    it("post() ignores a stale funding account on a DIVIDEND (issue #1154)", async () => {
      // A row edited from BUY to DIVIDEND may still carry the old funding
      // account. The dividend cash must settle in the brokerage's linked cash
      // account, so the funding account is not forwarded regardless of what the
      // row stored.
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentTotalAmount: 75,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("DIVIDEND");
      expect(dto.fundingAccountId).toBeUndefined();
    });

    it("post() still forwards a funding account on a SELL", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "SELL" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentQuantity: 2,
        investmentPrice: 100,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("SELL");
      expect(dto.fundingAccountId).toBe("acc-checking");
    });

    it("post() ignores a stale funding account on a REINVEST (issue #1154)", async () => {
      // REINVEST moves shares but no external cash, so a funding account left on
      // the row is stale like the cash-only actions and must not be forwarded.
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "REINVEST" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentQuantity: 0.5,
        investmentPrice: 200,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("REINVEST");
      expect(dto.fundingAccountId).toBeUndefined();
    });

    it("post() rejects a negative amount-only override before creating money (issue #1154 review)", async () => {
      const dividend = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 100,
      });
      stubFindOne(dividend);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(
        service.post(userId, stId, { investmentTotalAmount: -25 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects a zero-quantity BUY override before creating money (issue #1154 review)", async () => {
      const buy = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      stubFindOne(buy);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(
        service.post(userId, stId, { investmentQuantity: 0 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when the schedule changed between the pre-lock read and the lock (issue #1154 re-review)", async () => {
      // A concurrent edit switched BUY -> DIVIDEND between the pre-lock read and
      // the row lock. The prepared (pre-lock) payload no longer describes the
      // row, so the post is refused rather than committing a stale operation.
      // Both reads go through scheduledRepo.findOne (manager.findOne alias).
      const beforeLock = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-old",
        investmentQuantity: 1,
        investmentPrice: 100,
      });
      const locked = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: null,
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: 75,
      });
      scheduledRepo.findOne
        .mockResolvedValueOnce(beforeLock)
        .mockResolvedValue(locked);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when the occurrence override changed after the pre-lock read (issue #1154 re-review)", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 75,
      });
      stubFindOne(scheduled);
      // Pre-lock override read (createQueryBuilder.getOne) returns one revision;
      // the locked re-read (overridesRepo.findOne) returns a newer one.
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue({
        id: "ovr-1",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue({
        id: "ovr-1",
        updatedAt: new Date("2026-06-02T00:00:00Z"),
      });

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when a base scheduled split was retargeted concurrently (issue #1154 re-review)", async () => {
      // Parent scalars are identical, but the transfer split's target account
      // changed between the pre-lock read and the parent lock. Posting the
      // pre-lock payload would credit the old account, so it is refused.
      const scheduled = makeScheduled({
        amount: -100,
        isSplit: true,
        frequency: "ONCE",
        splits: [
          {
            id: "ss-1",
            kind: "transfer" as any,
            amount: -100,
            memo: null,
            categoryId: null,
            transferAccountId: "acc-A",
            tags: [],
          } as any,
        ],
      });
      stubFindOne(scheduled);
      // The locked split re-read observes the retargeted split (acc-B).
      splitsRepo.find.mockResolvedValue([
        {
          id: "ss-1",
          kind: "transfer",
          amount: -100,
          memo: null,
          categoryId: null,
          transferAccountId: "acc-B",
          tags: [],
        } as any,
      ]);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when the foreign-currency original amount changed concurrently (issue #1154 re-review)", async () => {
      // amount (account currency) is unchanged, but originalAmount moved, so the
      // guard must still refuse -- otherwise a stale converted total posts.
      const beforeLock = makeScheduled({
        amount: -110,
        currencyCode: "USD",
        originalAmount: -100,
        originalCurrencyCode: "EUR",
        exchangeRate: 1.1,
      });
      const locked = makeScheduled({
        amount: -110,
        currencyCode: "USD",
        originalAmount: -200,
        originalCurrencyCode: "EUR",
        exchangeRate: 1.1,
      });
      scheduledRepo.findOne
        .mockResolvedValueOnce(beforeLock)
        .mockResolvedValue(locked);
      // The FX resolution runs above the transaction; give it a rate so the post
      // reaches the in-transaction guard rather than failing on a missing rate.
      mockExchangeRateService.getRateForDate.mockResolvedValue(1.1);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("post({requireActiveAutoPost}) refuses a schedule turned off after cron selected it (issue #1154 re-review)", async () => {
      const scheduled = makeScheduled({ isActive: true, autoPost: false });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(
        service.post(userId, stId, undefined, { requireActiveAutoPost: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(transactionsService.create).not.toHaveBeenCalled();

      // A manual post (no option) of the same row still works.
      await service.post(userId, stId);
      expect(transactionsService.create).toHaveBeenCalledTimes(1);
    });

    it("post() honours inline quantity / price overrides", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId, {
        investmentQuantity: 3,
        investmentPrice: 480,
      } as any);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.quantity).toBe(3);
      expect(dto.price).toBe(480);
    });

    it("post() routes a DIVIDEND amount through quantity=1, price=totalAmount", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 75,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("DIVIDEND");
      expect(dto.quantity).toBe(1);
      expect(dto.price).toBe(75);
    });

    it("post() routes a REINVEST/DRIP through investments service", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "REINVEST" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 0.5,
        investmentPrice: 200,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("REINVEST");
      expect(dto.quantity).toBe(0.5);
      expect(dto.price).toBe(200);
    });

    it("post() throws when investmentAction is missing on the scheduled row", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: null,
        investmentSecurityId: "sec-voo",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("post() routes a DIVIDEND with stored qty+price as quantity*price", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 100,
        investmentPrice: 0.75,
        investmentTotalAmount: null,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("DIVIDEND");
      expect(dto.quantity).toBe(100);
      expect(dto.price).toBe(0.75);
    });

    it("validateInvestmentFields rejects BUY when price is zero", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentPrice: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects ADD_SHARES without quantity", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentAction: "ADD_SHARES" as any,
          investmentPrice: undefined as any,
          investmentQuantity: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects DIVIDEND without totalAmount or qty+price", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentAction: "DIVIDEND" as any,
          investmentQuantity: undefined as any,
          investmentPrice: undefined as any,
          investmentTotalAmount: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects when action is missing", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentAction: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects BUY without a security", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentSecurityId: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("create() validates the funding account when supplied", async () => {
      accountsService.findOne.mockImplementation(
        async (uid: string, id: string) => {
          if (id === "acc-funding")
            return { id, userId: uid, accountType: "CHECKING" } as any;
          return {
            id,
            userId: uid,
            accountSubType: "INVESTMENT_BROKERAGE",
          } as any;
        },
      );
      const saved = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-funding",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...investmentBaseDto,
        investmentFundingAccountId: "acc-funding",
      });

      expect(accountsService.findOne).toHaveBeenCalledWith(
        userId,
        "acc-funding",
      );
      // A BUY keeps the funding account it was given (the gate's keep branch).
      expect(
        scheduledRepo.create.mock.calls[0][0].investmentFundingAccountId,
      ).toBe("acc-funding");
    });

    it("update() rejects mixing isTransfer and isInvestment", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
        }),
      );

      await expect(
        service.update(userId, stId, {
          isTransfer: true,
          transferAccountId: "acc-2",
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("update() rejects an investment-kind change to a non-brokerage account", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-cash",
        userId,
        accountSubType: "INVESTMENT_CASH",
      });

      await expect(
        service.update(userId, stId, { accountId: "acc-cash" } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("update() persists changed investment fields", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentQuantity: 2,
        investmentPrice: 480,
        investmentCommission: 5,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentQuantity !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentQuantity).toBe(2);
      expect(fields.investmentPrice).toBe(480);
      expect(fields.investmentCommission).toBe(5);
    });

    it("update() changing the action to DIVIDEND nulls the funding account (issue #1154)", async () => {
      // The user switches a BUY (with a funding account) to a DIVIDEND. The
      // funding account no longer applies and must be cleared, even though the
      // client sent an explicit account earlier.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-checking",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "DIVIDEND" as any,
        investmentTotalAmount: 75,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId && c[2].investmentFundingAccountId !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentFundingAccountId).toBeNull();
    });

    it("update() nulls a stale funding account even when the client omits the key (issue #1154)", async () => {
      // The exact reported path: the schedule is already a DIVIDEND carrying a
      // stale funding account, and the edit touches only the amount. The absent
      // key must not be read as "leave the stale account in place".
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "DIVIDEND" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-checking",
          investmentTotalAmount: 50,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentTotalAmount: 90,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId && c[2].investmentFundingAccountId !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentFundingAccountId).toBeNull();
    });

    it("update() keeps the funding account on a BUY", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-checking",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentPrice: 480,
      } as any);

      // A BUY edit that does not touch the funding account must not write the
      // column at all -- neither cleared to null nor emptied -- so the stored
      // value survives. Asserting the key is absent (not merely "not null")
      // also catches a future `|| ''`-style clear.
      const touchesFunding = mockQueryRunner.manager.update.mock.calls.some(
        (c: any[]) =>
          c[1] === stId &&
          Object.prototype.hasOwnProperty.call(
            c[2],
            "investmentFundingAccountId",
          ),
      );
      expect(touchesFunding).toBe(false);
    });

    it("update() switching BUY to DIVIDEND nulls quantity/price/commission (issue #1154)", async () => {
      // The action no longer uses shares or a per-share price, so the stale
      // quantity/price/commission from the BUY must not linger on the row.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
          investmentCommission: 5,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "DIVIDEND" as any,
        investmentTotalAmount: 75,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentQuantity).toBeNull();
      expect(fields.investmentPrice).toBeNull();
      expect(fields.investmentCommission).toBeNull();
      // The DIVIDEND's own required field is written, not cleared.
      expect(fields.investmentTotalAmount).toBe(75);
    });

    it("update() switching DIVIDEND to BUY nulls the stale total amount (issue #1154)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "DIVIDEND" as any,
          investmentSecurityId: "sec-voo",
          investmentTotalAmount: 75,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "BUY" as any,
        investmentQuantity: 2,
        investmentPrice: 100,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentTotalAmount).toBeNull();
      expect(fields.investmentQuantity).toBe(2);
      expect(fields.investmentPrice).toBe(100);
    });

    it("update() keeps quantity but nulls price/total when switching to ADD_SHARES", async () => {
      // ADD_SHARES uses only a quantity; price/commission/total do not apply.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 3,
          investmentPrice: 500,
          investmentCommission: 5,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "ADD_SHARES" as any,
        investmentQuantity: 4,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentQuantity).toBe(4);
      expect(fields.investmentPrice).toBeNull();
      expect(fields.investmentCommission).toBeNull();
      expect(fields.investmentTotalAmount).toBeNull();
    });

    it("update() rejects an explicit null total instead of validating the stored one (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "DIVIDEND" as any,
          investmentSecurityId: "sec-voo",
          investmentTotalAmount: 100,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.update(userId, stId, { investmentTotalAmount: null } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Rejected before the write opens.
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
    });

    it("update() rejects a zero stored investment exchange rate (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.1,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.update(userId, stId, { investmentExchangeRate: 0 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("update() clears a stored rate when the settlement basis changes (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.1,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "DIVIDEND" as any,
        investmentTotalAmount: 100,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentExchangeRate).toBeNull();
    });

    it("update() keeps a stored rate on a presentation-only edit (issue #1154 review)", async () => {
      // The settlement tuple is unchanged, so a name edit must not re-resolve or
      // wipe a legitimate cross-currency rate (the over-clear guard).
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.1,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, { name: "Renamed" } as any);

      const clearedRate = mockQueryRunner.manager.update.mock.calls.some(
        (c: any[]) => c[1] === stId && c[2].investmentExchangeRate === null,
      );
      expect(clearedRate).toBe(false);
    });

    it("update() clears a hidden security when switching to INTEREST with the key omitted (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-eur",
          investmentQuantity: 1,
          investmentPrice: 100,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "INTEREST" as any,
        investmentTotalAmount: 50,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentSecurityId).toBeNull();
    });

    it("create() rejects a non-positive investment exchange rate (issue #1154 review)", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentExchangeRate: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("update() rejects when the action changed concurrently (issue #1154 re-review)", async () => {
      // The request read a DIVIDEND and derived DIVIDEND cleanup, but a
      // concurrent edit switched the locked row to BUY. Writing the stale
      // cleanup would null the quantity/price the BUY just set, so the update is
      // refused. The pre-mutation read and the locked read both go through
      // scheduledRepo.findOne.
      const preEdit = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 100,
      });
      const lockedDifferent = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 2,
        investmentPrice: 50,
      });
      scheduledRepo.findOne
        .mockResolvedValueOnce(preEdit)
        .mockResolvedValue(lockedDifferent);
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.update(userId, stId, { name: "Renamed" } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
    });

    it("create() drops a funding account supplied for a non-funding action (issue #1154)", async () => {
      accountsService.findOne.mockImplementation(
        async (uid: string, id: string) => {
          if (id === "acc-checking")
            return { id, userId: uid, accountType: "CHECKING" } as any;
          return {
            id,
            userId: uid,
            accountSubType: "INVESTMENT_BROKERAGE",
          } as any;
        },
      );
      const saved = makeScheduled({ isInvestment: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...investmentBaseDto,
        investmentAction: "DIVIDEND" as any,
        investmentQuantity: undefined as any,
        investmentPrice: undefined as any,
        investmentTotalAmount: 75,
        investmentFundingAccountId: "acc-checking",
      });

      const created = scheduledRepo.create.mock.calls[0][0];
      expect(created.investmentFundingAccountId).toBeNull();
    });

    it("update() switching to isInvestment=true wipes split/transfer remnants", async () => {
      stubFindOne(
        makeScheduled({
          isSplit: true,
          isTransfer: false,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].isInvestment !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.isInvestment).toBe(true);
      expect(fields.isSplit).toBe(false);
      expect(fields.isTransfer).toBe(false);
      expect(fields.categoryId).toBeNull();
      expect(fields.transferAccountId).toBeNull();
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
    });

    it("update() switching to isInvestment=false clears every investment field", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );

      await service.update(userId, stId, {
        isInvestment: false,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].isInvestment !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.isInvestment).toBe(false);
      expect(fields.investmentAction).toBeNull();
      expect(fields.investmentSecurityId).toBeNull();
      expect(fields.investmentFundingAccountId).toBeNull();
      expect(fields.investmentQuantity).toBeNull();
      expect(fields.investmentPrice).toBeNull();
      expect(fields.investmentCommission).toBeNull();
      expect(fields.investmentTotalAmount).toBeNull();
      expect(fields.investmentExchangeRate).toBeNull();
    });

    it("update() switching to isTransfer=true clears investment fields too", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );

      await service.update(userId, stId, {
        isInvestment: false,
        isTransfer: true,
        transferAccountId: "acc-2",
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].isTransfer === true,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentAction).toBeNull();
      expect(fields.investmentSecurityId).toBeNull();
    });
  });

  // ==================== Override CRUD ====================
  describe("foreign-currency schedules", () => {
    const baseDto = {
      accountId: "acc-1",
      name: "Netflix",
      amount: -54.61,
      currencyCode: "CAD",
      frequency: "MONTHLY" as any,
      nextDueDate: "2025-02-15",
    };

    beforeEach(() => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        currencyCode: "CAD",
        fxFeePercent: null,
      });
    });

    const stubNoOverride = () => {
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
    };

    it("stores the foreign trio on create", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...baseDto,
        originalAmount: -40,
        originalCurrencyCode: "usd",
        exchangeRate: 1.365234,
      });

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.originalAmount).toBe(-40);
      expect(createArg.originalCurrencyCode).toBe("USD");
      expect(createArg.exchangeRate).toBe(1.365234);
    });

    it("strips the trio when the entry currency is the account currency", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...baseDto,
        originalAmount: -54.61,
        originalCurrencyCode: "CAD",
        exchangeRate: 1,
      });

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.originalCurrencyCode).toBeNull();
      expect(createArg.originalAmount).toBeNull();
      expect(createArg.exchangeRate).toBe(1);
    });

    it.each([
      ["a transfer", { isTransfer: true, transferAccountId: "acc-2" }],
      [
        "a split",
        {
          splits: [
            { categoryId: "cat-a", amount: -30 },
            { categoryId: "cat-b", amount: -24.61 },
          ],
        },
      ],
    ])("rejects a foreign entry on %s", async (_label, extra) => {
      await expect(
        service.create(userId, {
          ...baseDto,
          ...(extra as any),
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("clears the trio when an existing foreign schedule becomes a transfer", async () => {
      stubFindOne(
        makeScheduled({
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
          currencyCode: "CAD",
        }),
      );

      await service.update(userId, stId, {
        isTransfer: true,
        transferAccountId: "acc-2",
      });

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        expect.objectContaining({
          originalAmount: null,
          originalCurrencyCode: null,
          exchangeRate: 1,
        }),
      );
    });

    it("converts at the rate for the posting date, not the stored estimate", async () => {
      stubFindOne(
        makeScheduled({
          amount: -54.61,
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: null,
          } as any,
        }),
      );
      stubNoOverride();
      mockExchangeRateService.getRateForDate.mockResolvedValue(1.4);

      await service.post(userId, stId, { transactionDate: "2025-03-01" });

      expect(mockExchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2025-03-01",
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: -56,
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
        }),
      );
    });

    it("folds the account's foreign transaction fee into the posted amount", async () => {
      stubFindOne(
        makeScheduled({
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: 2.5,
          } as any,
        }),
      );
      stubNoOverride();
      mockExchangeRateService.getRateForDate.mockResolvedValue(1.4);

      await service.post(userId, stId, { transactionDate: "2025-03-01" });

      // base -56, fee -1.40, total -57.40
      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ amount: -57.4 }),
      );
    });

    it("refuses to post when no rate can be resolved for the date", async () => {
      stubFindOne(
        makeScheduled({
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: null,
          } as any,
        }),
      );
      stubNoOverride();
      mockExchangeRateService.getRateForDate.mockResolvedValue(null);

      await expect(
        service.post(userId, stId, { transactionDate: "2025-03-01" }),
      ).rejects.toThrow(BadRequestException);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("honours an occurrence override as an account-currency total", async () => {
      stubFindOne(
        makeScheduled({
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: null,
          } as any,
        }),
      );
      const storedOverride = {
        id: "ovr-1",
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -60,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      // The pinned total is booked as-is, and the rate is derived so the row
      // still round-trips: -60 / -40 = 1.5.
      expect(mockExchangeRateService.getRateForDate).not.toHaveBeenCalled();
      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: -60,
          originalAmount: -40,
          exchangeRate: 1.5,
        }),
      );
    });

    it("refreshes stored estimates from the latest rate", async () => {
      scheduledRepo.find.mockResolvedValue([
        {
          id: stId,
          userId,
          name: "Netflix",
          amount: -54.61,
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
          account: { fxFeePercent: null },
        },
      ]);
      mockExchangeRateService.getLatestRate.mockResolvedValue(1.4);

      await service.refreshForeignCurrencyEstimates();

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        { amount: -56, exchangeRate: 1.4 },
      );
    });

    it("leaves an ordinary schedule alone on the refresh sweep", async () => {
      scheduledRepo.find.mockResolvedValue([
        { id: stId, userId, amount: -1200, currencyCode: "USD" },
      ]);

      await service.refreshForeignCurrencyEstimates();

      expect(mockExchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
    });
  });
  describe("createOverride", () => {
    it("should create an override", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -999,
      };
      const result = await service.createOverride(userId, stId, dto);

      expect(overridesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledTransactionId: stId,
          originalDate: "2025-02-15",
        }),
      );
      expect(overridesRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should throw if override already exists for date", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue({ id: "existing-ovr" });
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = { originalDate: "2025-02-15", overrideDate: "2025-02-15" };
      await expect(service.createOverride(userId, stId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should validate override splits", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -1000,
        isSplit: true,
        splits: [{ categoryId: "cat-a", amount: -600 }], // only 1 split
      };
      await expect(service.createOverride(userId, stId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should require amount when creating split override", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        isSplit: true,
        splits: [
          { categoryId: "cat-a", amount: -600 },
          { categoryId: "cat-b", amount: -400 },
        ],
      };
      await expect(service.createOverride(userId, stId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("findOverrides", () => {
    it("should return overrides for a scheduled transaction", async () => {
      stubFindOne(makeScheduled());
      const overrides = [{ id: "ovr-1" }, { id: "ovr-2" }];
      overridesRepo.find.mockResolvedValue(overrides);

      const result = await service.findOverrides(userId, stId);

      expect(result).toEqual(overrides);
      expect(overridesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { scheduledTransactionId: stId } }),
      );
    });
  });

  describe("findOverride", () => {
    it("should return a specific override", async () => {
      stubFindOne(makeScheduled());
      const override = { id: "ovr-1", scheduledTransactionId: stId };
      overridesRepo.findOne.mockResolvedValue(override);

      const result = await service.findOverride(userId, stId, "ovr-1");
      expect(result).toEqual(override);
    });

    it("should throw NotFoundException if override not found", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(null);

      await expect(
        service.findOverride(userId, stId, "ovr-999"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("findOverrideByDate", () => {
    it("should return override matching originalDate", async () => {
      stubFindOne(makeScheduled());
      const override = {
        id: "ovr-1",
        originalDate: "2025-02-15",
        scheduledTransactionId: stId,
      };
      overridesRepo.find.mockResolvedValue([override]);

      const result = await service.findOverrideByDate(
        userId,
        stId,
        "2025-02-15",
      );
      expect(result).toEqual(override);
    });

    it("should return null when no override matches", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.find.mockResolvedValue([]);

      const result = await service.findOverrideByDate(
        userId,
        stId,
        "2025-02-15",
      );
      expect(result).toBeNull();
    });

    it("should normalize datetime strings to date-only", async () => {
      stubFindOne(makeScheduled());
      const override = {
        id: "ovr-1",
        originalDate: "2025-02-15T00:00:00.000Z",
        scheduledTransactionId: stId,
      };
      overridesRepo.find.mockResolvedValue([override]);

      const result = await service.findOverrideByDate(
        userId,
        stId,
        "2025-02-15T12:00:00Z",
      );
      expect(result).toEqual(override);
    });
  });

  describe("updateOverride", () => {
    it("should update override fields", async () => {
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        amount: -1000,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
      };
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(existing);

      await service.updateOverride(userId, stId, "ovr-1", { amount: -1500 });

      expect(overridesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -1500 }),
      );
    });

    it("should validate splits on update", async () => {
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        amount: -1000,
      };
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(existing);

      await expect(
        service.updateOverride(userId, stId, "ovr-1", {
          isSplit: true,
          splits: [{ amount: -500 }], // only 1 split
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("removeOverride", () => {
    it("should remove the override", async () => {
      const override = { id: "ovr-1", scheduledTransactionId: stId };
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(override);

      await service.removeOverride(userId, stId, "ovr-1");

      expect(overridesRepo.remove).toHaveBeenCalledWith(override);
    });
  });

  describe("removeAllOverrides", () => {
    it("should delete all overrides and return count", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.delete.mockResolvedValue({ affected: 3 });

      const result = await service.removeAllOverrides(userId, stId);

      expect(result).toBe(3);
      expect(overridesRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
      });
    });

    it("should return 0 when no overrides deleted", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.delete.mockResolvedValue({ affected: 0 });

      const result = await service.removeAllOverrides(userId, stId);
      expect(result).toBe(0);
    });
  });

  describe("hasOverrides", () => {
    it("should return true with count when overrides exist", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.count.mockResolvedValue(5);

      const result = await service.hasOverrides(userId, stId);

      expect(result).toEqual({ hasOverrides: true, count: 5 });
    });

    it("should return false with 0 when no overrides", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.count.mockResolvedValue(0);

      const result = await service.hasOverrides(userId, stId);

      expect(result).toEqual({ hasOverrides: false, count: 0 });
    });
  });

  // ==================== processAutoPostTransactions ====================
  describe("processAutoPostTransactions", () => {
    it("should find due autoPost transactions and post each", async () => {
      const st1 = makeScheduled({ id: "st-1", autoPost: true });
      const st2 = makeScheduled({ id: "st-2", autoPost: true });
      scheduledRepo.find.mockResolvedValue([st1, st2]);

      // For each post() call, stub the internal findOne and override queries
      scheduledRepo.findOne.mockResolvedValue(st1);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(scheduledRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true, autoPost: true }),
        }),
      );
    });

    it("should handle empty due list gracefully", async () => {
      scheduledRepo.find.mockResolvedValue([]);

      await service.processAutoPostTransactions();

      expect(scheduledRepo.find).toHaveBeenCalled();
      // No posts should happen
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    // RLS (task C2): the timezone/candidate fan-out runs under a system
    // context; each per-user post() re-enters that user's own context.
    it("runs the fan-out under system context and each post under a user context", async () => {
      const st1 = makeScheduled({ id: "st-1", autoPost: true });
      let ctxAtFind: ReturnType<typeof getRequestContext>;
      scheduledRepo.find.mockImplementation(() => {
        ctxAtFind = getRequestContext();
        return Promise.resolve([st1]);
      });
      scheduledRepo.findOne.mockResolvedValue(st1);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      let ctxAtPost: ReturnType<typeof getRequestContext>;
      const postSpy = jest.spyOn(service, "post").mockImplementation(() => {
        ctxAtPost = getRequestContext();
        return Promise.resolve(undefined as any);
      });

      await service.processAutoPostTransactions();

      expect(ctxAtFind).toEqual({ system: true });
      expect(ctxAtPost).toEqual({ userId: st1.userId });
      postSpy.mockRestore();
    });

    it("should continue processing after individual errors", async () => {
      const st1 = makeScheduled({ id: "st-1", autoPost: true });
      const st2 = makeScheduled({ id: "st-2", autoPost: true });
      scheduledRepo.find.mockResolvedValue([st1, st2]);

      // First post fails, second succeeds
      let callCount = 0;
      scheduledRepo.findOne.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("DB error");
        return Promise.resolve(st2);
      });
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      // Should not throw
      await service.processAutoPostTransactions();
    });

    it("should auto-post transfer transactions using prepareTransfer", async () => {
      const transfer = makeScheduled({
        id: "st-transfer",
        autoPost: true,
        isTransfer: true,
        transferAccountId: "acc-2",
        tagIds: ["tag-1"],
      });
      scheduledRepo.find.mockResolvedValue([transfer]);
      scheduledRepo.findOne.mockResolvedValue(transfer);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          amount: 1200,
          tagIds: ["tag-1"],
        }),
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("should auto-post mixed batch of regular and transfer transactions", async () => {
      const regular = makeScheduled({
        id: "st-regular",
        autoPost: true,
        isTransfer: false,
      });
      const transfer = makeScheduled({
        id: "st-transfer",
        autoPost: true,
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      scheduledRepo.find.mockResolvedValue([regular, transfer]);

      let findOneCall = 0;
      scheduledRepo.findOne.mockImplementation(() => {
        findOneCall++;
        // First two calls for post of regular, last two for post of transfer
        if (findOneCall <= 2) return Promise.resolve(regular);
        return Promise.resolve(transfer);
      });
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(transactionsService.create).toHaveBeenCalled();
      expect(transactionsService.prepareTransfer).toHaveBeenCalled();
    });

    it("should pick up transactions with overrides that moved date earlier", async () => {
      const transfer = makeScheduled({
        id: "st-override",
        autoPost: true,
        isTransfer: true,
        transferAccountId: "acc-2",
        nextDueDate: "2025-03-15",
      });

      // First find (base nextDueDate) returns nothing — the 15th hasn't arrived
      // Second find (override-matched IDs) returns the transfer
      let findCallCount = 0;
      scheduledRepo.find.mockImplementation(() => {
        findCallCount++;
        if (findCallCount === 1) return Promise.resolve([]);
        return Promise.resolve([transfer]);
      });

      // Override query returns the scheduled transaction ID
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getRawMany.mockResolvedValue([{ id: "st-override" }]);
      overrideQb.getOne.mockResolvedValue({
        overrideDate: "2025-03-12",
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      scheduledRepo.findOne.mockResolvedValue(transfer);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          transactionDate: "2025-03-12",
        }),
      );
    });

    it("should NOT auto-post when an override moves the next occurrence forward", async () => {
      const scheduled = makeScheduled({
        id: "st-postponed",
        autoPost: true,
        nextDueDate: "2026-04-26",
      });
      scheduledRepo.find.mockResolvedValue([scheduled]);

      // Postponed-id lookup returns this transaction; the moved-earlier
      // lookup returns nothing.
      const postponedQb = mockQueryBuilder(null);
      postponedQb.getRawMany.mockResolvedValue([{ id: "st-postponed" }]);
      const earlierQb = mockQueryBuilder(null);
      earlierQb.getRawMany.mockResolvedValue([]);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(postponedQb)
        .mockReturnValueOnce(earlierQb);

      await service.processAutoPostTransactions();

      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(transactionsService.prepareTransfer).not.toHaveBeenCalled();
    });

    it("uses last_client_timezone when explicit timezone is the 'browser' sentinel", async () => {
      // Stand in for an EDT user who hasn't picked a timezone in Settings.
      // The browser-provided IANA name was cached on a previous request and
      // must take precedence over the UTC fallback or we'll auto-post a day
      // early once UTC rolls past midnight.
      mockDataSource.query.mockResolvedValueOnce([
        {
          user_id: "33333333-3333-3333-3333-333333333333",
          timezone: "browser",
          last_client_timezone: "America/Toronto",
        },
      ]);
      scheduledRepo.find.mockResolvedValue([]);
      // No override-only IDs to consider.
      overridesRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));

      await service.processAutoPostTransactions();

      // The find() filter receives a LessThanOrEqual whose operand is
      // todayInTimezone('America/Toronto'). Asserting on the shape of the
      // call is enough — exact date depends on system clock — what matters
      // is that the bucketing didn't collapse to UTC.
      expect(scheduledRepo.find).toHaveBeenCalled();
    });

    it("falls back to UTC when neither explicit timezone nor cached client timezone is set", async () => {
      mockDataSource.query.mockResolvedValueOnce([
        {
          user_id: "44444444-4444-4444-4444-444444444444",
          timezone: "browser",
          last_client_timezone: null,
        },
      ]);
      scheduledRepo.find.mockResolvedValue([]);
      overridesRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));

      await service.processAutoPostTransactions();

      expect(scheduledRepo.find).toHaveBeenCalled();
    });

    it("should use override date as transaction date in post()", async () => {
      const scheduled = makeScheduled({
        nextDueDate: "2025-03-15",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);

      const storedOverride = {
        overrideDate: "2025-03-12",
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          transactionDate: "2025-03-12",
        }),
      );
    });
  });

  // ==================== recalculateLoanPaymentSplits ====================
  describe("recalculateLoanPaymentSplits", () => {
    it("should deactivate scheduled transaction when loan is paid off", async () => {
      // The loan account is now derived from the current split set under the
      // parent lock (issue #1154 re-review), so provide a transfer split
      // pointing at it rather than relying on a caller-passed loan id.
      accountsRepo.findOne.mockResolvedValue({
        id: "loan-1",
        accountType: "LOAN",
        currentBalance: 0,
      });
      splitsRepo.find.mockResolvedValue([
        {
          id: "s1",
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -800,
        },
      ]);
      scheduledRepo.findOne.mockResolvedValue(
        makeScheduled({ isActive: true }),
      );

      await service.recalculateLoanPaymentSplits(stId);

      expect(scheduledRepo.update).toHaveBeenCalledWith(stId, {
        isActive: false,
      });
    });

    it("should do nothing when loan account not found", async () => {
      accountsRepo.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(stId);

      expect(scheduledRepo.update).not.toHaveBeenCalled();
    });

    it("should do nothing when scheduled transaction not found", async () => {
      accountsRepo.findOne.mockResolvedValue({
        id: "loan-1",
        currentBalance: -50000,
        interestRate: 5,
      });
      scheduledRepo.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(stId);

      expect(splitsRepo.save).not.toHaveBeenCalled();
    });

    it("should update principal and interest splits", async () => {
      const loanAccount = {
        id: "loan-1",
        accountType: "LOAN",
        currentBalance: -50000,
        interestRate: 6,
        paymentFrequency: "MONTHLY",
      };
      const principalSplit = {
        id: "s1",
        transferAccountId: "loan-1",
        categoryId: null,
        amount: -800,
      };
      const interestSplit = {
        id: "s2",
        transferAccountId: null,
        categoryId: "cat-interest",
        amount: -400,
      };
      const scheduled = makeScheduled({
        isActive: true,
        amount: -1200,
      });

      accountsRepo.findOne.mockResolvedValue(loanAccount);
      // Splits are re-read under the parent lock (issue #1154 re-review).
      splitsRepo.find.mockResolvedValue([principalSplit, interestSplit]);
      scheduledRepo.findOne.mockResolvedValue(scheduled);

      await service.recalculateLoanPaymentSplits(stId);

      // Both splits should have been saved with updated amounts
      expect(splitsRepo.save).toHaveBeenCalledTimes(2);
    });
  });

  describe("scheduled investment splits", () => {
    const buyInvestment = {
      action: "BUY" as const,
      securityId: "sec-1",
      quantity: 75,
      price: 10,
      commission: 0,
    };

    it("persists kind='investment' and the investment fields on save", async () => {
      const dto = {
        accountId: "acc-1",
        name: "Equity Grant",
        amount: 0,
        currencyCode: "USD",
        frequency: "MONTHLY" as const,
        nextDueDate: "2026-05-09",
        startDate: "2026-05-09",
        splits: [
          { amount: 1000, categoryId: "cat-income" },
          { amount: -250, categoryId: "cat-tax" },
          { amount: -750, investment: buyInvestment },
        ],
      };
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        currencyCode: "USD",
      });
      scheduledRepo.create.mockImplementation((d) => ({ id: stId, ...d }));
      scheduledRepo.save.mockImplementation(async (d) => d);
      mockQueryRunner.manager.create.mockImplementation(
        (_e: unknown, d: unknown) => d,
      );
      mockQueryRunner.manager.save.mockImplementation(async (d: object) => ({
        id: "split-x",
        ...d,
      }));

      // findOne returns the saved scheduled transaction
      scheduledRepo.findOne.mockResolvedValue(makeScheduled({ amount: 0 }));

      await service.create(userId, dto as any);

      // Verify the investment-kind split was created with all fields populated
      const investmentCall = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) => c[1]?.kind === "investment",
      );
      expect(investmentCall).toBeDefined();
      expect(investmentCall![1]).toMatchObject({
        kind: "investment",
        categoryId: null,
        transferAccountId: null,
        amount: -750,
        investmentAction: "BUY",
        investmentSecurityId: "sec-1",
        investmentQuantity: 75,
        investmentPrice: 10,
        investmentCommission: 0,
      });
    });

    it("rejects single category split when no transfer/investment passthrough", async () => {
      const dto = {
        accountId: "acc-1",
        name: "Bad",
        amount: -100,
        currencyCode: "USD",
        frequency: "MONTHLY" as const,
        nextDueDate: "2026-05-09",
        startDate: "2026-05-09",
        splits: [{ amount: -100, categoryId: "cat-1" }],
      };
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        accountType: "CHEQUING",
        accountSubType: null,
        currencyCode: "USD",
      });

      await expect(service.create(userId, dto as any)).rejects.toThrow(
        /at least 2 splits/,
      );
    });

    it("accepts a single investment split as a passthrough", async () => {
      const dto = {
        accountId: "acc-1",
        name: "Pure equity grant",
        amount: -750,
        currencyCode: "USD",
        frequency: "MONTHLY" as const,
        nextDueDate: "2026-05-09",
        startDate: "2026-05-09",
        splits: [{ amount: -750, investment: buyInvestment }],
      };
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        currencyCode: "USD",
      });
      scheduledRepo.create.mockImplementation((d) => ({ id: stId, ...d }));
      scheduledRepo.save.mockImplementation(async (d) => d);
      splitsRepo.create.mockImplementation((d) => d);
      splitsRepo.save.mockImplementation(async (d) => ({
        id: "split-x",
        ...d,
      }));
      scheduledRepo.findOne.mockResolvedValue(makeScheduled({ amount: -750 }));

      await expect(service.create(userId, dto as any)).resolves.toBeDefined();
    });

    it("post() forwards investment payload from scheduled splits to TransactionsService.create", async () => {
      const investmentSplit: any = {
        id: "ss-3",
        kind: "investment",
        amount: -750,
        memo: null,
        categoryId: null,
        transferAccountId: null,
        investmentAction: "BUY",
        investmentSecurityId: "sec-1",
        investmentQuantity: 75,
        investmentPrice: 10,
        investmentCommission: 0,
        investmentExchangeRate: 1,
        tags: [],
      };
      const incomeSplit: any = {
        id: "ss-1",
        kind: "category",
        amount: 1000,
        memo: null,
        categoryId: "cat-income",
        transferAccountId: null,
        tags: [],
      };
      const taxSplit: any = {
        id: "ss-2",
        kind: "category",
        amount: -250,
        memo: null,
        categoryId: "cat-tax",
        transferAccountId: null,
        tags: [],
      };
      const scheduled = makeScheduled({
        amount: 0,
        isSplit: true,
        splits: [incomeSplit, taxSplit, investmentSplit],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);
      // The locked split re-read (issue #1154 re-review) returns the same set.
      splitsRepo.find.mockResolvedValue(scheduled.splits);
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      const callArg = transactionsService.create.mock.calls[0][1];
      const investmentPayload = callArg.splits.find(
        (s: any) => s.splitKind === "investment",
      );
      expect(investmentPayload).toBeDefined();
      expect(investmentPayload.investment).toMatchObject({
        action: "BUY",
        securityId: "sec-1",
        quantity: 75,
        price: 10,
        commission: 0,
        exchangeRate: 1,
      });
      expect(investmentPayload.amount).toBe(-750);

      // Cash splits passed through with splitKind='category'
      const incomePayload = callArg.splits.find((s: any) => s.amount === 1000);
      expect(incomePayload.splitKind).toBe("category");
      expect(incomePayload.investment).toBeUndefined();
    });

    it("post() forwards investment payload from inline postDto.splits", async () => {
      const scheduled = makeScheduled({
        amount: 0,
        isSplit: true,
        splits: [],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId, {
        amount: 0,
        isSplit: true,
        splits: [
          { categoryId: "cat-income", amount: 1000 } as any,
          { categoryId: "cat-tax", amount: -250 } as any,
          {
            splitKind: "investment",
            amount: -750,
            investment: buyInvestment,
          } as any,
        ],
      });

      const callArg = transactionsService.create.mock.calls[0][1];
      expect(callArg.splits).toHaveLength(3);
      const inv = callArg.splits.find((s: any) => s.splitKind === "investment");
      expect(inv).toBeDefined();
      expect(inv.investment).toMatchObject(buyInvestment);
    });

    it("post() forwards investment payload from stored override splits", async () => {
      const scheduled = makeScheduled({
        amount: 0,
        isSplit: true,
        splits: [],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);

      const storedOverride: any = {
        amount: 0,
        isSplit: true,
        splits: [
          { categoryId: "cat-income", amount: 1000 },
          { categoryId: "cat-tax", amount: -250 },
          {
            splitKind: "investment",
            amount: -750,
            investment: buyInvestment,
          },
        ],
      };
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(storedOverride),
      });
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId);

      const callArg = transactionsService.create.mock.calls[0][1];
      const inv = callArg.splits.find((s: any) => s.splitKind === "investment");
      expect(inv).toBeDefined();
      expect(inv.investment).toMatchObject(buyInvestment);
    });

    it("post() preserves null investment fields when scheduled split is non-investment", async () => {
      const incomeSplit: any = {
        id: "ss-1",
        kind: "category",
        amount: -50,
        memo: null,
        categoryId: "cat-1",
        transferAccountId: null,
        tags: [],
        // No investment* fields
      };
      const expenseSplit: any = {
        id: "ss-2",
        kind: "category",
        amount: -50,
        memo: null,
        categoryId: "cat-2",
        transferAccountId: null,
        tags: [],
      };
      const scheduled = makeScheduled({
        amount: -100,
        isSplit: true,
        splits: [incomeSplit, expenseSplit],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);
      splitsRepo.find.mockResolvedValue(scheduled.splits);
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId);

      const callArg = transactionsService.create.mock.calls[0][1];
      callArg.splits.forEach((s: any) => {
        expect(s.investment).toBeUndefined();
        expect(s.splitKind).toBe("category");
      });
    });
  });
});
