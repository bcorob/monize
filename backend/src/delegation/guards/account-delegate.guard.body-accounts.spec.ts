import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AccountDelegateGuard } from "./account-delegate.guard";
import { TransactionsController } from "../../transactions/transactions.controller";
import { ScheduledTransactionsController } from "../../scheduled-transactions/scheduled-transactions.controller";

/**
 * Every account a delegate-reachable write names in its body must be one the
 * delegation grants the route's operation on. Read through the REAL route
 * metadata (a real Reflector over the controllers' own handlers), so a route
 * that loses its decorator fails here, not only a guard branch.
 *
 * The delegate holds every operation on GRANTED (and on the existing rows'
 * accounts) and nothing on UNGRANTED; the owner holds everything.
 */
const GRANTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNGRANTED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXISTING_LEG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROW_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OVERRIDE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER = "01111111-1111-4111-8111-111111111111";
const DELEGATE = "d1111111-1111-4111-8111-111111111111";

type Handler = (...args: never[]) => unknown;

interface RouteCase {
  route: string;
  controller: { prototype: object };
  handler: string;
  params: Record<string, string>;
  body: (accountId: string) => Record<string, unknown>;
}

const routes: RouteCase[] = [
  {
    route: "POST /transactions splits[].transferAccountId",
    controller: TransactionsController,
    handler: "create",
    params: {},
    body: (id) => ({
      accountId: GRANTED,
      splits: [
        { categoryId: ROW_ID, amount: -5 },
        { transferAccountId: id, amount: -5 },
      ],
    }),
  },
  {
    route: "PATCH /transactions/:id accountId",
    controller: TransactionsController,
    handler: "update",
    params: { id: ROW_ID },
    body: (id) => ({ accountId: id }),
  },
  {
    route: "PATCH /transactions/:id splits[].transferAccountId",
    controller: TransactionsController,
    handler: "update",
    params: { id: ROW_ID },
    body: (id) => ({ splits: [{ transferAccountId: id, amount: -5 }] }),
  },
  {
    route: "POST /transactions/transfer toAccountId",
    controller: TransactionsController,
    handler: "createTransfer",
    params: {},
    body: (id) => ({ fromAccountId: GRANTED, toAccountId: id }),
  },
  {
    route: "PATCH /transactions/:id/transfer fromAccountId",
    controller: TransactionsController,
    handler: "updateTransfer",
    params: { id: ROW_ID },
    body: (id) => ({ fromAccountId: id }),
  },
  {
    route: "PATCH /transactions/:id/transfer toAccountId",
    controller: TransactionsController,
    handler: "updateTransfer",
    params: { id: ROW_ID },
    body: (id) => ({ toAccountId: id }),
  },
  {
    route: "POST /scheduled-transactions investmentFundingAccountId",
    controller: ScheduledTransactionsController,
    handler: "create",
    params: {},
    body: (id) => ({ accountId: GRANTED, investmentFundingAccountId: id }),
  },
  {
    route: "POST /scheduled-transactions splits[].transferAccountId",
    controller: ScheduledTransactionsController,
    handler: "create",
    params: {},
    body: (id) => ({
      accountId: GRANTED,
      splits: [{ transferAccountId: id, amount: -5 }],
    }),
  },
  {
    route: "PATCH /scheduled-transactions/:id accountId",
    controller: ScheduledTransactionsController,
    handler: "update",
    params: { id: ROW_ID },
    body: (id) => ({ accountId: id }),
  },
  {
    route: "PATCH /scheduled-transactions/:id transferAccountId",
    controller: ScheduledTransactionsController,
    handler: "update",
    params: { id: ROW_ID },
    body: (id) => ({ isTransfer: true, transferAccountId: id }),
  },
  {
    route: "PATCH /scheduled-transactions/:id investmentFundingAccountId",
    controller: ScheduledTransactionsController,
    handler: "update",
    params: { id: ROW_ID },
    body: (id) => ({ investmentFundingAccountId: id }),
  },
  {
    route: "PATCH /scheduled-transactions/:id splits[].transferAccountId",
    controller: ScheduledTransactionsController,
    handler: "update",
    params: { id: ROW_ID },
    body: (id) => ({ splits: [{ transferAccountId: id, amount: -5 }] }),
  },
  {
    route: "POST /scheduled-transactions/:id/post splits[].transferAccountId",
    controller: ScheduledTransactionsController,
    handler: "post",
    params: { id: ROW_ID },
    body: (id) => ({
      isSplit: true,
      splits: [{ transferAccountId: id, amount: -5 }],
    }),
  },
  {
    route:
      "POST /scheduled-transactions/:id/overrides splits[].transferAccountId",
    controller: ScheduledTransactionsController,
    handler: "createOverride",
    params: { id: ROW_ID },
    body: (id) => ({
      originalDate: "2026-01-01",
      overrideDate: "2026-01-01",
      splits: [{ transferAccountId: id, amount: -5 }],
    }),
  },
  {
    route:
      "PATCH /scheduled-transactions/:id/overrides/:overrideId splits[].transferAccountId",
    controller: ScheduledTransactionsController,
    handler: "updateOverride",
    params: { id: ROW_ID, overrideId: OVERRIDE_ID },
    body: (id) => ({ splits: [{ transferAccountId: id, amount: -5 }] }),
  },
];

