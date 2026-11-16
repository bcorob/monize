import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SelectQueryBuilder } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import {
  applyRegisterOrder,
  creditsBeforeDebitsDirection,
  isNewestPage,
  isTransactionSortField,
  registerPrimaryOrder,
  restrictToRowsNewerThanPage,
  TRANSACTION_SORT_FIELDS,
  type RegisterPageWindow,
  type RegisterSortAliases,
  type TransactionSortField,
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

type RecordedOrder = [string, string, string | undefined];

function recordingBuilder(): {
  builder: SelectQueryBuilder<Transaction>;
  calls: RecordedOrder[];
} {
  const calls: RecordedOrder[] = [];
  const builder = {
    orderBy: (column: string, direction: string, nulls?: string) => {
      calls.push([column, direction, nulls]);
      return builder;
    },
    addOrderBy: (column: string, direction: string, nulls?: string) => {
      calls.push([column, direction, nulls]);
      return builder;
    },
  } as unknown as SelectQueryBuilder<Transaction>;
  return { builder, calls };
}

function orderFor(
  direction: "ASC" | "DESC",
  field?: TransactionSortField,
  aliases?: RegisterSortAliases,
): RecordedOrder[] {
  const { builder, calls } = recordingBuilder();
  applyRegisterOrder(builder, "t", direction, field, aliases);
  return calls;
}

/** The order keys alone, for a case that is about the columns and not the nulls. */
function columnsFor(
  direction: "ASC" | "DESC",
  field?: TransactionSortField,
  aliases?: RegisterSortAliases,
): Array<[string, string]> {
  return orderFor(direction, field, aliases).map(([column, order]) => [
    column,
    order,
  ]);
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
    expect(columnsFor("DESC")).toEqual([
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
    expect(columnsFor("ASC")).toEqual([
      ["t.transactionDate", "ASC"],
      ["t.createdAt", "ASC"],
      ["t.amount", "DESC"],
      ["t.id", "ASC"],
    ]);
  });

  it("makes the date the second key under any other field", () => {
    // Without this leg a payee's rows come out in the order they were
    // imported in, because `created_at` is the next key and a whole import
    // shares one value. The register is a ledger even when it is grouped.
    expect(columnsFor("DESC", "payee")).toEqual([
      ["t.payeeName", "DESC"],
      ["t.transactionDate", "DESC"],
      ["t.createdAt", "DESC"],
      ["t.amount", "ASC"],
      ["t.id", "DESC"],
    ]);
    // The date sort does not repeat itself as its own tiebreak.
    expect(
      columnsFor("DESC").filter(([c]) => c === "t.transactionDate"),
    ).toHaveLength(1);
  });

  it("keeps the tiebreaks below every field", () => {
    for (const field of TRANSACTION_SORT_FIELDS) {
      const tail = columnsFor("DESC", field, {
        account: "account",
        category: "category",
      }).slice(-3);
      expect(tail).toEqual([
        ["t.createdAt", "DESC"],
        ["t.amount", "ASC"],
        ["t.id", "DESC"],
      ]);
    }
  });

  it("sinks nulls in both directions, on the nullable fields only", () => {
    // A blank payee is the absence of a payee, not the smallest one:
    // reversing the sort must not fill the top of the register with rows that
    // have nothing in the column being sorted by.
    for (const direction of ["ASC", "DESC"] as const) {
      expect(orderFor(direction, "payee")[0][2]).toBe("NULLS LAST");
      expect(orderFor(direction, "description")[0][2]).toBe("NULLS LAST");
      expect(orderFor(direction, "refNumber")[0][2]).toBe("NULLS LAST");
      expect(
        orderFor(direction, "category", { category: "category" })[0][2],
      ).toBe("NULLS LAST");
      // `status` is defaulted in the schema, not NOT NULL, so it sinks too.
      expect(orderFor(direction, "status")[0][2]).toBe("NULLS LAST");
      // The two columns the schema declares NOT NULL take no clause at all.
      expect(orderFor(direction, "date")[0][2]).toBeUndefined();
      expect(orderFor(direction, "amount")[0][2]).toBeUndefined();
    }
  });

  it("orders a joined field by the alias it was given", () => {
    expect(columnsFor("ASC", "account", { account: "account" })[0]).toEqual([
      "account.name",
      "ASC",
    ]);
    expect(columnsFor("ASC", "category", { category: "category" })[0]).toEqual([
      "category.name",
      "ASC",
    ]);
  });

  it("refuses a joined field on a query that does not join the table", () => {
    // The three queries that sum the rows newer than a page select from
    // `transactions` alone. Emitting `account.name` there would be SQL naming
    // an alias the statement does not have -- a runtime error on a balance
    // query, found in production rather than here.
    expect(() => registerPrimaryOrder("account", "t")).toThrow(/join alias/i);
    expect(() => registerPrimaryOrder("category", "t")).toThrow(/join alias/i);
    expect(() => orderFor("DESC", "account")).toThrow(/join alias/i);
  });

  it("names a real column for every field it offers", () => {
    // A field added to the list with no case in `registerPrimaryOrder` would
    // return undefined and order by "undefined", which PostgreSQL rejects at
    // the far end of a user's click.
    for (const field of TRANSACTION_SORT_FIELDS) {
      const { expression } = registerPrimaryOrder(field, "t", {
        account: "account",
        category: "category",
      });
      expect(expression).toMatch(/^[a-z]+\.[A-Za-z]+$/);
    }
  });

  it("recognises exactly the fields it lists", () => {
    for (const field of TRANSACTION_SORT_FIELDS) {
      expect(isTransactionSortField(field)).toBe(true);
    }
    for (const value of ["tags", "balance", "DATE", "", null, 3, ["date"]]) {
      expect(isTransactionSortField(value)).toBe(false);
    }
  });
});

