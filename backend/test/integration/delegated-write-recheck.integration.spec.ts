import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionTransferService } from "@/transactions/transaction-transfer.service";
import { JointRegisterService } from "@/transactions/joint-register.service";
import { DelegationService } from "@/delegation/delegation.service";
import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A26-M04 (A26-S04-01) and A26-M05 (A26-S04-02), under the unprivileged role
 * with RLS enforced.
 *
 * A grantee's write was authorized in the grantee's identity and written in a
 * later system-bypass transaction with no re-check, so a revoke that committed
 * between the two let the write land in the owner's ledger: Bob's 700.00
 * transfer into Alice's chequing after Alice revoked him moved her balance
 * from 5,000.00 to 5,700.00. A delegation setter read the entity in one
 * transaction and `save`d it in another, so a revoke in between was undone:
 * the delegation came back `active`.
 *
 * Each case commits the owner's change on its own connection in the gap
 * between the grantee's authorization and the write (a spy on the
 * collaborator the write starts with), then asserts nothing was written.
 */
describe("Delegated writes re-check authority inside the write (integration)", () => {
  jest.setTimeout(60000);

  let harness: EnforcedIntegrationHarness;
  let owner: DataSource;
  let transactions: TransactionsService;
  let transfers: TransactionTransferService;
  let jointRegister: JointRegisterService;
  let delegation: DelegationService;

  let aliceId: string;
  let bobId: string;
  let aliceChequingId: string;
  let aliceOtherId: string;
  let bobSavingsId: string;
  let delegationId: string;

  const spies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([TransactionsModule]);
    owner = harness.owner;
    transactions = harness.module.get(TransactionsService);
    transfers = harness.module.get(TransactionTransferService);
    jointRegister = harness.module.get(JointRegisterService);
    delegation = harness.module.get(DelegationService);
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  beforeEach(async () => {
    await cleanTables(owner, [
      "action_history",
      "transaction_splits",
      "transactions",
      "account_delegate_grants",
      "account_delegates",
      "accounts",
      "monthly_account_balances",
      "users",
    ]);
    aliceId = (await createTestUserDirect(owner)).id;
    bobId = (await createTestUserDirect(owner)).id;
    aliceChequingId = (
      await createTestAccount(owner, aliceId, {
        name: "A chequing",
        openingBalance: 5000,
        currentBalance: 5000,
      })
    ).id;
    aliceOtherId = (
      await createTestAccount(owner, aliceId, {
        name: "A private",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    bobSavingsId = (
      await createTestAccount(owner, bobId, {
        name: "B savings",
        openingBalance: 2000,
        currentBalance: 2000,
      })
    ).id;
    const [row] = await owner.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [aliceId, bobId],
    );
    delegationId = row.id;
    await owner.query(
      `INSERT INTO account_delegate_grants
         (delegation_id, account_id, can_read, can_create, can_edit, can_delete, is_joint)
       VALUES ($1, $2, true, true, true, true, true)`,
      [delegationId, aliceChequingId],
    );
  });

  /** Alice revokes Bob: a hard delete, the grants cascading, as revoke does. */
  async function revoke(): Promise<void> {
    await owner.query(`DELETE FROM account_delegates WHERE id = $1`, [
      delegationId,
    ]);
  }

  /** Run `change` (committed, on the owner connection) before `method` runs. */
  function changeBefore<T extends object>(
    object: T,
    method: string,
    change: () => Promise<void>,
  ): void {
    const original = (
      object as Record<string, (...args: unknown[]) => unknown>
    )[method].bind(object);
    const spy = jest.spyOn(object, method as never);
    spies.push(spy);
    spy.mockImplementationOnce((async (...args: unknown[]) => {
      await change();
      return original(...args);
    }) as never);
  }

  async function balanceOf(accountId: string): Promise<number> {
    const [row] = await owner.query(
      `SELECT current_balance::float8 AS b FROM accounts WHERE id = $1`,
      [accountId],
    );
    return Number(row.b);
  }

  async function rowsIn(accountId: string): Promise<number> {
    const [row] = await owner.query(
      `SELECT count(*)::int AS n FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    return row.n;
  }

  it("a cross-owner transfer revoked between authorization and write writes nothing", async () => {
    changeBefore(transfers, "writeTransferLegs", revoke);

    await expect(
      withUserContext(bobId, () =>
        transactions.createTransfer(
          bobId,
          {
            fromAccountId: bobSavingsId,
            toAccountId: aliceChequingId,
            transactionDate: "2026-01-15",
            amount: 700,
            fromCurrencyCode: "USD",
          },
          { effectiveUserId: bobId, realUserId: bobId },
        ),
      ),
    ).rejects.toThrow(/not found/i);

    expect(await rowsIn(aliceChequingId)).toBe(0);
    expect(await rowsIn(bobSavingsId)).toBe(0);
    expect(await balanceOf(aliceChequingId)).toBe(5000);
    expect(await balanceOf(bobSavingsId)).toBe(2000);
  });

  /** Run `change` (committed, on the owner connection) after `method` answers. */
  function changeAfter<T extends object>(
    object: T,
    method: string,
    change: () => Promise<void>,
  ): void {
    const original = (
      object as Record<string, (...args: unknown[]) => unknown>
    )[method].bind(object);
    const spy = jest.spyOn(object, method as never);
    spies.push(spy);
    spy.mockImplementationOnce((async (...args: unknown[]) => {
      const result = await original(...args);
      await change();
      return result;
    }) as never);
  }

  describe("connected cross-owner transfer", () => {
    let bobLegId: string;
    const actor = () => ({ effectiveUserId: bobId, realUserId: bobId });

    beforeEach(async () => {
      const { fromTransaction } = await withUserContext(bobId, () =>
        transactions.createTransfer(
          bobId,
          {
            fromAccountId: bobSavingsId,
            toAccountId: aliceChequingId,
            transactionDate: "2026-01-15",
            amount: 500,
            fromCurrencyCode: "USD",
          },
          actor(),
        ),
      );
      bobLegId = fromTransaction.id;
      expect(await balanceOf(aliceChequingId)).toBe(5500);
    });

    it("an edit revoked after its access check writes nothing", async () => {
      changeAfter(transfers, "resolveCounterpartAccess", revoke);

      await expect(
        withUserContext(bobId, () =>
          transactions.updateTransfer(
            bobId,
            bobLegId,
            { amount: 600 },
            actor(),
          ),
        ),
      ).rejects.toThrow(/not found/i);
      expect(await balanceOf(aliceChequingId)).toBe(5500);
      expect(await balanceOf(bobSavingsId)).toBe(1500);
    });

    it("a delete revoked after its access check removes nothing", async () => {
      changeAfter(transfers, "resolveCounterpartAccess", revoke);

      await expect(
        withUserContext(bobId, () =>
          transactions.removeTransfer(bobId, bobLegId, actor()),
        ),
      ).rejects.toThrow(/not found/i);
      expect(await rowsIn(aliceChequingId)).toBe(1);
      expect(await balanceOf(aliceChequingId)).toBe(5500);
    });
  });

  describe("joint register", () => {
    let rowId: string;

    beforeEach(async () => {
      const [row] = await owner.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                   currency_code, description, status)
         VALUES ($1, $2, '2026-01-15', -25, 'USD', 'coffee', 'UNRECONCILED')
         RETURNING id`,
        [aliceId, aliceChequingId],
      );
      rowId = row.id;
      await owner.query(
        `UPDATE accounts SET current_balance = current_balance - 25 WHERE id = $1`,
        [aliceChequingId],
      );
    });

    async function description(): Promise<string> {
      const [row] = await owner.query(
        `SELECT description FROM transactions WHERE id = $1`,
        [rowId],
      );
      return row.description;
    }

    it("an edit after the owner moved the row out of the joint account writes nothing", async () => {
      changeBefore(transactions, "update", async () => {
        await owner.query(
          `UPDATE transactions SET account_id = $2 WHERE id = $1`,
          [rowId, aliceOtherId],
        );
      });

      await expect(
        withUserContext(bobId, () =>
          jointRegister.update(bobId, rowId, {
            description: "edited by Bob",
          } as never),
        ),
      ).rejects.toThrow(/not found/i);
      expect(await description()).toBe("coffee");
    });

    it("an edit after a revoke writes nothing", async () => {
      changeBefore(transactions, "update", revoke);

      await expect(
        withUserContext(bobId, () =>
          jointRegister.update(bobId, rowId, {
            description: "edited by Bob",
          } as never),
        ),
      ).rejects.toThrow(/not found/i);
      expect(await description()).toBe("coffee");
    });

    it("a delete after a revoke removes nothing", async () => {
      changeBefore(transactions, "remove", revoke);

      await expect(
        withUserContext(bobId, () => jointRegister.remove(bobId, rowId)),
      ).rejects.toThrow(/not found/i);
      expect(await rowsIn(aliceChequingId)).toBe(1);
      expect(await balanceOf(aliceChequingId)).toBe(4975);
    });

    it("a create after a revoke writes nothing", async () => {
      changeBefore(transactions, "createWithOutcome", revoke);

      await expect(
        withUserContext(bobId, () =>
          jointRegister.create(bobId, {
            accountId: aliceChequingId,
            transactionDate: "2026-01-16",
            amount: -10,
            currencyCode: "USD",
          } as never),
        ),
      ).rejects.toThrow(/not found/i);
      expect(await rowsIn(aliceChequingId)).toBe(1);
      expect(await balanceOf(aliceChequingId)).toBe(4975);
    });

    it("a cleared toggle after a revoke writes nothing", async () => {
      changeBefore(transactions, "markCleared", revoke);

      await expect(
        withUserContext(bobId, () =>
          jointRegister.markCleared(bobId, rowId, true),
        ),
      ).rejects.toThrow(/not found/i);
      const [row] = await owner.query(
        `SELECT status FROM transactions WHERE id = $1`,
        [rowId],
      );
      expect(row.status).toBe("UNRECONCILED");
    });
  });

  it("a capability save racing a revoke never re-instates the delegation", async () => {
    // The revoke commits right after the setter's first database call: in the
    // read-then-save shape that is between the read and the save.
    const scoped = (
      delegation as unknown as Record<string, (...a: unknown[]) => unknown>
    )["scoped"].bind(delegation);
    let first = true;
    const spy = jest
      .spyOn(delegation as never, "scoped" as never)
      .mockImplementation((async (...args: unknown[]) => {
        const result = await scoped(...args);
        if (first) {
          first = false;
          await revoke();
        }
        return result;
      }) as never);
    spies.push(spy);

    await withUserContext(aliceId, () =>
      delegation.setCapabilities(aliceId, delegationId, {
        categoriesCanCreate: true,
      }),
    ).catch(() => undefined);

    const rows = await owner.query(
      `SELECT id, status FROM account_delegates WHERE id = $1`,
      [delegationId],
    );
    expect(rows).toEqual([]);
  });
});
