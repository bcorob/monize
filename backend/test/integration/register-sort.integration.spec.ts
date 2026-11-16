import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import {
  TRANSACTION_SORT_FIELDS,
  type TransactionSortField,
} from "@/transactions/register-order";
import type { TagKeyFilter } from "@/transactions/tag-key-filter.util";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * The register's sort, against a real PostgreSQL.
 *
 * Two properties no mock can show. The first is the one the whole design
 * exists for: **a row's running balance is the same figure whichever way the
 * date register runs.** The seed is the balance after the page's newest row
 * and the client walks it newest-first, so reversing the register reverses
 * which rows are "newer than this page" -- the pages above become the pages
 * below -- and only a real query over real pages proves the two windows name
 * the same rows. A unit test with a mocked query builder asserts the SQL it
 * was handed, which is the thing under suspicion.
 *
 * The second is that **every sortable column can actually be paged by.**
 * TypeORM pages a query with joins by selecting DISTINCT ids plus the order
 * columns from a subquery; an order key that does not resolve there throws,
 * and one on a one-to-many join silently repeats rows across pages. Both are
 * invisible until a real database runs the statement.
 */

const OPENING_BALANCE = 1000;
const CENTS = 10000;

/** Integer arithmetic, as the client does it: never accumulate floats. */
const toCents = (value: number | string) => Math.round(Number(value) * CENTS);

/** A VOID row records something that did not happen; a split child is not a movement. */
const movesBalance = (row: Transaction) =>
  row.status !== TransactionStatus.VOID && !row.parentTransactionId;

/**
 * What the row contributes, which is the visible split total when a filter
 * returned only some of a split's lines -- the same rule the register draws
 * the Amount column with.
 */
function rowAmountCents(row: Transaction): number {
  const splits = (row as Transaction & { splits?: { amount: number }[] })
    .splits;
  if (row.isSplit && splits && splits.length > 0) {
    const sum = splits.reduce((total, s) => total + toCents(s.amount), 0);
    if (sum !== toCents(row.amount)) return sum;
  }
  return toCents(row.amount);
}

