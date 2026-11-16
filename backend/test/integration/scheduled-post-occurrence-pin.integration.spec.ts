import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayInTimezone } from "@/common/date-utils";
import { PostScheduledTransactionDto } from "@/scheduled-transactions/dto/post-scheduled-transaction.dto";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "@/scheduled-transactions/entities/scheduled-transaction-override.entity";
import type { OccurrencePin } from "@/scheduled-transactions/occurrence-pin";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";
import { createBarrier, pauseBefore, raceTwo } from "../helpers/race";

/**
 * A manual Post or Skip acts on the occurrence the person was looking at, not on
 * whatever the schedule's cursor has become since (INV-OCCURRENCE-001; audit
 * A26-S08-01 / A26-H07, and A26-S08-03 / A26-M15 for the claimed-ahead cursor).
 *
 * Without a pin, a stale browser tab posts the NEXT occurrence early under the
 * previous one's date (P2), posts an extra payment on a schedule the cron already
 * exhausted (P7) and skips the next occurrence with its override (P3). The pin
 * is `{ occurrenceDate, overrideId }`: the date the person sees (the override's
 * date, else the cursor) and the id of the override that moved it. The server
 * refuses with 409 inside the locked transaction, before any write.
 *
 * Cases (a) to (d) are the refusals, (e) the pin that matches, (f) the race of
 * the cron with a manual post and (g) the cursor that must step past a slot a
 * settlement rule claimed ahead of it (A26-S08-03, P4).
 */
