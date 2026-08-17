import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SelectQueryBuilder } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import {
  applyRegisterOrder,
  creditsBeforeDebitsDirection,
} from "./register-order";

/**
 * The ordering itself, and the guard that stops a fifth copy of it appearing.
 *
 * The property under test is not "these four columns in this order" -- it is
 * that a credit and a debit the clock cannot separate come out chronologically
 * credit-first, whichever way the list runs. Asserting the column list alone
 * would pass for the inverted tiebreak, which is the mistake most available
 * here.
 */

function recordingBuilder(): {
  builder: SelectQueryBuilder<Transaction>;
  calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  const builder = {
    orderBy: (column: string, direction: string) => {
      calls.push([column, direction]);
      return builder;
    },
    addOrderBy: (column: string, direction: string) => {
      calls.push([column, direction]);
      return builder;
    },
  } as unknown as SelectQueryBuilder<Transaction>;
  return { builder, calls };
}

function orderFor(
  direction: "ASC" | "DESC",
  sortColumn?: string,
): Array<[string, string]> {
  const { builder, calls } = recordingBuilder();
  applyRegisterOrder(builder, "t", direction, sortColumn);
  return calls;
}

/**
 * The register as the user reads it: rows in the order the query returns them,
 * with the running balance walked down from the newest, exactly as
 * `TransactionList` does it.
 */
function runningBalances(
  rows: ReadonlyArray<{ id: string; amount: number }>,
  startingBalance: number,
): Map<string, number> {
  const balances = new Map<string, number>();
  let cumulative = 0;
  for (const row of rows) {
    balances.set(row.id, startingBalance - cumulative);
    cumulative += row.amount;
  }
  return balances;
}

/** Sorts by the ordering under test, for rows that tie on date and createdAt. */
function sortByRegisterOrder<T extends { id: string; amount: number }>(
  rows: readonly T[],
  direction: "ASC" | "DESC",
): T[] {
  const amountDirection = creditsBeforeDebitsDirection(direction);
  return [...rows].sort((a, b) =>
    a.amount === b.amount
      ? a.id.localeCompare(b.id) * (direction === "DESC" ? -1 : 1)
      : (a.amount - b.amount) * (amountDirection === "ASC" ? 1 : -1),
  );
}

describe("applyRegisterOrder", () => {
  it("orders by date, then created_at, then amount, then id", () => {
    expect(orderFor("DESC")).toEqual([
      ["t.transactionDate", "DESC"],
      ["t.createdAt", "DESC"],
      ["t.amount", "ASC"],
      ["t.id", "DESC"],
    ]);
  });

  it("runs the amount tiebreak opposite to the list, in both directions", () => {
    // The rule is chronological -- credits first -- so a newest-first list puts
    // them last. Hardcoding ASC would silently invert the ascending register.
    expect(creditsBeforeDebitsDirection("DESC")).toBe("ASC");
    expect(creditsBeforeDebitsDirection("ASC")).toBe("DESC");
    expect(orderFor("ASC")).toEqual([
      ["t.transactionDate", "ASC"],
      ["t.createdAt", "ASC"],
      ["t.amount", "DESC"],
      ["t.id", "ASC"],
    ]);
  });

  it("keeps the tiebreaks when the user sorts by amount or payee", () => {
    expect(orderFor("DESC", "payeeName")[0]).toEqual(["t.payeeName", "DESC"]);
    expect(orderFor("DESC", "payeeName").slice(1)).toEqual([
      ["t.createdAt", "DESC"],
      ["t.amount", "ASC"],
      ["t.id", "DESC"],
    ]);
  });
});

describe("the running balance a tied credit and debit produce", () => {
  // The reported case: an investment purchase funded by a transfer on the same
  // day. Both rows are written by one import, so `created_at` -- which defaults
  // to CURRENT_TIMESTAMP, one value per transaction -- cannot separate them,
  // and the order used to fall through to a random UUID.
  const TRANSFER_IN = { id: "aaaa-credit", amount: 2400 };
  const PURCHASE = { id: "bbbb-debit", amount: -2400 };
  const OPENING = 0;

  it.each([["DESC" as const], ["ASC" as const]])(
    "never dips below zero in a %s register",
    (direction) => {
      const rows = sortByRegisterOrder([PURCHASE, TRANSFER_IN], direction);
      // The running balance is only ever walked newest-first.
      const newestFirst = direction === "DESC" ? rows : [...rows].reverse();
      const balances = runningBalances(newestFirst, OPENING);

      expect(Math.min(...balances.values())).toBe(0);
      expect(balances.get(TRANSFER_IN.id)).toBe(2400);
      expect(balances.get(PURCHASE.id)).toBe(0);
    },
  );

  it("dips negative when the debit is treated as the older row", () => {
    // The defect, stated as a test: with the credit ordered second in a
    // newest-first list, the purchase reads as having happened first and the
    // account appears overdrawn on a day it was never short.
    const balances = runningBalances([TRANSFER_IN, PURCHASE], OPENING);

    expect(balances.get(PURCHASE.id)).toBe(-2400);
  });
});

describe("the register ordering is written once", () => {
  it("has no hand-rolled copy left in the transactions service", () => {
    // Three of the four sites sum the rows on *previous* pages so page N's
    // running balance starts from the right number. A tiebreak added to the
    // register alone re-splits the pages under those sums.
    //
    // Deliberately out of scope, and why the scan is written against
    // `addOrderBy` rather than against the column name: the payee-autofill
    // lookup orders by `{ transactionDate, createdAt }` in `find`'s object
    // form. It shows no balance and no page, so it has nothing to agree with.
    const source = readFileSync(
      join(__dirname, "transactions.service.ts"),
      "utf8",
    );

    const applications = source.match(/applyRegisterOrder\(/g) ?? [];
    expect(applications).toHaveLength(4);
    expect(source).not.toMatch(/addOrderBy\(\s*["'`][^"'`]*\.createdAt/);
  });
});