/**
 * The window whose sum turns the listing's balance into this page's.
 *
 * The property is not "DESC limits and ASC offsets" -- it is that both name
 * the same set of rows: the ones the register lists nearer the newest end
 * than this page. A window that named the wrong set would put a plausible,
 * wrong balance beside every row, which is the failure mode this whole
 * mechanism exists to prevent.
 */
describe("the rows newer than a page", () => {
  function windowCalls(window: RegisterPageWindow): {
    order: Array<[string, string]>;
    limit?: number;
    offset?: number;
  } {
    const order: Array<[string, string]> = [];
    let limit: number | undefined;
    let offset: number | undefined;
    const builder = {
      orderBy: (column: string, direction: string) => {
        order.push([column, direction]);
        return builder;
      },
      addOrderBy: (column: string, direction: string) => {
        order.push([column, direction]);
        return builder;
      },
      limit: (value: number) => {
        limit = value;
        return builder;
      },
      offset: (value: number) => {
        offset = value;
        return builder;
      },
    } as unknown as SelectQueryBuilder<Transaction>;
    restrictToRowsNewerThanPage(builder, "t", window);
    return { order, limit, offset };
  }

  const page = (
    skip: number,
    limit: number,
    total: number,
    direction: "ASC" | "DESC",
  ): RegisterPageWindow => ({ skip, limit, total, direction });

  it("knows which page holds the newest row, which is not always the first", () => {
    // Newest-first: the newest row is at the top of page 1.
    expect(isNewestPage(page(0, 2, 5, "DESC"))).toBe(true);
    expect(isNewestPage(page(2, 2, 5, "DESC"))).toBe(false);
    expect(isNewestPage(page(4, 2, 5, "DESC"))).toBe(false);
    // Oldest-first: it is at the bottom of the LAST page. Reading this as
    // "page 1" is what would seed the oldest page with the whole account's
    // balance and every figure on it would be wrong.
    expect(isNewestPage(page(0, 2, 5, "ASC"))).toBe(false);
    expect(isNewestPage(page(2, 2, 5, "ASC"))).toBe(false);
    expect(isNewestPage(page(4, 2, 5, "ASC"))).toBe(true);
    // A single page is the newest page whichever way it runs.
    expect(isNewestPage(page(0, 50, 5, "ASC"))).toBe(true);
    expect(isNewestPage(page(0, 50, 5, "DESC"))).toBe(true);
    // An empty listing has no rows above anything.
    expect(isNewestPage(page(0, 50, 0, "ASC"))).toBe(true);
  });

  it("takes the pages above a newest-first page", () => {
    const { limit, offset, order } = windowCalls(page(4, 2, 9, "DESC"));
    expect(limit).toBe(4);
    expect(offset).toBeUndefined();
    expect(order[0]).toEqual(["t.transactionDate", "DESC"]);
  });

  it("takes the pages below an oldest-first page", () => {
    // Skipping 4 with a page of 2 means rows 5 and 6 are on screen; the newer
    // ones are everything from row 7, which is an OFFSET and no limit.
    const { limit, offset, order } = windowCalls(page(4, 2, 9, "ASC"));
    expect(offset).toBe(6);
    expect(limit).toBeUndefined();
    expect(order[0]).toEqual(["t.transactionDate", "ASC"]);
  });

  it("never offsets by zero, which a builder may drop", () => {
    // `skip + limit` is at least 1 whenever the window is applied at all, so
    // an offset that a query builder ignores for being falsy cannot silently
    // widen the window to the whole account.
    for (const skip of [0, 1, 7]) {
      const { offset } = windowCalls(page(skip, 3, 100, "ASC"));
      expect(offset).toBeGreaterThan(0);
    }
  });

  it("orders the window by the date, never by the reader's chosen column", () => {
    // The window is only ever used for a date-ordered register (nothing else
    // shows a balance), and it passes no join aliases, so it cannot be
    // ordered by a table its own statement does not select.
    for (const direction of ["ASC", "DESC"] as const) {
      expect(
        windowCalls(page(2, 2, 9, direction)).order.map(([c]) => c),
      ).toEqual(["t.transactionDate", "t.createdAt", "t.amount", "t.id"]);
    }
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

/** Every non-spec TypeScript file in this layer, as [path, contents]. */
function backendSources(): Array<[string, string]> {
  const root = join(__dirname, "..");
  const found: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) {
        found.push([full.slice(root.length + 1), readFileSync(full, "utf8")]);
      }
    }
  };
  walk(root);
  return found;
}

describe("the register ordering is written once", () => {
  it("has no hand-rolled copy left in the transactions service", () => {
    // One site is the register. The other three sum the rows the register
    // lists NEWER than the page being shown, so its running balance starts
    // from the right number -- and they reach that window through
    // `restrictToRowsNewerThanPage`, which owns both the order and the
    // limit/offset. Spelling either out again is how the register and the
    // sums drift apart: a tiebreak added to one re-splits the pages under the
    // others, and every balance below the first page is wrong by whichever
    // rows crossed the boundary.
    //
    // Deliberately out of scope, and why the scan is written against
    // `addOrderBy` rather than against the column name: the payee-autofill
    // lookup orders by `{ transactionDate, createdAt }` in `find`'s object
    // form. It shows no balance and no page, so it has nothing to agree with.
    const source = readFileSync(
      join(__dirname, "transactions.service.ts"),
      "utf8",
    );

    expect(source.match(/applyRegisterOrder\(/g) ?? []).toHaveLength(1);
    expect(source.match(/restrictToRowsNewerThanPage\(/g) ?? []).toHaveLength(
      3,
    );
    expect(source).not.toMatch(/addOrderBy\(\s*["'`][^"'`]*\.createdAt/);
    // A page window written by hand is the same drift by another door: it is
    // the pairing of an order with a limit/offset that has to stay in one
    // place. Scanned over the whole file rather than within a character
    // budget of the `select("t.id")` above it -- the first of the three
    // windows already sits 412 characters past its select, so a budget that
    // unmodified code exceeds is not a guard. `skip`/`take` are the
    // register's own paging and are not this rule's business.
    expect(source).not.toMatch(/\.(limit|offset)\(/);
  });
  it("gives every running balance in this layer the register's order", () => {
    // The transactions service was not the only place that walks a balance
    // down a list of rows: the account CSV export does it too, and it spelled
    // the order out for itself without the amount leg -- so an exported
    // balance could show the account overdrawn on a day a transfer had funded
    // the purchase, which is the very defect `applyRegisterOrder` exists to
    // prevent. A scan of one file could never have found it.
    //
    // The rule is narrow on purpose: if a file carries a running balance, the
    // order those rows arrived in is load-bearing, so it must come from here.
    //
    // What it does NOT cover, so nothing reads it as more: it keys on this
    // exact identifier, so a walker whose accumulator is spelled some other
    // way escapes it, and the exemption proves only that the file mentions
    // `applyRegisterOrder`, not that the query feeding the walk is the one it
    // ordered. It currently matches the account CSV export and nothing else --
    // `transactions.service.ts` carries the token nowhere, and the assertions
    // above are what hold that file. Matching case-insensitively also names
    // `buildRunningBalanceMap` in the loan payment detector, which walks a
    // balance over an array it does not order itself; that is a separate
    // question from this PR's and is reported rather than widened into here.
    const offenders = backendSources()
      .filter(([, content]) => /\brunningBalance\b/.test(content))
      .filter(([, content]) => !/applyRegisterOrder\(/.test(content))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
