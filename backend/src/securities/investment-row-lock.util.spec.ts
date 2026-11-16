jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

import { ConflictException, NotFoundException } from "@nestjs/common";
import * as locks from "../common/db/locks";
import type { LockedInvestmentTransactionRow } from "../common/db/locks";
import {
  investmentRowChangedSince,
  lockUnchangedInvestmentRow,
} from "./investment-row-lock.util";
import { InvestmentAction } from "./entities/investment-transaction.entity";

const lockMock = locks.lockInvestmentTransactionRow as jest.Mock;

const locked = (
  overrides: Partial<LockedInvestmentTransactionRow> = {},
): LockedInvestmentTransactionRow => ({
  id: "inv-1",
  accountId: "acc-1",
  securityId: "sec-1",
  fundingAccountId: "fund-1",
  transactionId: "cash-1",
  transactionSplitId: null,
  linkedTransactionId: null,
  action: InvestmentAction.BUY,
  transactionDate: "2026-01-15",
  quantity: 10,
  price: 100,
  commission: 0,
  totalAmount: 1000,
  exchangeRate: 1,
  status: "UNRECONCILED",
  ...overrides,
});

// The entity as `findOne` reads it: numbers, a NULL commission allowed.
const snapshot = (overrides: Record<string, unknown> = {}) =>
  ({
    ...locked(),
    commission: null,
    ...overrides,
  }) as never;

describe("investmentRowChangedSince", () => {
  it("is false for the row as it was read (a NULL commission reads back as 0)", () => {
    expect(investmentRowChangedSince(snapshot(), locked())).toBe(false);
  });

  it.each([
    ["the cash leg was replaced", { transactionId: "cash-2" }],
    ["the price changed", { price: 110 }],
    ["the total changed", { totalAmount: 1100 }],
    ["the account changed", { accountId: "acc-2" }],
    ["the status changed", { status: "VOID" }],
    ["the date changed", { transactionDate: "2026-01-16" }],
    ["the quantity was cleared", { quantity: null }],
    ["the rate changed", { exchangeRate: 1.1 }],
    ["the transfer was unlinked", { linkedTransactionId: "inv-2" }],
  ])("is true when %s", (_label, change) => {
    expect(investmentRowChangedSince(snapshot(), locked(change as never))).toBe(
      true,
    );
  });
});

describe("lockUnchangedInvestmentRow", () => {
  const manager = {} as never;

  it("returns the locked row when nothing changed", async () => {
    lockMock.mockResolvedValueOnce(locked());
    await expect(
      lockUnchangedInvestmentRow(manager, "user-1", snapshot()),
    ).resolves.toEqual(locked());
    expect(lockMock).toHaveBeenCalledWith(manager, "inv-1", "user-1");
  });

  it("refuses a row deleted since the read with a 404", async () => {
    lockMock.mockResolvedValueOnce(null);
    await expect(
      lockUnchangedInvestmentRow(manager, "user-1", snapshot()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a row edited since the read with a 409", async () => {
    lockMock.mockResolvedValueOnce(locked({ transactionId: "cash-2" }));
    await expect(
      lockUnchangedInvestmentRow(manager, "user-1", snapshot()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
