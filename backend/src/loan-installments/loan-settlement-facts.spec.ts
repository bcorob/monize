import { EntityManager } from "typeorm";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransactionPosting } from "../scheduled-transactions/entities/scheduled-transaction-posting.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { ACCOUNT_BALANCES_AS_OF_DATES_SQL } from "../common/ledger-balance.sql";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { loadLoanSettlementFacts } from "./loan-settlement-facts";

/**
 * The facts loader reads what the pure planner prices from, after the locks
 * of `docs/specs/loan-installment-settlement.md` section 13 when asked to
 * lock: the schedule row, then `lockAccountsForBalanceWrite(source, loan)`,
 * then every financial read. A mock proves the order of the calls and what
 * each is asked for, not the locking itself (`docs/verification-contract.md`);
 * the two-connection proof is B5's.
 */
describe("loadLoanSettlementFacts", () => {
  const userId = "user-1";
  const loanId = "acc-loan";
  const chequingId = "acc-chequing";
  const scheduleId = "st-loan";

  let manager: Record<string, jest.Mock>;
  let accounts: Record<string, jest.Mock>;
  let schedules: Record<string, jest.Mock>;
  let splits: Record<string, jest.Mock>;
  let postings: Record<string, jest.Mock>;
  let rateChanges: Record<string, jest.Mock>;

  const m = () => manager as unknown as EntityManager;

  const account = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanId,
      userId,
      accountType: AccountType.MORTGAGE,
      currencyCode: "EUR",
      scheduledTransactionId: scheduleId,
      interestRate: 2,
      ...overrides,
    }) as unknown as Account;

  const schedule = (
    overrides: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: scheduleId,
      userId,
      accountId: chequingId,
      amount: -1333.3333,
      frequency: "MONTHLY",
      startDate: "2024-01-01",
      nextDueDate: "2024-03-01",
      endDate: null,
      occurrencesRemaining: null,
      isActive: true,
      ...overrides,
    }) as unknown as ScheduledTransaction;

  const input = {
    loanAccountId: loanId,
    sourceAccountId: chequingId,
    window: { from: "2024-01-25", to: "2024-03-08" },
    rowIds: ["tx-row", "tx-posted"],
  };

  beforeEach(() => {
    accounts = { findOne: jest.fn().mockResolvedValue(account()) };
    schedules = { findOne: jest.fn().mockResolvedValue(schedule()) };
    splits = { find: jest.fn().mockResolvedValue([{ id: "split-principal" }]) };
    postings = {
      find: jest
        .fn()
        .mockImplementation(
          async (options: { where: Record<string, unknown> }) =>
            "transactionId" in options.where
              ? [{ id: "claim-posted", transactionId: "tx-posted" }]
              : [
                  {
                    id: "claim-1",
                    originalDueDate: "2024-02-01",
                    source: "post",
                    transactionId: null,
                  },
                ],
        ),
    };
    rateChanges = {
      find: jest
        .fn()
        .mockResolvedValue([{ effectiveDate: "2024-01-01", annualRate: 2 }]),
    };
    manager = createScopedDbMocks([
      [Account, accounts],
      [ScheduledTransaction, schedules],
      [ScheduledTransactionSplit, splits],
      [ScheduledTransactionPosting, postings],
      [LoanRateChange, rateChanges],
    ]).manager;
    manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql === ACCOUNT_BALANCES_AS_OF_DATES_SQL) {
        return (params[2] as string[]).map((date) => ({
          as_of: date,
          balance: date === "2024-02-01" ? "-299166.6700" : "-298333.3400",
        }));
      }
      return [];
    });
  });

  it("locks the schedule row, then both accounts ascending, then reads", async () => {
    const result = await loadLoanSettlementFacts(m(), userId, input, {
      lock: true,
    });
    expect(result.kind).toBe("facts");

    expect(schedules.findOne).toHaveBeenCalledWith({
      where: { id: scheduleId, userId },
      lock: { mode: "pessimistic_write" },
    });
    const lockCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("FOR UPDATE"),
    );
    expect(lockCall).toEqual([
      expect.stringContaining(
        "FROM accounts WHERE id = ANY($1) AND user_id = $2 ORDER BY id FOR UPDATE",
      ),
      [[chequingId, loanId], userId],
    ]);

    const orderOf = (
      mock: jest.Mock,
      predicate: (call: unknown[]) => boolean = () => true,
    ) => mock.mock.invocationCallOrder[mock.mock.calls.findIndex(predicate)];
    const scheduleLock = orderOf(schedules.findOne);
    const accountLock = orderOf(manager.query, ([sql]) =>
      String(sql).includes("FOR UPDATE"),
    );
    const accountReread = accounts.findOne.mock.invocationCallOrder[1];
    const debtRead = orderOf(
      manager.query,
      ([sql]) => sql === ACCOUNT_BALANCES_AS_OF_DATES_SQL,
    );
    expect(scheduleLock).toBeLessThan(accountLock);
    expect(accountLock).toBeLessThan(accountReread);
    expect(accountLock).toBeLessThan(orderOf(rateChanges.find));
    expect(accountLock).toBeLessThan(orderOf(splits.find));
    expect(accountLock).toBeLessThan(orderOf(postings.find));
    expect(accountLock).toBeLessThan(debtRead);
  });

  it("takes no lock for a preview and reads the account once", async () => {
    await loadLoanSettlementFacts(m(), userId, input, { lock: false });
    expect(schedules.findOne).toHaveBeenCalledWith({
      where: { id: scheduleId, userId },
    });
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes("FOR UPDATE"),
      ),
    ).toBe(false);
    expect(accounts.findOne).toHaveBeenCalledTimes(1);
  });

  it("returns the slots of the window, the claims over their periods and the debt at each slot", async () => {
    const result = await loadLoanSettlementFacts(m(), userId, input, {
      lock: false,
    });
    if (result.kind !== "facts") throw new Error(result.reason);
    expect(result.slots.map((s) => s.date)).toEqual([
      "2024-02-01",
      "2024-03-01",
    ]);
    // The periods run from 2024-02-01 to (not including) 2024-04-01.
    expect(postings.find).toHaveBeenCalledWith({
      select: {
        id: true,
        originalDueDate: true,
        source: true,
        transactionId: true,
      },
      where: {
        scheduledTransactionId: scheduleId,
        originalDueDate: expect.objectContaining({
          _type: "between",
          _value: ["2024-02-01", "2024-03-31"],
        }),
      },
      order: { originalDueDate: "ASC" },
    });
    expect(result.claims).toEqual([
      {
        id: "claim-1",
        originalDueDate: "2024-02-01",
        source: "post",
        transactionId: null,
      },
    ]);
    expect(manager.query).toHaveBeenCalledWith(
      ACCOUNT_BALANCES_AS_OF_DATES_SQL,
      [loanId, userId, ["2024-02-01", "2024-03-01"]],
    );
    expect(result.debtByDueDate).toEqual(
      new Map([
        ["2024-02-01", 299166.67],
        ["2024-03-01", 298333.34],
      ]),
    );
    expect(result.rateChanges).toEqual([
      { effectiveDate: "2024-01-01", annualRate: 2 },
    ]);
    expect(rateChanges.find).toHaveBeenCalledWith({
      where: { accountId: loanId },
      order: { effectiveDate: "ASC" },
    });
    expect(result.splits).toEqual([{ id: "split-principal" }]);
    expect(result.schedule?.id).toBe(scheduleId);
  });

  it("looks the pass's rows up among the claims of every schedule, of either source", async () => {
    const result = await loadLoanSettlementFacts(m(), userId, input, {
      lock: false,
    });
    if (result.kind !== "facts") throw new Error(result.reason);
    expect(postings.find).toHaveBeenCalledWith({
      select: { id: true, transactionId: true },
      where: {
        transactionId: expect.objectContaining({
          _type: "in",
          _value: ["tx-row", "tx-posted"],
        }),
      },
    });
    expect(result.postedRowIds).toEqual(new Set(["tx-posted"]));
  });

  it("reads no post claims when the pass names no rows", async () => {
    const result = await loadLoanSettlementFacts(
      m(),
      userId,
      { ...input, rowIds: undefined },
      { lock: false },
    );
    if (result.kind !== "facts") throw new Error(result.reason);
    expect(result.postedRowIds).toEqual(new Set());
    expect(
      postings.find.mock.calls.some(
        ([options]) => "transactionId" in options.where,
      ),
    ).toBe(false);
  });

  it("answers unavailable for a loan that is not the owner's", async () => {
    accounts.findOne.mockResolvedValue(null);
    const result = await loadLoanSettlementFacts(m(), "user-2", input, {
      lock: true,
    });
    expect(result).toEqual({
      kind: "unavailable",
      reason: `loan account ${loanId} could not be read`,
    });
    expect(accounts.findOne).toHaveBeenCalledWith({
      where: { id: loanId, userId: "user-2" },
    });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("answers unavailable when the account row is gone between the pointer read and the lock", async () => {
    accounts.findOne
      .mockResolvedValueOnce(account())
      .mockResolvedValueOnce(null);
    const result = await loadLoanSettlementFacts(m(), userId, input, {
      lock: true,
    });
    expect(result.kind).toBe("unavailable");
  });

  it("reports no schedule, with no slots and no debts, when the pointer is unset", async () => {
    accounts.findOne.mockResolvedValue(
      account({ scheduledTransactionId: null }),
    );
    const result = await loadLoanSettlementFacts(m(), userId, input, {
      lock: true,
    });
    expect(result).toMatchObject({
      kind: "facts",
      schedule: null,
      splits: [],
      slots: [],
      claims: [],
    });
    if (result.kind !== "facts") throw new Error("unreachable");
    expect(result.debtByDueDate.size).toBe(0);
    expect(schedules.findOne).not.toHaveBeenCalled();
    // The accounts are still locked: the planner refuses under the same protocol.
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes("FOR UPDATE"),
      ),
    ).toBe(true);
    expect(manager.query).not.toHaveBeenCalledWith(
      ACCOUNT_BALANCES_AS_OF_DATES_SQL,
      expect.anything(),
    );
  });

  it("reports no schedule when the row is gone or inactive", async () => {
    schedules.findOne.mockResolvedValue(null);
    expect(
      await loadLoanSettlementFacts(m(), userId, input, { lock: false }),
    ).toMatchObject({ schedule: null });
    schedules.findOne.mockResolvedValue(schedule({ isActive: false }));
    expect(
      await loadLoanSettlementFacts(m(), userId, input, { lock: false }),
    ).toMatchObject({ schedule: null });
  });

  it("reads no claims when the window reaches no slot", async () => {
    const result = await loadLoanSettlementFacts(
      m(),
      userId,
      { ...input, window: { from: "2024-02-05", to: "2024-02-20" } },
      { lock: false },
    );
    if (result.kind !== "facts") throw new Error(result.reason);
    expect(result.slots).toEqual([]);
    expect(
      postings.find.mock.calls.some(
        ([options]) => "scheduledTransactionId" in options.where,
      ),
    ).toBe(false);
    expect(result.debtByDueDate.size).toBe(0);
  });

  it("answers unavailable when the ledger cannot be read, never a zero debt", async () => {
    manager.query.mockImplementation(async (sql: string) =>
      sql === ACCOUNT_BALANCES_AS_OF_DATES_SQL ? [] : [],
    );
    expect(
      await loadLoanSettlementFacts(m(), userId, input, { lock: false }),
    ).toEqual({
      kind: "unavailable",
      reason: `the ledger balance for loan account ${loanId} could not be read`,
    });
  });
});
