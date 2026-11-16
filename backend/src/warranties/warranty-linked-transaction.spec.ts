import { EntityManager } from "typeorm";

import { Payee } from "../payees/entities/payee.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  isTransactionInScope,
  loadLinkedTransactions,
} from "./warranty-linked-transaction";

const USER = "11111111-1111-4111-8111-111111111111";
const TX = "44444444-4444-4444-8444-444444444444";
const TX2 = "77777777-7777-4777-8777-777777777777";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";

describe("warranty-linked-transaction (WTY-007)", () => {
  let qb: Record<string, jest.Mock>;
  let m: EntityManager;
  let transactionRepo: { createQueryBuilder: jest.Mock };

  beforeEach(() => {
    qb = {};
    for (const name of ["leftJoin", "select", "where", "andWhere"]) {
      qb[name] = jest.fn(() => qb);
    }
    qb.getMany = jest.fn().mockResolvedValue([]);
    qb.getExists = jest.fn().mockResolvedValue(true);
    transactionRepo = { createQueryBuilder: jest.fn(() => qb) };
    const mocks = createScopedDbMocks([[Transaction, transactionRepo]]);
    m = mocks.manager as unknown as EntityManager;
  });

  describe("loadLinkedTransactions", () => {
    it("reads nothing when no row links a purchase", async () => {
      const linked = await loadLinkedTransactions(
        m,
        USER,
        [{ transactionId: null }],
        undefined,
      );
      expect(linked.size).toBe(0);
      expect(transactionRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("reads nothing for an empty delegate scope", async () => {
      const linked = await loadLinkedTransactions(
        m,
        USER,
        [{ transactionId: TX }],
        [],
      );
      expect(linked.size).toBe(0);
      expect(transactionRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("reads each purchase once, by (id, userId), keyed by id for the owner", async () => {
      qb.getMany.mockResolvedValue([
        {
          id: TX,
          transactionDate: "2026-10-01",
          payeeName: null,
          payee: { id: "p", name: "Best Buy" } as Payee,
          amount: "-1499.9900",
          currencyCode: "CAD",
          accountId: ACCOUNT,
        },
      ]);

      const linked = await loadLinkedTransactions(
        m,
        USER,
        [{ transactionId: TX }, { transactionId: TX }, { transactionId: TX2 }],
        undefined,
      );

      expect(qb.where).toHaveBeenCalledWith("t.id IN (:...transactionIds)", {
        transactionIds: [TX, TX2],
      });
      expect(qb.andWhere).toHaveBeenCalledWith("t.user_id = :userId", {
        userId: USER,
      });
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      expect(linked.get(TX)).toEqual({
        id: TX,
        transactionDate: "2026-10-01",
        payeeName: "Best Buy",
        amount: -1499.99,
        currencyCode: "CAD",
        accountId: ACCOUNT,
      });
      expect(linked.has(TX2)).toBe(false);
    });

    it("narrows the read to a delegate's accounts", async () => {
      await loadLinkedTransactions(m, USER, [{ transactionId: TX }], [ACCOUNT]);
      expect(qb.andWhere).toHaveBeenCalledWith(
        "t.account_id IN (:...delegateScopeAccountIds)",
        { delegateScopeAccountIds: [ACCOUNT] },
      );
    });
  });

  describe("isTransactionInScope", () => {
    it("admits nothing and reads nothing for an empty scope", async () => {
      await expect(isTransactionInScope(m, USER, TX, [])).resolves.toBe(false);
      expect(transactionRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("asks whether the caller's purchase sits in a scoped account", async () => {
      qb.getExists.mockResolvedValue(false);
      await expect(isTransactionInScope(m, USER, TX, [ACCOUNT])).resolves.toBe(
        false,
      );
      expect(qb.where).toHaveBeenCalledWith("t.id = :transactionId", {
        transactionId: TX,
      });
      expect(qb.andWhere).toHaveBeenCalledWith("t.user_id = :userId", {
        userId: USER,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        "t.account_id IN (:...delegateScopeAccountIds)",
        { delegateScopeAccountIds: [ACCOUNT] },
      );
    });
  });
});