describe("register sorting (integration)", () => {
  // Each case rebuilds the fixture through the service (seven writes, each
  // with its own un-awaited undo-entry chain) and then pages the listing both
  // directions. That is ~2s of real work with no margin against a slow CI
  // runner: issue #1749 timed a passing run out at the default 30000ms on
  // nothing more than ordinary scheduling jitter, the same reason
  // `joint-accounts.integration.spec.ts` and the other suites that repeat a
  // service-level fixture already raise this.
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;
  let otherAccountId: string;
  let alphaCategoryId: string;
  let zuluCategoryId: string;

  type ListOptions = {
    accountIds?: string[];
    startDate?: string;
    endDate?: string;
    categoryIds?: string[];
    payeeIds?: string[];
    page?: number;
    limit?: number;
    targetTransactionId?: string;
    statuses?: TransactionStatus[];
    originalCurrencyCodes?: string[];
    hasAttachments?: boolean;
    tagKeyFilter?: TagKeyFilter;
    sortBy?: TransactionSortField;
    sortDirection?: "ASC" | "DESC";
  };

  const list = (options: ListOptions) =>
    withUserContext(userId, () =>
      service.findAll(
        userId,
        options.accountIds,
        options.startDate,
        options.endDate,
        options.categoryIds,
        options.payeeIds,
        options.page ?? 1,
        options.limit ?? 50,
        false,
        undefined,
        options.targetTransactionId,
        undefined,
        undefined,
        undefined,
        options.statuses,
        options.sortBy ?? "date",
        options.sortDirection ?? "DESC",
        options.tagKeyFilter,
        options.originalCurrencyCodes,
        options.hasAttachments,
      ),
    );

  /** Every page of a listing, in order. */
  async function allPages(options: ListOptions) {
    const limit = options.limit ?? 3;
    const first = await list({ ...options, page: 1, limit });
    const pages = [first];
    for (let page = 2; page <= first.pagination.totalPages; page++) {
      pages.push(await list({ ...options, page, limit }));
    }
    return pages;
  }

  /**
   * The balance the register prints beside every row, over every page: each
   * page seeded with its own `startingBalance` and walked newest-first, which
   * means reversing an oldest-first page before walking it.
   */
  async function balancesByRow(
    options: ListOptions,
  ): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    for (const page of await allPages(options)) {
      expect(page.startingBalance).toBeDefined();
      const seedCents = toCents(page.startingBalance!);
      const newestFirst =
        (options.sortDirection ?? "DESC") === "ASC"
          ? [...page.data].reverse()
          : page.data;
      let cumulative = 0;
      for (const row of newestFirst) {
        balances.set(row.id, (seedCents - cumulative) / CENTS);
        if (movesBalance(row as Transaction)) {
          cumulative += rowAmountCents(row as Transaction);
        }
      }
    }
    return balances;
  }

  /** The listing's rows in the order the register returns them, over every page. */
  async function rowsInOrder(options: ListOptions) {
    const pages = await allPages(options);
    return {
      rows: pages.flatMap((page) => page.data),
      total: pages[0].pagination.total,
      pageIds: pages.map((page) => page.data.map((row) => row.id)),
    };
  }

  /**
   * The same listing both ways round: the ids it holds, and the balance beside
   * each one. This is the assertion the design turns on.
   */
  async function expectBalanceParity(options: ListOptions) {
    const descending = await balancesByRow({
      ...options,
      sortDirection: "DESC",
    });
    const ascending = await balancesByRow({ ...options, sortDirection: "ASC" });

    expect([...ascending.keys()].sort()).toEqual([...descending.keys()].sort());
    expect(descending.size).toBeGreaterThan(0);
    for (const [id, balance] of descending) {
      expect({ id, balance: ascending.get(id) }).toEqual({ id, balance });
    }
    return descending;
  }

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    // "AA" and "ZZ" so an account sort has something to order.
    const account = await createTestAccount(dataSource, userId, {
      name: "AA Chequing",
      openingBalance: OPENING_BALANCE,
      currentBalance: OPENING_BALANCE,
    });
    accountId = account.id;
    const other = await createTestAccount(dataSource, userId, {
      name: "ZZ Savings",
      openingBalance: 0,
      currentBalance: 0,
    });
    otherAccountId = other.id;

    const alpha = await createTestCategory(dataSource, userId, {
      name: "Alpha",
    });
    alphaCategoryId = alpha.id;
    const zulu = await createTestCategory(dataSource, userId, { name: "Zulu" });
    zuluCategoryId = zulu.id;

    // A ledger with every row shape that has ever made a running balance wrong:
    // a VOID row that occupies a line but moves nothing, a split parent whose
    // lines a filter can match in part, a future-dated row the projected
    // balance still counts, and rows with nothing in the columns being sorted
    // by. Written through the service so the rows are the ones it would create.
    await withUserContext(userId, async () => {
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-01",
        amount: -10,
        currencyCode: "USD",
        payeeName: "Anna",
        categoryId: alphaCategoryId,
        description: "aaa",
        referenceNumber: "001",
      } as never);
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-02",
        amount: -20,
        currencyCode: "USD",
        payeeName: "Bob",
        categoryId: zuluCategoryId,
      } as never);
      // Nothing in payee, category, description or reference: the row that
      // proves nulls sink rather than ride the sort.
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-03",
        amount: -30,
        currencyCode: "USD",
      } as never);
      const voided = await service.create(userId, {
        accountId,
        transactionDate: "2026-01-04",
        amount: 40,
        currencyCode: "USD",
        payeeName: "Dave",
      } as never);
      await service.updateStatus(userId, voided.id, TransactionStatus.VOID);
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-05",
        amount: -100,
        currencyCode: "USD",
        payeeName: "Eve",
        isSplit: true,
        splits: [
          { categoryId: alphaCategoryId, amount: -60 },
          { categoryId: zuluCategoryId, amount: -40 },
        ],
      } as never);
      await service.create(userId, {
        accountId,
        transactionDate: "2027-01-01",
        amount: -5,
        currencyCode: "USD",
        payeeName: "Zoe",
        description: "future",
      } as never);
      await service.create(userId, {
        accountId: otherAccountId,
        transactionDate: "2026-01-06",
        amount: -70,
        currencyCode: "USD",
        payeeName: "Anna",
        categoryId: alphaCategoryId,
      } as never);
    });

    // A foreign-currency entry and a brokerage row: the first is what an
    // entry-currency filter narrows to, and the second is a row the register
    // hides from an all-accounts listing, so neither may reach a balance that
    // is supposed to describe what is on screen.
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      accountType: "INVESTMENT",
      accountSubType: "INVESTMENT_BROKERAGE",
      openingBalance: 0,
      currentBalance: 0,
    } as never);
    await dataSource.manager.save(Transaction, [
      dataSource.manager.create(Transaction, {
        userId,
        accountId,
        transactionDate: "2026-03-01",
        amount: -12.5,
        currencyCode: "USD",
        originalAmount: -10,
        originalCurrencyCode: "EUR",
        exchangeRate: 1.25,
        payeeName: "Paris",
        status: TransactionStatus.UNRECONCILED,
      } as never),
      dataSource.manager.create(Transaction, {
        userId,
        accountId: brokerage.id,
        transactionDate: "2026-03-02",
        amount: -999,
        currencyCode: "USD",
        payeeName: "Brokerage cash",
        status: TransactionStatus.UNRECONCILED,
      } as never),
    ]);

    // The pair the clock cannot separate: one save, so PostgreSQL's
    // CURRENT_TIMESTAMP (transaction start time) gives both rows the same
    // created_at, which is what an import does. Credits order before debits
    // chronologically, so neither direction may show the account overdrawn.
    await dataSource.manager.save(Transaction, [
      dataSource.manager.create(Transaction, {
        userId,
        accountId,
        transactionDate: "2026-02-01",
        amount: 2400,
        currencyCode: "USD",
        payeeName: "Transfer in",
        status: TransactionStatus.UNRECONCILED,
      } as never),
      dataSource.manager.create(Transaction, {
        userId,
        accountId,
        transactionDate: "2026-02-01",
        amount: -2400,
        currencyCode: "USD",
        payeeName: "Purchase",
        status: TransactionStatus.UNRECONCILED,
      } as never),
    ]);

    // The fixture above writes through the service, and every write fires an
    // undo entry nobody awaits. Draining them here is what stops a test body
    // starting while those chains still hold pooled connections.
    await settlePendingHistoryWrites();
  });

  describe("a row's balance is the same figure whichever way the register runs", () => {
    it("holds across page boundaries on an unfiltered account", async () => {
      const balances = await expectBalanceParity({
        accountIds: [accountId],
        limit: 3,
      });

      // And the ledger it walks is the real one: the oldest row's balance is
      // the opening balance plus that row. An off-by-one window would leave
      // every figure plausible and every figure wrong.
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        limit: 3,
        sortDirection: "ASC",
      });
      const oldest = rows[0] as Transaction;
      const expected =
        (toCents(OPENING_BALANCE) +
          (movesBalance(oldest) ? rowAmountCents(oldest) : 0)) /
        CENTS;
      expect(balances.get(oldest.id)).toBe(expected);
    });

    it("never shows the account overdrawn on the day a transfer funded it", async () => {
      // Both rows share a created_at, so only the amount tiebreak separates
      // them -- and it has to run opposite to the list for the credit to stay
      // chronologically first in both directions.
      const balances = await expectBalanceParity({
        accountIds: [accountId],
        limit: 2,
      });
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        limit: 50,
      });
      const pair = (rows as Transaction[]).filter(
        (row) => row.transactionDate === "2026-02-01",
      );
      expect(pair).toHaveLength(2);
      const credit = pair.find((row) => Number(row.amount) > 0)!;
      const debit = pair.find((row) => Number(row.amount) < 0)!;
      expect(balances.get(credit.id)! - 2400).toBe(balances.get(debit.id));
    });

    it("holds under a date filter", async () => {
      await expectBalanceParity({
        accountIds: [accountId],
        endDate: "2026-01-31",
        limit: 2,
      });
    });

    it("holds under a content filter, where the balance is zero-based", async () => {
      const balances = await expectBalanceParity({
        accountIds: [accountId],
        categoryIds: [zuluCategoryId],
        limit: 2,
      });
      // A zero-based balance starts from the matched total, so the newest
      // matching row carries it.
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        categoryIds: [zuluCategoryId],
        limit: 50,
      });
      const matchedTotal =
        (rows as Transaction[]).reduce(
          (total, row) => total + (movesBalance(row) ? rowAmountCents(row) : 0),
          0,
        ) / CENTS;
      expect(balances.get((rows[0] as Transaction).id)).toBe(matchedTotal);
    });

    it("holds across two accounts whose split lines a category filter matches in part", async () => {
      // The split parent is -100 with one -60 line in Alpha: the page shows
      // the partial total and the window must sum the same partial total, or
      // the two directions disagree by 40.
      await expectBalanceParity({
        accountIds: [accountId, otherAccountId],
        categoryIds: [alphaCategoryId],
        limit: 2,
      });
    });
  });

  describe("the balance counts exactly the rows the register shows", () => {
    /**
     * A running balance is a figure ABOUT the rows on screen, so its total has
     * to be summed over the rows on screen. Four filters narrowed the listing
     * without reaching the balance, which fell through to the unfiltered
     * regime: the account's whole projected balance, walked down past rows
     * that are not the ones being shown.
     */
    async function expectSeedMatchesShownRows(options: ListOptions) {
      const { rows } = await rowsInOrder({ ...options, limit: 50 });
      expect(rows.length).toBeGreaterThan(0);
      const shown =
        (rows as Transaction[]).reduce(
          (total, row) => total + (movesBalance(row) ? rowAmountCents(row) : 0),
          0,
        ) / CENTS;
      const page = await list({ ...options, page: 1, limit: 50 });
      expect(page.startingBalance).toBeDefined();
      expect(page.startingBalance).toBeCloseTo(shown, 4);
    }

    it("under a status filter, which the register narrows by", async () => {
      // The account also holds a VOID row and rows of other statuses, so the
      // unfiltered balance is a different number from this one.
      await expectSeedMatchesShownRows({
        accountIds: [accountId],
        statuses: [TransactionStatus.UNRECONCILED],
      });
    });

    it("under an entry-currency filter", async () => {
      await expectSeedMatchesShownRows({
        accountIds: [accountId],
        originalCurrencyCodes: ["EUR"],
      });
    });

    it("across every account, where the register hides brokerage rows", async () => {
      // The brokerage row is not on screen, so it is not in the total either.
      // Without the exclusion the balance counts a row the reader cannot see.
      await expectSeedMatchesShownRows({
        statuses: [TransactionStatus.UNRECONCILED],
      });
    });

    it("under the attachment and tag-key filters, whose SQL runs nowhere else", async () => {
      // Neither narrows this fixture -- no row carries an attachment or a
      // KEY:VALUE tag -- so the figures are the unfiltered ones. What is being
      // proved is that the clauses RUN: they are raw SQL naming their own
      // aliases inside a subquery, and a mistake there is a PostgreSQL error
      // at the far end of a user's filter, invisible to every mock.
      await expectSeedMatchesShownRows({
        accountIds: [accountId],
        hasAttachments: false,
      });
      await expectSeedMatchesShownRows({
        accountIds: [accountId],
        tagKeyFilter: { key: "country", op: "noValue" },
      });
    });

    it("under the uncategorised pseudo-category, which matches through splits", async () => {
      // The listing matches a split parent whose child has no category; the
      // balance's own row set did not, so it summed fewer rows than the
      // register listed. That was a short total while the register only ever
      // ran newest-first. It is worse now: the same set is what the
      // oldest-first page window offsets into, while the page boundaries come
      // from the listing's total -- so the two directions stop naming
      // complementary halves and one row reads two different balances.
      await withUserContext(userId, async () => {
        await service.create(userId, {
          accountId,
          transactionDate: "2026-01-07",
          amount: -50,
          currencyCode: "USD",
          payeeName: "Frank",
          isSplit: true,
          splits: [
            { categoryId: alphaCategoryId, amount: -20 },
            { categoryId: null, amount: -30 },
          ],
        } as never);
      });

      // The register shows that parent with only its uncategorised line
      // hydrated, so the balance beside it counts -30, not the whole -50.
      await expectSeedMatchesShownRows({
        accountIds: [accountId],
        categoryIds: ["uncategorized"],
      });
      // Page size 2 puts the parent and the boundary in different places in
      // the two directions, which is what the defect needed to show itself.
      await expectBalanceParity({
        accountIds: [accountId],
        categoryIds: ["uncategorized"],
        limit: 2,
      });
      // The pseudo-categories are alternatives to each other, so combining
      // them must widen the set rather than intersect it.
      await expectBalanceParity({
        accountIds: [accountId],
        categoryIds: ["uncategorized", "transfer"],
        limit: 2,
      });
      await expectBalanceParity({
        accountIds: [accountId],
        categoryIds: ["uncategorized", alphaCategoryId],
        limit: 2,
      });
    });

    it("and the parity across directions survives those filters", async () => {
      await expectBalanceParity({
        accountIds: [accountId],
        statuses: [TransactionStatus.UNRECONCILED],
        limit: 2,
      });
    });
  });

  describe("every sortable column can be paged by", () => {
    it.each(TRANSACTION_SORT_FIELDS)(
      "pages %s without losing, repeating or reordering a row",
      async (field) => {
        for (const sortDirection of ["ASC", "DESC"] as const) {
          const { rows, total, pageIds } = await rowsInOrder({
            accountIds: [accountId, otherAccountId],
            sortBy: field,
            sortDirection,
            limit: 2,
          });
          const ids = pageIds.flat();
          // Disjoint pages covering the whole listing: a one-to-many order key
          // would repeat rows here, and an order column missing from the
          // DISTINCT subquery would drop them.
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBe(total);
          expect(rows.length).toBe(total);
        }
      },
    );

    it("sinks the rows with nothing in the sorted column, in both directions", async () => {
      for (const field of [
        "payee",
        "category",
        "description",
        "refNumber",
      ] as const) {
        for (const sortDirection of ["ASC", "DESC"] as const) {
          const { rows } = await rowsInOrder({
            accountIds: [accountId],
            sortBy: field,
            sortDirection,
            limit: 50,
          });
          const isBlank = (row: Transaction) => {
            if (field === "payee") return row.payeeName == null;
            if (field === "category") return row.categoryId == null;
            if (field === "description") return row.description == null;
            return row.referenceNumber == null;
          };
          const blankPositions = (rows as Transaction[])
            .map((row, index) => (isBlank(row) ? index : -1))
            .filter((index) => index >= 0);
          const firstBlank = Math.min(...blankPositions);
          expect(blankPositions.length).toBeGreaterThan(0);
          // Every blank sits after every non-blank: reversing the sort must
          // not fill the top of the register with rows that say nothing about
          // the column being sorted by.
          expect(firstBlank).toBe(rows.length - blankPositions.length);
        }
      }
    });

    it("reads chronologically within one payee", async () => {
      // Without the date as the second key these come out in insertion order,
      // because a whole import shares one created_at.
      const { rows } = await rowsInOrder({
        accountIds: [accountId, otherAccountId],
        sortBy: "payee",
        sortDirection: "ASC",
        limit: 50,
      });
      const anna = (rows as Transaction[]).filter(
        (row) => row.payeeName === "Anna",
      );
      expect(anna).toHaveLength(2);
      expect(anna[0].transactionDate < anna[1].transactionDate).toBe(true);
    });
  });

  describe("the balance under a sort other than date", () => {
    it("is withheld, and the response says why", async () => {
      const result = await list({
        accountIds: [accountId],
        sortBy: "amount",
        sortDirection: "DESC",
      });
      expect(result.startingBalance).toBeUndefined();
      expect(result.startingBalanceWithheld).toBe("sort");
    });

    it("says nothing where the register never had a balance", async () => {
      const result = await list({ sortBy: "payee", sortDirection: "ASC" });
      expect(result.startingBalance).toBeUndefined();
      expect(result.startingBalanceWithheld).toBeUndefined();
    });

    it("comes back the moment the register is date-ordered again", async () => {
      const result = await list({
        accountIds: [accountId],
        sortBy: "date",
        sortDirection: "ASC",
      });
      expect(result.startingBalance).toBeDefined();
      expect(result.startingBalanceWithheld).toBeUndefined();
    });
  });

  describe("a deep-linked row", () => {
    it("lands on the page it is actually on, every row, both ways", async () => {
      // The page number is counted by comparing the target with the
      // register's order, so it is only right while that comparison IS the
      // register's order -- all four keys, including the amount leg that
      // separates a credit from a debit the clock cannot. Checking every row
      // rather than one is what catches the pair that shares a created_at.
      const limit = 2;
      for (const sortDirection of ["DESC", "ASC"] as const) {
        const { rows } = await rowsInOrder({
          accountIds: [accountId],
          limit: 50,
          sortDirection,
        });

        for (const [index, row] of (rows as Transaction[]).entries()) {
          const page = await list({
            accountIds: [accountId],
            limit,
            sortDirection,
            targetTransactionId: row.id,
          });
          const expected = Math.floor(index / limit) + 1;
          expect({
            id: row.id,
            direction: sortDirection,
            page: page.pagination.page,
            holdsTheRow: page.data.some((listed) => listed.id === row.id),
          }).toEqual({
            id: row.id,
            direction: sortDirection,
            page: expected,
            holdsTheRow: true,
          });
        }
      }
    });

    it("is refused under a sort that cannot place it", async () => {
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        limit: 50,
      });
      await expect(
        list({
          accountIds: [accountId],
          sortBy: "payee",
          targetTransactionId: (rows[0] as Transaction).id,
        }),
      ).rejects.toThrow();
    });
  });
});