describe("Manual post and skip are pinned to an occurrence (integration)", () => {
  const AMOUNT = -42.5;
  const OPENING = 1000;

  let module: TestingModule;
  let service: ScheduledTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;
  let bankAccountId: string;
  let scheduledId: string;
  let firstDue: string;
  let secondDue: string;
  let thirdDue: string;
  let spy: jest.SpyInstance | undefined;

  // The pinned signatures `post()` and `skip()` take; typed here so the spec
  // reads as the fixed code is called.
  const postPinned = (
    id: string,
    dto: Partial<PostScheduledTransactionDto>,
    pin: OccurrencePin,
  ) =>
    withUserContext(userId, () =>
      (
        service.post.bind(service) as (
          userId: string,
          id: string,
          dto: PostScheduledTransactionDto,
          options: { occurrencePin: OccurrencePin },
        ) => Promise<ScheduledTransaction | null>
      )(userId, id, dto as PostScheduledTransactionDto, {
        occurrencePin: pin,
      }),
    );
  const skipPinned = (id: string, pin: OccurrencePin) =>
    withUserContext(userId, () =>
      (
        service.skip.bind(service) as (
          userId: string,
          id: string,
          pin?: OccurrencePin,
        ) => Promise<ScheduledTransaction>
      )(userId, id, pin),
    );

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
    accountId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        openingBalance: OPENING,
        currentBalance: OPENING,
      })
    ).id;
    // Where a settlement rule's bank row lands, so the chequing ledger holds
    // only what the schedule posted.
    bankAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "Bank feed",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    scheduledId = await makeSchedule({});
  });

  async function makeSchedule(
    overrides: Partial<ScheduledTransaction>,
  ): Promise<string> {
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
        ...overrides,
      } as Partial<ScheduledTransaction>),
    );
    return scheduled.id;
  }

  async function createOverride(
    originalDate: string,
    overrideDate: string,
  ): Promise<string> {
    const row = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionOverride, {
        scheduledTransactionId: scheduledId,
        originalDate,
        overrideDate,
        amount: -10,
      } as Partial<ScheduledTransactionOverride>),
    );
    return row.id;
  }

  /** A settlement rule's claim on `slot`, backed by a bank row as the rule writes it. */
  async function insertRuleClaim(slot: string): Promise<void> {
    const [{ id: bankRow }]: { id: string }[] = await dataSource.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code)
       VALUES ($1, $2, $3, $4, 'USD')
       RETURNING id`,
      [userId, bankAccountId, slot, AMOUNT],
    );
    await dataSource.query(
      `INSERT INTO scheduled_transaction_postings
         (scheduled_transaction_id, original_due_date, posted_date,
          transaction_id, source)
       VALUES ($1, $2, $2, $3, 'rule')`,
      [scheduledId, slot, bankRow],
    );
  }

  async function readState() {
    const [{ c: transactions }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    const postings: { original_due_date: string }[] = await dataSource.query(
      `SELECT TO_CHAR(original_due_date, 'YYYY-MM-DD') AS original_due_date
         FROM scheduled_transaction_postings
        WHERE scheduled_transaction_id = $1
        ORDER BY original_due_date`,
      [scheduledId],
    );
    const [{ next_due_date: nextDueDate, is_active: isActive }]: {
      next_due_date: string;
      is_active: boolean;
    }[] = await dataSource.query(
      `SELECT TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date, is_active
         FROM scheduled_transactions WHERE id = $1`,
      [scheduledId],
    );
    const [{ current_balance: balance }]: { current_balance: string }[] =
      await dataSource.query(
        `SELECT current_balance FROM accounts WHERE id = $1`,
        [accountId],
      );
    const [{ c: overrides }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM scheduled_transaction_overrides
        WHERE scheduled_transaction_id = $1`,
      [scheduledId],
    );
    return {
      transactions,
      postings: postings.map((p) => p.original_due_date),
      nextDueDate,
      isActive,
      balance: Number(balance),
      overrides,
    };
  }

  function expectOneEffect(state: Awaited<ReturnType<typeof readState>>) {
    expect(state.transactions).toBe(1);
    expect(state.postings).toEqual([firstDue]);
    expect(state.nextDueDate).toBe(secondDue);
    expect(state.balance).toBe(OPENING + AMOUNT);
  }

  it("P2 (A26-S08-01): refuses a manual post of the occurrence the cron already posted", async () => {
    await service.processAutoPostTransactions();

    await expect(
      postPinned(
        scheduledId,
        { transactionDate: firstDue },
        { occurrenceDate: firstDue, overrideId: null },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    // Not the next occurrence, early, under September's date.
    expectOneEffect(await readState());
  });

  it("P3 (A26-S08-01): refuses a stale skip and keeps the next occurrence's override", async () => {
    await service.processAutoPostTransactions();
    await createOverride(secondDue, secondDue);

    await expect(
      skipPinned(scheduledId, { occurrenceDate: firstDue, overrideId: null }),
    ).rejects.toBeInstanceOf(ConflictException);

    const state = await readState();
    expect(state.nextDueDate).toBe(secondDue);
    expect(state.overrides).toBe(1);
    expectOneEffect(state);
  });

  it("P7 (A26-S08-01): refuses a manual post on a schedule the cron exhausted", async () => {
    await dataSource.query(
      `UPDATE scheduled_transactions SET occurrences_remaining = 1 WHERE id = $1`,
      [scheduledId],
    );
    await service.processAutoPostTransactions();
    const afterCron = await readState();
    expectOneEffect(afterCron);
    expect(afterCron.isActive).toBe(false);

    // The stale tab: the slot the cron posted.
    await expect(
      postPinned(
        scheduledId,
        { transactionDate: firstDue },
        { occurrenceDate: firstDue, overrideId: null },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // A fresh tab pinned to the new cursor: nothing is left to post.
    await expect(
      postPinned(
        scheduledId,
        { transactionDate: secondDue },
        { occurrenceDate: secondDue, overrideId: null },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      skipPinned(scheduledId, { occurrenceDate: secondDue, overrideId: null }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await readState()).toEqual(afterCron);
  });

  it("A26-S08-01: an override created after the client read is a mismatch", async () => {
    await dataSource.query(
      `UPDATE scheduled_transactions SET next_due_date = $2 WHERE id = $1`,
      [scheduledId, secondDue],
    );
    // The stale view saw {secondDue, null}. The override keeps the date but is
    // a new identity (it may carry another amount), so the view is out of date.
    await createOverride(secondDue, secondDue);

    await expect(
      postPinned(
        scheduledId,
        { transactionDate: secondDue },
        { occurrenceDate: secondDue, overrideId: null },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      skipPinned(scheduledId, { occurrenceDate: secondDue, overrideId: null }),
    ).rejects.toBeInstanceOf(ConflictException);

    const state = await readState();
    expect(state.transactions).toBe(0);
    expect(state.postings).toEqual([]);
    expect(state.nextDueDate).toBe(secondDue);
    expect(state.overrides).toBe(1);
    expect(state.balance).toBe(OPENING);
  });

  describe("a pin that matches the occurrence on screen", () => {
    it("posts a not-yet-due occurrence early", async () => {
      const future = addDaysYMD(todayInTimezone("UTC")!, 10);
      await dataSource.query(
        `UPDATE scheduled_transactions
            SET next_due_date = $2, auto_post = false WHERE id = $1`,
        [scheduledId, future],
      );

      await postPinned(
        scheduledId,
        { transactionDate: future },
        { occurrenceDate: future, overrideId: null },
      );

      const state = await readState();
      expect(state.transactions).toBe(1);
      expect(state.postings).toEqual([future]);
      // The cursor moved on; a future-dated row has not moved the balance yet.
      expect(state.nextDueDate > future).toBe(true);
    });

    it("posts an occurrence whose override moved the date, pinned to the override", async () => {
      const moved = addDaysYMD(firstDue, 3);
      const overrideId = await createOverride(firstDue, moved);

      await postPinned(scheduledId, {}, { occurrenceDate: moved, overrideId });

      const state = await readState();
      expect(state.postings).toEqual([firstDue]);
      expect(state.nextDueDate).toBe(secondDue);
      expect(state.overrides).toBe(0);
      expect(state.balance).toBe(OPENING - 10);
    });

    it("skips one month and leaves the ledger alone", async () => {
      await skipPinned(scheduledId, {
        occurrenceDate: firstDue,
        overrideId: null,
      });

      const state = await readState();
      expect(state.nextDueDate).toBe(secondDue);
      expect(state.transactions).toBe(0);
      expect(state.postings).toEqual([]);
      expect(state.balance).toBe(OPENING);
    });
  });

  it("f: the cron tick and a pinned manual post of the same occurrence have one effect", async () => {
    const barrier = createBarrier(2);
    spy = pauseBefore(service, "post", barrier);

    const outcome = await raceTwo(
      dataSource,
      () => service.processAutoPostTransactions(),
      () =>
        postPinned(
          scheduledId,
          { transactionDate: firstDue },
          { occurrenceDate: firstDue, overrideId: null },
        ),
      { barrier },
    );

    // The cron counts a skip for its own loss; the manual loser is refused.
    expect(barrier.arrived).toBe(2);
    expect(outcome.fulfilled).toBeGreaterThanOrEqual(1);
    for (const reason of outcome.reasons) {
      expect(reason).toBeInstanceOf(ConflictException);
    }
    expectOneEffect(await readState());
  });

  describe("A26-S08-03 (P4): the cursor steps past a slot a settlement rule claimed ahead", () => {
    it("on a cron post", async () => {
      await insertRuleClaim(secondDue);

      await service.processAutoPostTransactions();

      const state = await readState();
      expect(state.postings).toEqual([firstDue, secondDue]);
      expect(state.nextDueDate).toBe(thirdDue);
      expect(state.transactions).toBe(1);
      expect(state.balance).toBe(OPENING + AMOUNT);
    });

    it("on a manual pinned post", async () => {
      await insertRuleClaim(secondDue);

      await postPinned(
        scheduledId,
        { transactionDate: firstDue },
        { occurrenceDate: firstDue, overrideId: null },
      );

      const state = await readState();
      expect(state.postings).toEqual([firstDue, secondDue]);
      expect(state.nextDueDate).toBe(thirdDue);
      expect(state.balance).toBe(OPENING + AMOUNT);

      // The next post is not refused as "already posted" for ever.
      await postPinned(
        scheduledId,
        { transactionDate: thirdDue },
        { occurrenceDate: thirdDue, overrideId: null },
      );
      expect((await readState()).postings).toEqual([
        firstDue,
        secondDue,
        thirdDue,
      ]);
    });

    it("on a skip", async () => {
      await insertRuleClaim(secondDue);

      await skipPinned(scheduledId, {
        occurrenceDate: firstDue,
        overrideId: null,
      });

      const state = await readState();
      // The skip writes no claim; the rule's claim stands and is stepped over.
      expect(state.postings).toEqual([secondDue]);
      expect(state.nextDueDate).toBe(thirdDue);
      expect(state.balance).toBe(OPENING);
    });
  });
});
