import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { todayInTimezone } from "@/common/date-utils";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";
import { createBarrier, pauseBefore, raceTwo } from "../helpers/race";

/**
 * One scheduled occurrence has at most one financial effect, however many
 * replicas run the auto-post cron (INV-OCCURRENCE-001, INV-CRON-001; audit
 * A26-M42 / A26-S08-05). This suite drives the real
 * `ScheduledTransactionsService.processAutoPostTransactions()` and the real
 * `post()` behind it, twice concurrently, against real PostgreSQL.
 *
 * Mechanism -- four layers, each a backstop for the others:
 *   1. the pin: the cron passes `expectedDueDate` (the occurrence it selected)
 *      and `post()` refuses before any work when the schedule's re-read
 *      `next_due_date` is no longer that date -- and again under the lock;
 *   2. the row lock: `pessimistic_write` on the schedule row serializes the
 *      two posts;
 *   3. the CAS: under that lock `next_due_date` is compared with the value read
 *      before it, so a post that waited finds the cursor moved;
 *   4. the claim key: `INSERT INTO scheduled_transaction_postings ... ON
 *      CONFLICT (scheduled_transaction_id, original_due_date) DO NOTHING`
 *      returns no row for the second claimant of the same occurrence.
 * The money write and the cursor advance share the claim's transaction.
 *
 * Interleaving: the schedule is two occurrences behind, so a replica that
 * wrongly re-reads the cursor has a second occurrence to post. Both ticks
 * SELECT the schedule, then `pauseBefore` on `post` holds each at a two-party
 * barrier, so neither posts until both have selected. (`post` is called as
 * `this.post(...)`, so a spy on the instance property intercepts it.)
 *   - P1 releases both at once: they race to the row lock; the loser is
 *     refused by the CAS or the claim key.
 *   - P1b releases both, then holds the second until the first has committed.
 *     The second's selection is stale for its whole run, and only the pin
 *     (layer 1) -- with the CAS and claim key keyed on the re-read, newer
 *     cursor -- stands between it and the next occurrence.
 *
 * Mutations demonstrated against this file (each applied by hand, then reverted):
 *   - M1, dropping `expectedDueDate` from the cron's `post()` options: P1b goes
 *     red (the stale replica posts the next occurrence, 2 ledger rows); P1 stays
 *     green because both replicas still read the same cursor and the CAS decides.
 *   - M2+M3, disabling the under-lock CAS and proceeding on an empty claim
 *     `RETURNING`: P1 goes red (the loser, queued on the row lock, re-posts the
 *     claimed occurrence, 2 ledger rows); P1b stays green because the pin alone
 *     refuses the stale replica. Each case therefore guards a different layer.
 */
describe("Scheduled posting under two cron replicas (integration)", () => {
  const AMOUNT = -42.5;
  const OPENING = 1000;

  let module: TestingModule;
  let service: ScheduledTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;
  let scheduledId: string;
  let firstDue: string;
  let secondDue: string;
  let thirdDue: string;
  let spy: jest.SpyInstance | undefined;

  /** First day of the month `back` months before the month of `today`. */
  function firstOfMonthBefore(today: string, back: number): string {
    const [y, m] = today.split("-").map(Number);
    const index = y * 12 + (m - 1) - back;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${year}-${String(month).padStart(2, "0")}-01`;
  }

  beforeAll(async () => {
    module = await createIntegrationModule([
      AccountsModule,
      TransactionsModule,
      ScheduledTransactionsModule,
    ]);
    service = module.get(ScheduledTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "scheduled_transaction_postings",
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );

    // No preference row: the cron buckets the user as UTC, and so does this.
    const today = todayInTimezone("UTC")!;
    firstDue = firstOfMonthBefore(today, 2);
    secondDue = firstOfMonthBefore(today, 1);
    thirdDue = firstOfMonthBefore(today, 0);

    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    const account = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: OPENING,
      currentBalance: OPENING,
    });
    accountId = account.id;

    const scheduled = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId,
        accountId,
        name: "Gym",
        amount: AMOUNT,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: firstDue,
        startDate: "2020-01-01",
        isActive: true,
        autoPost: true,
      } as Partial<ScheduledTransaction>),
    );
    scheduledId = scheduled.id;
  });

  async function readState() {
    const [{ c: transactions }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    const postings: { original_due_date: string; transaction_id: string }[] =
      await dataSource.query(
        `SELECT TO_CHAR(original_due_date, 'YYYY-MM-DD') AS original_due_date,
                transaction_id
           FROM scheduled_transaction_postings
          WHERE scheduled_transaction_id = $1
          ORDER BY original_due_date`,
        [scheduledId],
      );
    const [{ next_due_date: nextDueDate }]: { next_due_date: string }[] =
      await dataSource.query(
        `SELECT TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date
           FROM scheduled_transactions WHERE id = $1`,
        [scheduledId],
      );
    const [{ current_balance: balance }]: { current_balance: string }[] =
      await dataSource.query(
        `SELECT current_balance FROM accounts WHERE id = $1`,
        [accountId],
      );
    return {
      transactions,
      postings: postings.map((p) => p.original_due_date),
      nextDueDate,
      balance: Number(balance),
    };
  }

  function expectOneEffect(state: Awaited<ReturnType<typeof readState>>) {
    // Exactly the first occurrence, once: one ledger row, one claim, the cursor
    // one month on, and the balance moved by one amount.
    expect(state.transactions).toBe(1);
    expect(state.postings).toEqual([firstDue]);
    expect(state.nextDueDate).toBe(secondDue);
    expect(state.balance).toBe(OPENING + AMOUNT);
    // The cron posts one occurrence per tick; the third is not touched.
    expect(state.nextDueDate).not.toBe(thirdDue);
  }

  it("P1: two replicas, one tick, post the occurrence once", async () => {
    const barrier = createBarrier(2);
    spy = pauseBefore(service, "post", barrier);

    const outcome = await raceTwo(
      dataSource,
      () => service.processAutoPostTransactions(),
      () => service.processAutoPostTransactions(),
      { barrier },
    );

    // The loser counts a skip; it is not a failure of the tick.
    expect(outcome.reasons).toEqual([]);
    expect(outcome.fulfilled).toBe(2);
    // Both replicas selected the schedule and reached post().
    expect(barrier.arrived).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);

    expectOneEffect(await readState());
  });

  it("P1b: a replica that selected before the winner committed posts nothing", async () => {
    const barrier = createBarrier(2);
    const original = service.post.bind(service);
    let calls = 0;
    let winnerDone!: () => void;
    const winnerCommitted = new Promise<void>((resolve) => {
      winnerDone = resolve;
    });
    spy = jest.spyOn(service, "post").mockImplementation((async (
      ...args: Parameters<ScheduledTransactionsService["post"]>
    ) => {
      const isWinner = calls === 0;
      calls += 1;
      // Both ticks have selected before either posts.
      await barrier.arrive();
      if (isWinner) {
        try {
          return await original(...args);
        } finally {
          winnerDone();
        }
      }
      // The second replica starts only after the first has committed, holding
      // a selection that is now one occurrence stale.
      await winnerCommitted;
      return original(...args);
    }) as never);

    const outcome = await raceTwo(
      dataSource,
      () => service.processAutoPostTransactions(),
      () => service.processAutoPostTransactions(),
      { barrier },
    );

    expect(outcome.reasons).toEqual([]);
    expect(outcome.fulfilled).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);

    expectOneEffect(await readState());
  });
});
