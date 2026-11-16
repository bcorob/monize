import { MISSING_CONTEXT_MESSAGE } from "../common/db/scoped-db";
import {
  withDelegateContext,
  withUserContext,
} from "../common/db/with-context";
import { RequestContext, getRequestContext } from "../common/request-context";
import { Currency } from "../currencies/entities/currency.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { CreateWarrantyDto } from "./dto/create-warranty.dto";
import { WarrantyClaim } from "./entities/warranty-claim.entity";
import { Warranty } from "./entities/warranty.entity";
import { WarrantiesService } from "./warranties.service";

/**
 * RLS smoke for the warranties module (real withScopedDb).
 *
 * The service spec mocks `withScopedDb` away, so it cannot see whose identity a
 * read ran under, nor whether the refusal reads of WTY-005 shared the write's
 * transaction. This suite runs the real one at `RLS_MODE=enforce` over a mock
 * `DataSource`, records the ambient context at every repository call, and
 * asserts that the create's ownership reads and its insert all run under the
 * owner's own identity, in ONE transaction, with no bypass; that a delegate's
 * sectioned read runs as `current = owner, real = delegate` with the linked
 * purchase narrowed to their account scope (WTY-007), again with no bypass;
 * and that without an ambient context the service refuses to touch the
 * database at all.
 */
