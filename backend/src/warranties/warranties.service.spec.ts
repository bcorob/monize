import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource, EntityManager } from "typeorm";

import { requestContextStorage } from "../common/request-context";
import { Currency } from "../currencies/entities/currency.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { CreateWarrantyDto } from "./dto/create-warranty.dto";
import { UpdateWarrantyDto } from "./dto/update-warranty.dto";
import { WarrantyClaim } from "./entities/warranty-claim.entity";
import { Warranty } from "./entities/warranty.entity";
import { WarrantiesService } from "./warranties.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222222";
const W2 = "33333333-3333-4333-8333-333333333333";
const TX = "44444444-4444-4444-8444-444444444444";
const PAYEE = "55555555-5555-4555-8555-555555555555";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const TODAY = "2026-10-21";

type QbMock = Record<string, jest.Mock>;

/** A chainable query builder whose terminal methods answer `results`. */
function qbMock(results: {
  manyAndCount?: [Warranty[], number];
  many?: unknown[];
  rawOne?: Record<string, string>;
  rawMany?: unknown[];
  exists?: boolean;
}): QbMock {
  const qb: QbMock = {};
  for (const name of [
    "where",
    "andWhere",
    "orderBy",
    "addOrderBy",
    "skip",
    "take",
    "select",
    "addSelect",
    "setParameters",
    "leftJoin",
    "groupBy",
  ]) {
    qb[name] = jest.fn(() => qb);
  }
  qb.getManyAndCount = jest
    .fn()
    .mockResolvedValue(results.manyAndCount ?? [[], 0]);
  qb.getMany = jest.fn().mockResolvedValue(results.many ?? []);
  qb.getRawOne = jest.fn().mockResolvedValue(results.rawOne);
  qb.getRawMany = jest.fn().mockResolvedValue(results.rawMany ?? []);
  qb.getExists = jest.fn().mockResolvedValue(results.exists ?? false);
  return qb;
}

function warranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: W1,
    userId: USER,
    name: "Laptop",
    vendorName: "Best Buy",
    payeeId: null,
    transactionId: null,
    modelNumber: "X1",
    serialNumbers: ["SN-1"],
    warrantyKind: "manufacturer",
    purchaseDate: "2026-10-01",
    expiresOn: "2028-10-01",
    isLifetime: false,
    purchasePrice: 1499.99,
    currencyCode: "CAD",
    productUrl: null,
    notes: null,
    archivedAt: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    ...overrides,
  };
}

function linkedTransactionRow(): Partial<Transaction> {
  return {
    id: TX,
    transactionDate: "2026-10-01",
    payeeName: null,
    payee: { id: PAYEE, name: "Best Buy" } as Payee,
    amount: -1499.99,
    currencyCode: "CAD",
    accountId: ACCOUNT,
  };
}

