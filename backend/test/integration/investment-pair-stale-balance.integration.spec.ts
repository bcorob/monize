import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A26-M13 (A26-S07-07): renaming one half of an investment pair read the
 * other half without a lock and `save`d it, so TypeORM wrote back every
 * column that differed from its fresh read -- the snapshot's
 * `current_balance` among them. Cash half 1,000.00, a +10.00 posting landing
 * between the read and the save: 1,010.00 after the posting, 1,000.00 after
 * the rename.
 *
 * The posting is made deterministic by a trigger on the addressed half's row:
 * the rename's own UPDATE of the brokerage fires it, after the cash half was
 * read and before it is written, which is exactly the window.
 */
describe("Investment pair rename keeps the other half's balance (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let userId: string;
  let cashId: string;
  let brokerageId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
  });

  afterAll(async () => {
    await db.query(
      `DROP TRIGGER IF EXISTS zz_pair_posting ON accounts;
       DROP FUNCTION IF EXISTS zz_pair_posting();`,
    );
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "transactions",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    cashId = (
      await createTestAccount(db, userId, {
        name: "Broker - Cash",
        accountType: AccountType.INVESTMENT,
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    brokerageId = (
      await createTestAccount(db, userId, {
        name: "Broker - Brokerage",
        accountType: AccountType.INVESTMENT,
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    await db.manager.update(Account, cashId, {
      accountSubType: AccountSubType.INVESTMENT_CASH,
      linkedAccountId: brokerageId,
    });
    await db.manager.update(Account, brokerageId, {
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cashId,
    });
    await db.query(
      `CREATE OR REPLACE FUNCTION zz_pair_posting() RETURNS trigger AS $$
       BEGIN
         IF NEW.name IS DISTINCT FROM OLD.name THEN
           UPDATE accounts SET current_balance = current_balance + 10
            WHERE id = '${cashId}';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql;
       DROP TRIGGER IF EXISTS zz_pair_posting ON accounts;
       CREATE TRIGGER zz_pair_posting AFTER UPDATE ON accounts
         FOR EACH ROW WHEN (NEW.id = '${brokerageId}'::uuid)
         EXECUTE FUNCTION zz_pair_posting();`,
    );
  });

  afterEach(async () => {
    await db.query(`DROP TRIGGER IF EXISTS zz_pair_posting ON accounts`);
  });

  it("a rename of the brokerage half leaves the cash half's balance as moved", async () => {
    await withUserContext(userId, () =>
      accounts.update(userId, brokerageId, { name: "Renamed" }),
    );

    const cash = await db.manager.findOneByOrFail(Account, { id: cashId });
    expect(cash.name).toBe("Renamed - Cash");
    expect(Number(cash.currentBalance)).toBe(1010);
  });
});