describe("AccountDelegateGuard: accounts named in a write's body", () => {
  let guard: AccountDelegateGuard;
  let jwtService: { verify: jest.Mock };
  let delegationService: Record<string, jest.Mock>;

  const contextFor = (
    rc: RouteCase,
    body: Record<string, unknown>,
    token: Record<string, string>,
  ) => {
    jwtService.verify.mockReturnValue(token);
    const handler = (rc.controller.prototype as Record<string, Handler>)[
      rc.handler
    ];
    const req = {
      headers: { authorization: "Bearer x" },
      params: rc.params,
      query: {},
      body,
    };
    return {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => rc.controller,
    } as never;
  };

  const actingToken = {
    sub: DELEGATE,
    actingAsUserId: OWNER,
    delegationId: "g1",
  };

  beforeEach(() => {
    jwtService = { verify: jest.fn() };
    delegationService = {
      hasAccountPermission: jest.fn(
        async (_g: string, accountId: string) =>
          accountId === GRANTED || accountId === EXISTING_LEG,
      ),
      accountIdForTransaction: jest.fn().mockResolvedValue(GRANTED),
      accountIdsForTransfer: jest
        .fn()
        .mockResolvedValue([GRANTED, EXISTING_LEG]),
      accountIdsForScheduled: jest.fn().mockResolvedValue([GRANTED]),
      hasCapability: jest.fn().mockResolvedValue(true),
      hasSection: jest.fn().mockResolvedValue(true),
    };
    guard = new AccountDelegateGuard(
      new Reflector(),
      jwtService as never,
      delegationService as never,
      { isAccountOwnedBy: jest.fn().mockResolvedValue(false) } as never,
    );
  });

  it.each(routes.map((rc) => [rc.route, rc] as const))(
    "%s: refuses an acting delegate naming an ungranted account",
    async (_route, rc) => {
      await expect(
        guard.canActivate(contextFor(rc, rc.body(UNGRANTED), actingToken)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
        "g1",
        UNGRANTED,
        expect.any(String),
      );
    },
  );

  it.each(routes.map((rc) => [rc.route, rc] as const))(
    "%s: allows an acting delegate naming a granted account",
    async (_route, rc) => {
      await expect(
        guard.canActivate(contextFor(rc, rc.body(GRANTED), actingToken)),
      ).resolves.toBe(true);
    },
  );

  it.each(routes.map((rc) => [rc.route, rc] as const))(
    "%s: leaves the owner's own request untouched",
    async (_route, rc) => {
      await expect(
        guard.canActivate(contextFor(rc, rc.body(UNGRANTED), { sub: OWNER })),
      ).resolves.toBe(true);
      expect(delegationService.hasAccountPermission).not.toHaveBeenCalled();
    },
  );
});