describe("warranties module RLS context smoke (real withScopedDb)", () => {
  const OWNER_ID = "6b1f4a2e-0c3d-4e5f-8a9b-1c2d3e4f5a6b";
  const TX_ID = "7c2a5b3f-1d4e-4f60-9b0c-2d3e4f5a6b7c";
  const PAYEE_ID = "8d3b6c4a-2e5f-4071-8c1d-3e4f5a6b7c8d";
  const DELEGATE_ID = "a0b1c2d3-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
  const ACCOUNT_ID = "b1c2d3e4-5f60-4b7c-9d8e-9f0a1b2c3d4e";
  const CURRENT_SQL = "SELECT set_config('app.current_user_id', $1, true)";
  const REAL_SQL = "SELECT set_config('app.real_user_id', $1, true)";
  const originalMode = process.env.RLS_MODE;

  interface Seen {
    op: string;
    ctx: RequestContext | undefined;
  }
  let seen: Seen[];

  function recorded(
    label: string,
    impls: Record<string, (...args: unknown[]) => unknown>,
  ): Record<string, jest.Mock> {
    return Object.fromEntries(
      Object.entries(impls).map(([method, impl]) => [
        method,
        jest.fn(async (...args: unknown[]) => {
          seen.push({ op: `${label}.${method}`, ctx: getRequestContext() });
          return impl(...args);
        }),
      ]),
    );
  }

  function identities(): string[] {
    return seen.map(({ op, ctx }) => {
      if (ctx?.system) return `${op}: bypass`;
      if (!ctx?.userId) return `${op}: NO CONTEXT`;
      const real =
        ctx.realUserId && ctx.realUserId !== ctx.userId
          ? ` real=${ctx.realUserId}`
          : "";
      return `${op}: current=${ctx.userId}${real}`;
    });
  }

  function build() {
    const emptyQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const linkedQb = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => {
        seen.push({ op: "transactions.link", ctx: getRequestContext() });
        return [];
      }),
    };
    const listQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(async () => {
        seen.push({ op: "warranties.list", ctx: getRequestContext() });
        return [
          [
            {
              id: "9e4c7d5b-3f60-4182-9d2e-4f5a6b7c8d9e",
              userId: OWNER_ID,
              name: "Laptop",
              serialNumbers: [],
              purchaseDate: "2026-10-01",
              expiresOn: "2028-10-01",
              isLifetime: false,
              purchasePrice: null,
              currencyCode: null,
              transactionId: TX_ID,
              payeeId: PAYEE_ID,
              archivedAt: null,
              createdAt: new Date("2026-10-21T00:00:00.000Z"),
              updatedAt: new Date("2026-10-21T00:00:00.000Z"),
            },
          ],
          1,
        ];
      }),
    };
    const mocks = createScopedDbMocks([
      [
        Warranty,
        {
          ...recorded("warranties", {
            save: (value) => ({
              id: "9e4c7d5b-3f60-4182-9d2e-4f5a6b7c8d9e",
              createdAt: new Date("2026-10-21T00:00:00.000Z"),
              updatedAt: new Date("2026-10-21T00:00:00.000Z"),
              ...(value as object),
            }),
          }),
          create: jest.fn((value: unknown) => value),
          createQueryBuilder: jest.fn(() => listQb),
        },
      ],
      [
        Transaction,
        {
          ...recorded("transactions", {
            findOne: () => ({ id: TX_ID, parentTransactionId: null }),
          }),
          createQueryBuilder: jest.fn(() => linkedQb),
        },
      ],
      [
        Payee,
        recorded("payees", {
          findOne: () => ({ id: PAYEE_ID }),
          find: () => [{ id: PAYEE_ID, name: "Best Buy", hasLogo: true }],
        }),
      ],
      [Currency, recorded("currencies", { findOne: () => ({ code: "CAD" }) })],
      [WarrantyClaim, { createQueryBuilder: jest.fn(() => emptyQb) }],
    ]);
    mocks.manager.query.mockResolvedValue([]);
    return {
      mocks,
      linkedQb,
      service: new WarrantiesService(mocks.dataSource as never),
    };
  }

  const dto = (): CreateWarrantyDto =>
    Object.assign(new CreateWarrantyDto(), {
      name: "Laptop",
      purchaseDate: "2026-10-01",
      expiresOn: "2028-10-01",
      transactionId: TX_ID,
      payeeId: PAYEE_ID,
      purchasePrice: 1499.99,
      currencyCode: "CAD",
    });

  beforeEach(() => {
    process.env.RLS_MODE = "enforce";
    seen = [];
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.RLS_MODE;
    else process.env.RLS_MODE = originalMode;
  });

  it("create reads the purchase and payee and writes under the owner's identity, in one transaction (WTY-005)", async () => {
    const { mocks, service } = build();

    await withUserContext(OWNER_ID, () =>
      service.create(OWNER_ID, dto(), { today: "2026-10-21" }),
    );

    expect(identities()).toEqual([
      `transactions.findOne: current=${OWNER_ID}`,
      `payees.findOne: current=${OWNER_ID}`,
      `currencies.findOne: current=${OWNER_ID}`,
      `warranties.save: current=${OWNER_ID}`,
      `transactions.link: current=${OWNER_ID}`,
      `payees.find: current=${OWNER_ID}`,
    ]);
    expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.manager.query).toHaveBeenCalledWith(CURRENT_SQL, [OWNER_ID]);
    const statements = mocks.manager.query.mock.calls.map(([sql]) => sql);
    expect(
      statements.some((sql: string) => sql.includes("app.bypass_rls")),
    ).toBe(false);
  });

  it("a delegate's sectioned list runs as the owner with the delegate real, narrowing the purchase to their scope (WTY-007)", async () => {
    const { mocks, linkedQb, service } = build();

    const result = await withDelegateContext(OWNER_ID, DELEGATE_ID, () =>
      service.findAll(
        OWNER_ID,
        {},
        { today: "2026-10-21", accountScope: [ACCOUNT_ID] },
      ),
    );

    // Every read carries the pair the policies were written for; no bypass.
    expect(identities()).toEqual([
      `warranties.list: current=${OWNER_ID} real=${DELEGATE_ID}`,
      `transactions.link: current=${OWNER_ID} real=${DELEGATE_ID}`,
      `payees.find: current=${OWNER_ID} real=${DELEGATE_ID}`,
    ]);
    expect(mocks.manager.query).toHaveBeenCalledWith(CURRENT_SQL, [OWNER_ID]);
    expect(mocks.manager.query).toHaveBeenCalledWith(REAL_SQL, [DELEGATE_ID]);
    const statements = mocks.manager.query.mock.calls.map(([sql]) => sql);
    expect(
      statements.some((sql: string) => sql.includes("app.bypass_rls")),
    ).toBe(false);
    // The purchase read is narrowed to the granted accounts, and the narrowed
    // read returned nothing, so the row says so and withholds the id.
    expect(linkedQb.andWhere).toHaveBeenCalledWith(
      "t.account_id IN (:...delegateScopeAccountIds)",
      { delegateScopeAccountIds: [ACCOUNT_ID] },
    );
    expect(result.data[0].linkedTransaction).toBeNull();
    expect(result.data[0]).not.toHaveProperty("transactionId");
  });

  it("refuses to touch the database without an ambient context", async () => {
    const { mocks, service } = build();

    await expect(
      service.create(OWNER_ID, dto(), { today: "2026-10-21" }),
    ).rejects.toThrow(MISSING_CONTEXT_MESSAGE);
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
