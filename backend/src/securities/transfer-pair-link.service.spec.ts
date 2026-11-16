import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { HoldingsService } from "./holdings.service";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { TransferPairLinkService } from "./transfer-pair-link.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const OUT_ID = "10000000-0000-4000-8000-000000000001";
const IN_ID = "10000000-0000-4000-8000-000000000002";

/**
 * Pairing two legs is a COMMAND, and every condition that can refuse it runs
 * inside the transaction that would do the writing. A refusal that had already
 * written half a pairing would leave the ledger claiming a transfer nobody
 * recorded, so each case below asserts the refusal AND that nothing was
 * written (AGENTS.md, Transactions).
 */
describe("TransferPairLinkService", () => {
  let service: TransferPairLinkService;
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let repo: Record<string, jest.Mock>;
  let holdings: { rebuildScopesFromTransactions: jest.Mock };
  let rows: Array<Record<string, unknown>>;
  let scopeRows: Array<{ id: string }>;

  const leg = (overrides: Record<string, unknown> = {}) => ({
    id: OUT_ID,
    userId: "user-1",
    accountId: "acct-ca",
    securityId: "sec-1",
    action: "TRANSFER_OUT",
    transactionDate: "2020-01-20",
    quantity: "1140",
    status: "UNRECONCILED",
    linkedTransactionId: null,
    ...overrides,
  });

  const pair = (
    outOverrides: Record<string, unknown> = {},
    inOverrides: Record<string, unknown> = {},
  ) => [
    leg(outOverrides),
    leg({
      id: IN_ID,
      accountId: "acct-us",
      action: "TRANSFER_IN",
      ...inOverrides,
    }),
  ];

  beforeEach(async () => {
    rows = pair();
    scopeRows = [{ id: "acct-ca" }, { id: "acct-us" }];
    repo = {
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => rows),
      })),
    };
    mocks = createScopedDbMocks([[InvestmentTransaction, repo]]);
    mocks.manager.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM accounts")) return scopeRows;
      return [];
    });
    holdings = { rebuildScopesFromTransactions: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferPairLinkService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: HoldingsService, useValue: holdings },
      ],
    }).compile();

    service = module.get(TransferPairLinkService);
  });

  const link = () => service.linkPair("user-1", OUT_ID, IN_ID);

  /** Every refusal writes nothing and rebuilds nothing. */
  const expectRefused = async () => {
    await expect(link()).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.update).not.toHaveBeenCalled();
    expect(holdings.rebuildScopesFromTransactions).not.toHaveBeenCalled();
  };

  it("links both legs to each other and rebuilds the two scopes", async () => {
    const result = await link();

    expect(repo.update).toHaveBeenCalledWith(OUT_ID, {
      linkedTransactionId: IN_ID,
    });
    expect(repo.update).toHaveBeenCalledWith(IN_ID, {
      linkedTransactionId: OUT_ID,
    });
    // The destination can only take the basis the source released once a
    // replay of both ledgers has worked it out.
    expect(holdings.rebuildScopesFromTransactions).toHaveBeenCalledWith(
      "user-1",
      [
        { accountId: "acct-ca", securityId: "sec-1" },
        { accountId: "acct-us", securityId: "sec-1" },
      ],
      mocks.manager,
    );
    expect(result.rebuiltAccountIds).toEqual(["acct-ca", "acct-us"]);
  });

  it("writes the link and the rebuild in one transaction", async () => {
    await link();

    expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses one transaction named as both legs", async () => {
    await expect(
      service.linkPair("user-1", OUT_ID, OUT_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("refuses when a leg is gone", async () => {
    rows = [leg()];
    await expectRefused();
  });

  it("refuses a leg already linked to something else", async () => {
    // Somebody's pairing, not ours to replace.
    rows = pair({ linkedTransactionId: "some-other-row" });
    await expectRefused();
  });

  it("refuses a void leg, which recorded nothing", async () => {
    rows = pair({ status: "VOID" });
    await expectRefused();
  });

  it("refuses two actions that are not one transfer's legs", async () => {
    rows = pair({ action: "BUY" });
    await expectRefused();
  });

  it("refuses legs on two different securities", async () => {
    rows = pair({}, { securityId: "sec-2" });
    await expectRefused();
  });

  it("refuses legs dated on different days", async () => {
    rows = pair({}, { transactionDate: "2020-01-21" });
    await expectRefused();
  });

  it("refuses legs on one account, which moves nothing", async () => {
    rows = pair({}, { accountId: "acct-ca" });
    await expectRefused();
  });

  it("refuses legs moving different numbers of shares", async () => {
    rows = pair({}, { quantity: "1139" });
    await expectRefused();
  });

  it("pairs legs whose signs differ but whose shares match", async () => {
    // A leg's sign is its action's, not its number's.
    rows = pair({ quantity: "-1140" });

    await expect(link()).resolves.toMatchObject({ securityId: "sec-1" });
  });

  it("refuses a leg on an account outside the portfolio", async () => {
    scopeRows = [{ id: "acct-ca" }];
    await expectRefused();
  });

  describe("findCandidates", () => {
    it("asks over the whole portfolio when no account is named", async () => {
      mocks.manager.query.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM accounts")) return scopeRows;
        return [];
      });

      await service.findCandidates("user-1");

      const call = mocks.manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("out_transaction_id"),
      );
      expect(call?.[1]).toEqual(["user-1", ["acct-ca", "acct-us"]]);
    });

    it("asks nothing of a scope with no investment account in it", async () => {
      scopeRows = [];

      await expect(service.findCandidates("user-1")).resolves.toEqual([]);
      expect(
        mocks.manager.query.mock.calls.some(([sql]) =>
          String(sql).includes("out_transaction_id"),
        ),
      ).toBe(false);
    });
  });
});