describe("WarrantiesService", () => {
  let service: WarrantiesService;
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let warrantyRepo: Record<string, jest.Mock>;
  let claimRepo: Record<string, jest.Mock>;
  let transactionRepo: Record<string, jest.Mock>;
  let payeeRepo: Record<string, jest.Mock>;
  let currencyRepo: Record<string, jest.Mock>;
  let listQb: QbMock;
  let claimQb: QbMock;
  let transactionQb: QbMock;

  beforeEach(async () => {
    listQb = qbMock({});
    claimQb = qbMock({});
    transactionQb = qbMock({});
    warrantyRepo = {
      createQueryBuilder: jest.fn(() => listQb),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Partial<Warranty>) => value),
      save: jest.fn(async (value: Partial<Warranty>) => ({
        id: W1,
        createdAt: new Date("2026-10-21T12:00:00.000Z"),
        updatedAt: new Date("2026-10-21T12:00:00.000Z"),
        ...value,
      })),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    };
    claimRepo = { createQueryBuilder: jest.fn(() => claimQb) };
    transactionRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => transactionQb),
    };
    payeeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    currencyRepo = {
      findOne: jest.fn(async ({ where }: { where: { code: string } }) =>
        where.code === "CAD" ? { code: "CAD" } : null,
      ),
    };
    mocks = createScopedDbMocks([
      [Warranty, warrantyRepo],
      [WarrantyClaim, claimRepo],
      [Transaction, transactionRepo],
      [Payee, payeeRepo],
      [Currency, currencyRepo],
    ]);
    mocks.manager.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarrantiesService,
        { provide: DataSource, useValue: mocks.dataSource },
      ],
    }).compile();
    service = module.get(WarrantiesService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createDto = (
    overrides: Partial<CreateWarrantyDto> = {},
  ): CreateWarrantyDto =>
    Object.assign(new CreateWarrantyDto(), {
      name: "Laptop",
      purchaseDate: "2026-10-01",
      expiresOn: "2028-10-01",
      ...overrides,
    });

  describe("findAll", () => {
    it("labels each row with the server's status, counts and linked purchase", async () => {
      listQb = qbMock({
        manyAndCount: [
          [
            warranty({ transactionId: TX }),
            warranty({ id: W2, isLifetime: true, expiresOn: null }),
          ],
          2,
        ],
      });
      mocks.manager.query.mockResolvedValue([{ warranty_id: W1, count: "2" }]);
      claimQb = qbMock({ rawMany: [{ warrantyId: W2, count: "1" }] });
      transactionQb = qbMock({ many: [linkedTransactionRow()] });

      const result = await service.findAll(USER, {}, { today: "2028-09-02" });

      expect(result.pagination).toEqual({
        page: 1,
        limit: 50,
        total: 2,
        totalPages: 1,
        hasMore: false,
      });
      expect(result.data[0]).toMatchObject({
        id: W1,
        today: "2028-09-02",
        status: "expiring",
        daysLeft: 29,
        documentCount: 2,
        openClaimCount: 0,
        transactionId: TX,
        linkedTransaction: {
          id: TX,
          transactionDate: "2026-10-01",
          payeeName: "Best Buy",
          amount: -1499.99,
          currencyCode: "CAD",
          accountId: ACCOUNT,
        },
        linkedTransactionHidden: false,
        createdAt: "2026-10-01T12:00:00.000Z",
        archivedAt: null,
      });
      expect(result.data[1]).toMatchObject({
        id: W2,
        status: "lifetime",
        daysLeft: null,
        documentCount: 0,
        openClaimCount: 1,
        linkedTransaction: null,
        linkedTransactionHidden: false,
      });
      expect(result.data[1]).not.toHaveProperty("transactionId");
      // One transaction for the page and its enrichment.
      expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("counts documents over the page's ids, a scan pair once", async () => {
      listQb = qbMock({ manyAndCount: [[warranty()], 1] });

      await service.findAll(USER, {}, { today: TODAY });

      const [sql, params] = mocks.manager.query.mock.calls[0];
      expect(sql).toContain("ta.warranty_id = ANY($1::uuid[])");
      expect(sql).toContain("ta.original_of_attachment_id IS NULL");
      expect(sql).toContain("GROUP BY ta.warranty_id");
      expect(params).toEqual([[W1], USER]);
      expect(claimQb.andWhere).toHaveBeenCalledWith("c.status = :open", {
        open: "open",
      });
    });

    it("loads the page's vendor payees in one read over the distinct ids", async () => {
      const OTHER_PAYEE = "77777777-7777-4777-8777-777777777777";
      listQb = qbMock({
        manyAndCount: [
          [
            warranty({ payeeId: PAYEE }),
            warranty({ id: W2, payeeId: PAYEE }),
            warranty({
              id: "88888888-8888-4888-8888-888888888888",
              payeeId: OTHER_PAYEE,
            }),
          ],
          3,
        ],
      });
      payeeRepo.find.mockResolvedValue([
        { id: PAYEE, name: "Best Buy", hasLogo: true },
        { id: OTHER_PAYEE, name: "Costco", hasLogo: false },
      ]);

      const { data } = await service.findAll(USER, {}, { today: TODAY });

      expect(payeeRepo.find).toHaveBeenCalledTimes(1);
      const [options] = payeeRepo.find.mock.calls[0];
      expect(options.select).toEqual({ id: true, name: true, hasLogo: true });
      expect(options.where.userId).toBe(USER);
      expect(options.where.id.value).toEqual([PAYEE, OTHER_PAYEE]);
      expect(data.map((view) => view.payee)).toEqual([
        { id: PAYEE, name: "Best Buy", hasLogo: true },
        { id: PAYEE, name: "Best Buy", hasLogo: true },
        { id: OTHER_PAYEE, name: "Costco", hasLogo: false },
      ]);
      // Under the page's own scoped transaction.
      expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("answers a null payee, and reads none, when no row names one", async () => {
      listQb = qbMock({ manyAndCount: [[warranty()], 1] });

      const { data } = await service.findAll(USER, {}, { today: TODAY });

      expect(data[0].payeeId).toBeNull();
      expect(data[0].payee).toBeNull();
      expect(payeeRepo.find).not.toHaveBeenCalled();
    });

    it("answers a null payee when the named payee is not the caller's", async () => {
      listQb = qbMock({
        manyAndCount: [[warranty({ payeeId: PAYEE })], 1],
      });

      const { data } = await service.findAll(USER, {}, { today: TODAY });

      expect(payeeRepo.find).toHaveBeenCalledTimes(1);
      expect(data[0].payee).toBeNull();
    });

    it("prefers the transaction's own payee name over its payee's", async () => {
      listQb = qbMock({
        manyAndCount: [[warranty({ transactionId: TX })], 1],
      });
      transactionQb = qbMock({
        many: [{ ...linkedTransactionRow(), payeeName: "BEST BUY #123" }],
      });

      const { data } = await service.findAll(USER, {}, { today: TODAY });

      expect(data[0].linkedTransaction?.payeeName).toBe("BEST BUY #123");
    });

    describe("the linked purchase for a delegate (WTY-007, truth table C)", () => {
      const SCOPE_CLAUSE = "t.account_id IN (:...delegateScopeAccountIds)";

      it("leaves the owner's read unnarrowed", async () => {
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });
        transactionQb = qbMock({ many: [linkedTransactionRow()] });

        const { data } = await service.findAll(USER, {}, { today: TODAY });

        expect(transactionQb.andWhere).not.toHaveBeenCalledWith(
          SCOPE_CLAUSE,
          expect.anything(),
        );
        expect(data[0].transactionId).toBe(TX);
        expect(data[0].linkedTransaction?.id).toBe(TX);
        expect(data[0].linkedTransactionHidden).toBe(false);
      });

      it("shows the purchase when its account is in the delegate's scope", async () => {
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });
        transactionQb = qbMock({ many: [linkedTransactionRow()] });

        const { data } = await service.findAll(
          USER,
          {},
          { today: TODAY, accountScope: [ACCOUNT] },
        );

        expect(transactionQb.andWhere).toHaveBeenCalledWith(SCOPE_CLAUSE, {
          delegateScopeAccountIds: [ACCOUNT],
        });
        expect(data[0].transactionId).toBe(TX);
        expect(data[0].linkedTransaction?.accountId).toBe(ACCOUNT);
        expect(data[0].linkedTransactionHidden).toBe(false);
      });

      it("answers null and omits the id when the account is outside the scope", async () => {
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });
        // The narrowed read returns nothing: the purchase's account is not granted.
        transactionQb = qbMock({ many: [] });
        const other = "99999999-9999-4999-8999-999999999999";

        const { data } = await service.findAll(
          USER,
          {},
          { today: TODAY, accountScope: [other] },
        );

        expect(transactionQb.andWhere).toHaveBeenCalledWith(SCOPE_CLAUSE, {
          delegateScopeAccountIds: [other],
        });
        expect(data[0].linkedTransaction).toBeNull();
        expect(data[0]).not.toHaveProperty("transactionId");
        // Section 9: the detail says the purchase is in an unreadable
        // account, which the flag (and nothing carrying an id) tells it.
        expect(data[0].linkedTransactionHidden).toBe(true);
      });

      it("flags nothing hidden for a delegate when the warranty has no link", async () => {
        listQb = qbMock({ manyAndCount: [[warranty()], 1] });

        const { data } = await service.findAll(
          USER,
          {},
          { today: TODAY, accountScope: [ACCOUNT] },
        );

        expect(data[0].linkedTransaction).toBeNull();
        expect(data[0]).not.toHaveProperty("transactionId");
        expect(data[0].linkedTransactionHidden).toBe(false);
      });

      it("reads no purchase at all for an empty scope", async () => {
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });

        const { data } = await service.findAll(
          USER,
          {},
          { today: TODAY, accountScope: [] },
        );

        expect(transactionRepo.createQueryBuilder).not.toHaveBeenCalled();
        expect(data[0].linkedTransaction).toBeNull();
        expect(data[0]).not.toHaveProperty("transactionId");
        expect(data[0].linkedTransactionHidden).toBe(true);
      });
    });

    it("hides archived rows by default and lists only them when asked", async () => {
      await service.findAll(USER, {}, { today: TODAY });
      expect(listQb.andWhere).toHaveBeenCalledWith("w.archived_at IS NULL");

      listQb = qbMock({});
      await service.findAll(USER, { archived: true }, { today: TODAY });
      expect(listQb.andWhere).toHaveBeenCalledWith("w.archived_at IS NOT NULL");
    });

    it("filters a status in SQL with bounds derived from today, so the page count is right", async () => {
      await service.findAll(USER, { status: "expiring" }, { today: TODAY });

      expect(listQb.andWhere).toHaveBeenCalledWith(
        "(w.is_lifetime = :expiringIsLifetime AND w.expires_on >= :expiringExpiresFrom AND w.expires_on <= :expiringExpiresTo)",
        {
          expiringIsLifetime: false,
          expiringExpiresFrom: "2026-10-21",
          expiringExpiresTo: "2026-11-20",
        },
      );
    });

    it("applies no status predicate for all", async () => {
      await service.findAll(USER, { status: "all" }, { today: TODAY });
      const predicates = listQb.andWhere.mock.calls.map(([sql]) => sql);
      expect(predicates.some((sql) => sql.includes("is_lifetime"))).toBe(false);
    });

    it("searches name, vendor, model and serial numbers with the LIKE metacharacters escaped", async () => {
      await service.findAll(USER, { q: " 50%_off " }, { today: TODAY });

      const call = listQb.andWhere.mock.calls.find(([sql]) =>
        String(sql).includes("ILIKE"),
      );
      expect(call?.[0]).toContain("w.name ILIKE :q");
      expect(call?.[0]).toContain("w.vendor_name ILIKE :q");
      expect(call?.[0]).toContain("w.model_number ILIKE :q");
      expect(call?.[0]).toContain("unnest(w.serial_numbers)");
      expect(call?.[1]).toEqual({ q: "%50\\%\\_off%" });
    });

    it("filters by the linked transaction and pages with the requested limit", async () => {
      await service.findAll(
        USER,
        { transactionId: TX, page: 3, limit: 10 },
        { today: TODAY },
      );

      expect(listQb.andWhere).toHaveBeenCalledWith(
        "w.transaction_id = :transactionId",
        { transactionId: TX },
      );
      expect(listQb.skip).toHaveBeenCalledWith(20);
      expect(listQb.take).toHaveBeenCalledWith(10);
    });

    describe("the transactionId filter for a delegate (WTY-007)", () => {
      const SCOPE_CLAUSE = "t.account_id IN (:...delegateScopeAccountIds)";
      const FILTER = "w.transaction_id = :transactionId";

      it("leaves the owner's filter unchanged, with no scope lookup", async () => {
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });
        transactionQb = qbMock({ many: [linkedTransactionRow()] });

        const result = await service.findAll(
          USER,
          { transactionId: TX },
          { today: TODAY },
        );

        expect(listQb.andWhere).toHaveBeenCalledWith(FILTER, {
          transactionId: TX,
        });
        // The one transaction read is the linked purchase's, unnarrowed.
        expect(transactionRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
        expect(transactionQb.getExists).not.toHaveBeenCalled();
        expect(result.pagination.total).toBe(1);
        expect(result.data[0].transactionId).toBe(TX);
      });

      it("applies the filter when the purchase's account is in the delegate's scope", async () => {
        const scopeQb = qbMock({ exists: true });
        transactionRepo.createQueryBuilder.mockReturnValueOnce(scopeQb);
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });
        transactionQb = qbMock({ many: [linkedTransactionRow()] });

        const result = await service.findAll(
          USER,
          { transactionId: TX },
          { today: TODAY, accountScope: [ACCOUNT] },
        );

        expect(scopeQb.where).toHaveBeenCalledWith("t.id = :transactionId", {
          transactionId: TX,
        });
        expect(scopeQb.andWhere).toHaveBeenCalledWith("t.user_id = :userId", {
          userId: USER,
        });
        expect(scopeQb.andWhere).toHaveBeenCalledWith(SCOPE_CLAUSE, {
          delegateScopeAccountIds: [ACCOUNT],
        });
        expect(listQb.andWhere).toHaveBeenCalledWith(FILTER, {
          transactionId: TX,
        });
        expect(result.pagination.total).toBe(1);
        expect(result.data[0]).toMatchObject({
          id: W1,
          transactionId: TX,
          linkedTransaction: { id: TX, accountId: ACCOUNT },
        });
      });

      it("answers an empty page when the purchase's account is outside the scope", async () => {
        const scopeQb = qbMock({ exists: false });
        transactionRepo.createQueryBuilder.mockReturnValueOnce(scopeQb);
        // Were the list read, it would find the row: the filter must not run.
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });
        const other = "99999999-9999-4999-8999-999999999999";

        const result = await service.findAll(
          USER,
          { transactionId: TX, page: 2, limit: 10 },
          { today: TODAY, accountScope: [other] },
        );

        expect(scopeQb.andWhere).toHaveBeenCalledWith(SCOPE_CLAUSE, {
          delegateScopeAccountIds: [other],
        });
        expect(warrantyRepo.createQueryBuilder).not.toHaveBeenCalled();
        // The same answer as an id that matches no warranty at all.
        expect(result).toEqual({
          data: [],
          pagination: {
            page: 2,
            limit: 10,
            total: 0,
            totalPages: 0,
            hasMore: false,
          },
        });
      });

      it("answers an empty page for an empty scope without reading anything", async () => {
        listQb = qbMock({
          manyAndCount: [[warranty({ transactionId: TX })], 1],
        });

        const result = await service.findAll(
          USER,
          { transactionId: TX },
          { today: TODAY, accountScope: [] },
        );

        expect(transactionRepo.createQueryBuilder).not.toHaveBeenCalled();
        expect(warrantyRepo.createQueryBuilder).not.toHaveBeenCalled();
        expect(result.data).toEqual([]);
        expect(result.pagination.total).toBe(0);
      });
    });

    it.each([
      ["expiresOn", "w.expiresOn", "ASC", "NULLS LAST"],
      ["name", "w.name", "ASC", undefined],
      ["purchaseDate", "w.purchaseDate", "DESC", undefined],
    ] as const)("sorts by %s", async (sort, column, direction, nulls) => {
      await service.findAll(USER, { sort }, { today: TODAY });
      const expected: unknown[] = [column, direction];
      if (nulls) expected.push(nulls);
      expect(listQb.orderBy).toHaveBeenCalledWith(...expected);
      expect(listQb.addOrderBy).toHaveBeenLastCalledWith("w.id", "ASC");
    });

    it.each([
      ["expiresOn", "asc", "w.expiresOn", "ASC", "NULLS LAST"],
      ["expiresOn", "desc", "w.expiresOn", "DESC", "NULLS LAST"],
      ["name", "desc", "w.name", "DESC", undefined],
      ["purchaseDate", "asc", "w.purchaseDate", "ASC", undefined],
      ["purchaseDate", "desc", "w.purchaseDate", "DESC", undefined],
    ] as const)(
      "sorts by %s %s when sortDir is given",
      async (sort, sortDir, column, direction, nulls) => {
        await service.findAll(USER, { sort, sortDir }, { today: TODAY });
        const expected: unknown[] = [column, direction];
        if (nulls) expected.push(nulls);
        expect(listQb.orderBy).toHaveBeenCalledWith(...expected);
      },
    );

    it("reads today in the user's timezone, not the server's", async () => {
      // 03:00 UTC on the 21st is still the 20th in Toronto.
      jest.useFakeTimers().setSystemTime(new Date("2026-10-21T03:00:00Z"));
      listQb = qbMock({
        manyAndCount: [[warranty({ expiresOn: "2026-10-20" })], 1],
      });

      const { data } = await requestContextStorage.run(
        { userId: USER, timezone: "America/Toronto" },
        () => service.findAll(USER, {}),
      );

      expect(data[0]).toMatchObject({
        today: "2026-10-20",
        status: "expiring",
        daysLeft: 0,
      });
    });

    it("skips the enrichment reads for an empty page", async () => {
      const result = await service.findAll(USER, {}, { today: TODAY });
      expect(result.data).toEqual([]);
      expect(mocks.manager.query).not.toHaveBeenCalled();
      expect(claimRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe("findOne", () => {
    it("is a 404 for a warranty that is not the caller's", async () => {
      await expect(service.findOne(USER, W1, { today: TODAY })).rejects.toThrow(
        NotFoundException,
      );
      expect(warrantyRepo.findOne).toHaveBeenCalledWith({
        where: { id: W1, userId: USER },
      });
    });

    it("returns the view", async () => {
      warrantyRepo.findOne.mockResolvedValue(warranty());
      const view = await service.findOne(USER, W1, { today: "2028-10-02" });
      expect(view).toMatchObject({ status: "expired", daysLeft: -1 });
    });

    it("narrows the linked purchase to a delegate's scope as the list does (WTY-007)", async () => {
      warrantyRepo.findOne.mockResolvedValue(warranty({ transactionId: TX }));
      transactionQb = qbMock({ many: [] });

      const view = await service.findOne(USER, W1, {
        today: TODAY,
        accountScope: ["99999999-9999-4999-8999-999999999999"],
      });

      expect(transactionQb.andWhere).toHaveBeenCalledWith(
        "t.account_id IN (:...delegateScopeAccountIds)",
        expect.anything(),
      );
      expect(view.linkedTransaction).toBeNull();
      expect(view).not.toHaveProperty("transactionId");
    });
  });

  describe("summary", () => {
    it("counts unarchived warranties per status in one query", async () => {
      const summaryQb = qbMock({
        rawOne: {
          total: "7",
          lifetime: "1",
          active: "3",
          expiring: "2",
          expired: "1",
        },
      });
      warrantyRepo.createQueryBuilder.mockReturnValue(summaryQb);

      const result = await service.summary(USER, { today: TODAY });

      expect(result).toEqual({
        today: TODAY,
        windowDays: 30,
        counts: { lifetime: 1, active: 3, expiring: 2, expired: 1 },
        total: 7,
      });
      expect(summaryQb.andWhere).toHaveBeenCalledWith("w.archived_at IS NULL");
      expect(summaryQb.addSelect).toHaveBeenCalledWith(
        "COUNT(*) FILTER (WHERE w.is_lifetime = :expiredIsLifetime AND w.expires_on <= :expiredExpiresTo)",
        "expired",
      );
      expect(summaryQb.setParameters).toHaveBeenCalledWith({
        activeIsLifetime: false,
        activeExpiresFrom: "2026-11-21",
      });
    });

    it("answers zero for a user with no warranties", async () => {
      warrantyRepo.createQueryBuilder.mockReturnValue(
        qbMock({
          rawOne: {
            total: "0",
            lifetime: "0",
            active: "0",
            expiring: "0",
            expired: "0",
          },
        }),
      );
      const result = await service.summary(USER, { today: TODAY });
      expect(result.total).toBe(0);
      expect(result.counts.expiring).toBe(0);
    });
  });

  describe("create (WTY-005)", () => {
    it("stores the warranty and answers its view", async () => {
      const view = await service.create(
        USER,
        createDto({
          vendorName: "  ",
          serialNumbers: [" SN-1 ", ""],
          purchasePrice: 10,
          currencyCode: "CAD",
        }),
        { today: TODAY },
      );

      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          name: "Laptop",
          vendorName: null,
          serialNumbers: ["SN-1"],
          warrantyKind: "manufacturer",
          expiresOn: "2028-10-01",
          isLifetime: false,
          purchasePrice: 10,
          currencyCode: "CAD",
        }),
      );
      expect(view).toMatchObject({ status: "active", documentCount: 0 });
    });

    it("turns a term into expiresOn from the purchase date (example 2)", async () => {
      await service.create(
        USER,
        createDto({
          purchaseDate: "2026-01-31",
          expiresOn: undefined,
          term: { months: 18 },
        }),
        { today: TODAY },
      );
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ expiresOn: "2027-07-31", isLifetime: false }),
      );
    });

    it("stores a lifetime warranty with no date", async () => {
      await service.create(
        USER,
        createDto({ expiresOn: undefined, isLifetime: true }),
        { today: TODAY },
      );
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ expiresOn: null, isLifetime: true }),
      );
    });

    it("loads the linked transaction and payee by (id, userId) before the write, in the same transaction", async () => {
      transactionRepo.findOne.mockResolvedValue({
        id: TX,
        parentTransactionId: null,
      });
      payeeRepo.findOne.mockResolvedValue({ id: PAYEE });

      await service.create(
        USER,
        createDto({ transactionId: TX, payeeId: PAYEE }),
        { today: TODAY },
      );

      expect(transactionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TX, userId: USER } }),
      );
      expect(payeeRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PAYEE, userId: USER } }),
      );
      expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(transactionRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        warrantyRepo.save.mock.invocationCallOrder[0],
      );
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: TX, payeeId: PAYEE }),
      );
    });

    it("is a 404 for a transaction that is not the caller's, and writes nothing", async () => {
      await expect(
        service.create(USER, createDto({ transactionId: TX }), {
          today: TODAY,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("is a 404 for a payee that is not the caller's, and writes nothing", async () => {
      await expect(
        service.create(USER, createDto({ payeeId: PAYEE }), { today: TODAY }),
      ).rejects.toThrow(NotFoundException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a split line as the purchase", async () => {
      transactionRepo.findOne.mockResolvedValue({
        id: TX,
        parentTransactionId: "77777777-7777-4777-8777-777777777777",
      });
      await expect(
        service.create(USER, createDto({ transactionId: TX }), {
          today: TODAY,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("is a 404 for an unknown currency rather than a foreign-key 500", async () => {
      await expect(
        service.create(
          USER,
          createDto({ purchasePrice: 5, currencyCode: "ZZZ" }),
          { today: TODAY },
        ),
      ).rejects.toThrow(NotFoundException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it.each([
      ["an expiry before the purchase", { expiresOn: "2026-09-30" }],
      ["a zero term", { expiresOn: undefined, term: { years: 0 } }],
      ["no expiry at all", { expiresOn: undefined }],
      ["a price without a currency", { purchasePrice: 5 }],
    ])(
      "refuses %s with a 400 and writes nothing",
      async (_label, overrides) => {
        await expect(
          service.create(USER, createDto(overrides), { today: TODAY }),
        ).rejects.toThrow(BadRequestException);
        expect(warrantyRepo.save).not.toHaveBeenCalled();
      },
    );
  });

  describe("createRow", () => {
    it("writes on the caller's manager and answers the entity without the view's reads", async () => {
      const row = await service.createRow(
        mocks.manager as unknown as EntityManager,
        USER,
        createDto({ purchasePrice: 10, currencyCode: "CAD" }),
      );

      expect(row).toMatchObject({ id: W1, userId: USER, name: "Laptop" });
      expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
      expect(mocks.manager.query).not.toHaveBeenCalled();
      expect(claimRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("refuses another user's transaction before the write (WTY-005)", async () => {
      await expect(
        service.createRow(
          mocks.manager as unknown as EntityManager,
          USER,
          createDto({ transactionId: TX }),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(transactionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TX, userId: USER } }),
      );
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    beforeEach(() => {
      warrantyRepo.findOne.mockResolvedValue(
        warranty({ transactionId: TX, payeeId: PAYEE }),
      );
    });

    it("is a 404 for a warranty that is not the caller's", async () => {
      warrantyRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update(USER, W1, { name: "x" }, { today: TODAY }),
      ).rejects.toThrow(NotFoundException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("does not reload a link the form merely resent, and writes nothing when nothing changed", async () => {
      await service.update(
        USER,
        W1,
        {
          name: "Laptop",
          transactionId: TX,
          payeeId: PAYEE,
          purchaseDate: "2026-10-01",
          expiresOn: "2028-10-01",
          isLifetime: false,
          purchasePrice: 1499.99,
          currencyCode: "CAD",
          serialNumbers: ["SN-1"],
          vendorName: "Best Buy",
        },
        { today: TODAY },
      );

      expect(transactionRepo.findOne).not.toHaveBeenCalled();
      expect(payeeRepo.findOne).not.toHaveBeenCalled();
      expect(currencyRepo.findOne).not.toHaveBeenCalled();
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("loads a changed transaction by (id, userId) and refuses a foreign one before writing", async () => {
      const other = "88888888-8888-4888-8888-888888888888";
      await expect(
        service.update(
          USER,
          W1,
          { transactionId: other, name: "Renamed" },
          { today: TODAY },
        ),
      ).rejects.toThrow(NotFoundException);
      expect(transactionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: other, userId: USER } }),
      );
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("unlinks without a lookup", async () => {
      await service.update(
        USER,
        W1,
        { transactionId: null, payeeId: "" },
        { today: TODAY },
      );
      expect(transactionRepo.findOne).not.toHaveBeenCalled();
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: null, payeeId: null }),
      );
    });

    it("re-dates a term from the stored purchase date when the payload has none", async () => {
      warrantyRepo.findOne.mockResolvedValue(
        warranty({ purchaseDate: "2026-01-31", expiresOn: "2027-01-31" }),
      );
      await service.update(USER, W1, { term: { months: 1 } }, { today: TODAY });
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ expiresOn: "2026-02-28" }),
      );
    });

    it("never writes a null name or warranty kind, whatever reaches it", async () => {
      // The DTO refuses both with a 400; this holds the service's own guard.
      await service.update(
        USER,
        W1,
        {
          name: null,
          warrantyKind: null,
          notes: "kept",
        } as unknown as UpdateWarrantyDto,
        { today: TODAY },
      );
      const saved = warrantyRepo.save.mock.calls[0][0] as Warranty;
      expect(saved.name).toBe("Laptop");
      expect(saved.warrantyKind).toBe("manufacturer");
      expect(saved.notes).toBe("kept");
    });

    it("clears the vendor on a null", async () => {
      await service.update(USER, W1, { vendorName: null }, { today: TODAY });
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ vendorName: null }),
      );
    });

    it("takes a cleared expiry beside isLifetime: true", async () => {
      await service.update(
        USER,
        W1,
        { expiresOn: null, isLifetime: true },
        { today: TODAY },
      );
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isLifetime: true, expiresOn: null }),
      );
    });

    it("makes a dated warranty lifetime, clearing the date", async () => {
      await service.update(USER, W1, { isLifetime: true }, { today: TODAY });
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isLifetime: true, expiresOn: null }),
      );
    });

    it("refuses to end a lifetime warranty without saying when", async () => {
      warrantyRepo.findOne.mockResolvedValue(
        warranty({ isLifetime: true, expiresOn: null }),
      );
      await expect(
        service.update(USER, W1, { isLifetime: false }, { today: TODAY }),
      ).rejects.toThrow(BadRequestException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a purchase date moved past the stored expiry", async () => {
      await expect(
        service.update(
          USER,
          W1,
          { purchaseDate: "2029-01-01" },
          { today: TODAY },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("refuses clearing the price while the stored currency stays", async () => {
      await expect(
        service.update(USER, W1, { purchasePrice: null }, { today: TODAY }),
      ).rejects.toThrow(BadRequestException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });

    it("clears price and currency together", async () => {
      await service.update(
        USER,
        W1,
        { purchasePrice: null, currencyCode: null },
        { today: TODAY },
      );
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ purchasePrice: null, currencyCode: null }),
      );
    });

    it("checks a changed currency exists", async () => {
      await expect(
        service.update(
          USER,
          W1,
          { purchasePrice: 3, currencyCode: "ZZZ" },
          { today: TODAY },
        ),
      ).rejects.toThrow(NotFoundException);
      expect(warrantyRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes by (id, userId)", async () => {
      await service.remove(USER, W1);
      expect(warrantyRepo.delete).toHaveBeenCalledWith({
        id: W1,
        userId: USER,
      });
    });

    it("is a 404 when nothing was the caller's", async () => {
      warrantyRepo.delete.mockResolvedValue({ affected: 0, raw: [] });
      await expect(service.remove(USER, W1)).rejects.toThrow(NotFoundException);
    });
  });

  describe("archive and unarchive", () => {
    it("stamps archivedAt", async () => {
      warrantyRepo.findOne.mockResolvedValue(warranty());
      const view = await service.archive(USER, W1, { today: TODAY });
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ archivedAt: expect.any(Date) }),
      );
      expect(view.archivedAt).not.toBeNull();
    });

    it("keeps the first archive date when archived again", async () => {
      const archivedAt = new Date("2026-10-01T00:00:00.000Z");
      warrantyRepo.findOne.mockResolvedValue(warranty({ archivedAt }));
      const view = await service.archive(USER, W1, { today: TODAY });
      expect(warrantyRepo.save).not.toHaveBeenCalled();
      expect(view.archivedAt).toBe("2026-10-01T00:00:00.000Z");
    });

    it("clears archivedAt", async () => {
      warrantyRepo.findOne.mockResolvedValue(
        warranty({ archivedAt: new Date("2026-10-01T00:00:00.000Z") }),
      );
      const view = await service.unarchive(USER, W1, { today: TODAY });
      expect(warrantyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ archivedAt: null }),
      );
      expect(view.archivedAt).toBeNull();
    });

    it("is a 404 for a warranty that is not the caller's", async () => {
      await expect(service.archive(USER, W1, { today: TODAY })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getLlmWarranties (decision 11)", () => {
    it("answers the model's shape from the list's own rows, statuses and counts", async () => {
      listQb = qbMock({
        manyAndCount: [
          [
            warranty({ transactionId: TX }),
            warranty({ id: W2, isLifetime: true, expiresOn: null }),
          ],
          7,
        ],
      });
      mocks.manager.query.mockResolvedValue([{ warranty_id: W1, count: "2" }]);
      claimQb = qbMock({ rawMany: [{ warrantyId: W2, count: "1" }] });
      transactionQb = qbMock({ many: [linkedTransactionRow()] });

      const result = await service.getLlmWarranties(
        USER,
        {},
        { today: "2028-09-02" },
      );

      expect(result).toEqual({
        today: "2028-09-02",
        windowDays: 30,
        total: 7,
        warranties: [
          {
            id: W1,
            name: "Laptop",
            vendorName: "Best Buy",
            warrantyKind: "manufacturer",
            purchaseDate: "2026-10-01",
            expiresOn: "2028-10-01",
            isLifetime: false,
            status: "expiring",
            daysLeft: 29,
            purchasePrice: 1499.99,
            currencyCode: "CAD",
            serialNumbers: ["SN-1"],
            linkedTransactionId: TX,
            openClaimCount: 0,
            documentCount: 2,
            archived: false,
          },
          expect.objectContaining({
            id: W2,
            status: "lifetime",
            daysLeft: null,
            linkedTransactionId: null,
            openClaimCount: 1,
            documentCount: 0,
          }),
        ],
      });
      // Unarchived only, soonest expiry first, 20 rows when unasked.
      expect(listQb.andWhere).toHaveBeenCalledWith("w.archived_at IS NULL");
      expect(listQb.orderBy).toHaveBeenCalledWith(
        "w.expiresOn",
        "ASC",
        "NULLS LAST",
      );
      expect(listQb.take).toHaveBeenCalledWith(20);
    });

    it("forwards the status and the search to the list's filters", async () => {
      await service.getLlmWarranties(
        USER,
        { status: "expiring", q: "laptop" },
        { today: TODAY },
      );

      expect(listQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("w.expires_on <= :expiringExpiresTo"),
        expect.objectContaining({ expiringExpiresTo: "2026-11-20" }),
      );
      expect(listQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("w.name ILIKE :q"),
        { q: "%laptop%" },
      );
    });

    it.each([
      [500, 50],
      [0, 1],
      [12, 12],
    ])("bounds a limit of %p to %p rows", async (limit, take) => {
      await service.getLlmWarranties(USER, { limit }, { today: TODAY });
      expect(listQb.take).toHaveBeenCalledWith(take);
    });

    it("answers a null linkedTransactionId for a purchase outside a delegate's scope (WTY-007)", async () => {
      listQb = qbMock({
        manyAndCount: [[warranty({ transactionId: TX })], 1],
      });
      transactionQb = qbMock({ many: [] });

      const { warranties } = await service.getLlmWarranties(
        USER,
        {},
        {
          today: TODAY,
          accountScope: ["99999999-9999-4999-8999-999999999999"],
        },
      );

      expect(warranties[0].linkedTransactionId).toBeNull();
      expect(JSON.stringify(warranties)).not.toContain(TX);
    });

    it("reads today in the user's timezone when the caller passes none", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-10-21T03:00:00Z"));

      const result = await requestContextStorage.run(
        { userId: USER, timezone: "America/Toronto" },
        () => service.getLlmWarranties(USER, {}),
      );

      expect(result.today).toBe("2026-10-20");
    });
  });

  describe("todayForUser", () => {
    const now = new Date("2026-10-21T03:00:00Z");

    it("reads the user's effective timezone and answers today there", async () => {
      mocks.manager.query.mockResolvedValue([
        { timezone: "America/Toronto", last_client_timezone: null },
      ]);

      await expect(service.todayForUser(USER, now)).resolves.toBe("2026-10-20");
      expect(mocks.manager.query).toHaveBeenCalledWith(
        expect.stringContaining("user_preferences"),
        [USER],
      );
    });

    it("falls back to the last client timezone, then UTC", async () => {
      mocks.manager.query.mockResolvedValue([
        { timezone: "browser", last_client_timezone: "America/Vancouver" },
      ]);
      await expect(service.todayForUser(USER, now)).resolves.toBe("2026-10-20");

      mocks.manager.query.mockResolvedValue([]);
      await expect(service.todayForUser(USER, now)).resolves.toBe("2026-10-21");
    });

    it("counts an unresolvable zone in UTC", async () => {
      mocks.manager.query.mockResolvedValue([
        { timezone: "Not/AZone", last_client_timezone: null },
      ]);
      await expect(service.todayForUser(USER, now)).resolves.toBe("2026-10-21");
    });
  });
});
