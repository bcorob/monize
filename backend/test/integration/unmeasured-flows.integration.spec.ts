import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountType } from "@/accounts/entities/account.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import { loadUnmeasuredFlowRows } from "@/net-worth/unmeasured-flows.util";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The three unmeasured-flow statements against a real PostgreSQL parser.
 *
 * The regression: the mixed-split statement was handed the settled-trade
 * statement's five parameters but referenced only $1, $2, $3 and $5, so the
 * server could not infer $4's type and refused the whole statement at PARSE
 * ("could not determine data type of parameter $4", SQLSTATE 42P18). Every
 * period result -- the single route and the batch behind the Investments
 * page -- failed with a database error. A mocked `query` accepts any
 * parameter list, so only a real parse can hold this: each statement binds
 * every placeholder it names and no other, per day and as a whole-window
 * total.
 *
 * `externalShareTransfersSql` is the third, and it is the same hazard again:
 * it names $1..$4 and takes no cash scope, so it is bound to the settled
 * list WITHOUT its fifth member. A statement given one placeholder too many
 * parses; one too few does not, and neither shows up against a mock.
 */
describe("unmeasured flow statements (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let brokerageId: string;
  let cashId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      accountType: AccountType.INVESTMENT,
    });
    brokerageId = brokerage.id;
    const cash = await createTestAccount(dataSource, userId, {
      name: "Brokerage cash",
      accountType: AccountType.INVESTMENT,
    });
    cashId = cash.id;
  });

  const load = (perDay: boolean) =>
    withUserContext(userId, () =>
      loadUnmeasuredFlowRows(
        (sql, params) => withScopedDb(dataSource, (m) => m.query(sql, params)),
        {
          userId,
          afterDate: addDaysYMD(todayYMD(), -365),
          throughDate: todayYMD(),
          scope: [brokerageId, cashId],
          cashScope: [cashId],
          perDay,
        },
      ),
    );

  it("parses and answers all three statements per day", async () => {
    await expect(load(true)).resolves.toEqual({
      externallySettledTrades: [],
      externalShareTransfers: [],
      mixedSplitParents: [],
    });
  });

  it("parses and answers all three statements as one total", async () => {
    // Without GROUP BY, COUNT(*) over no rows is one row saying zero: a
    // whole-window total, dated to no day, which every slice then reads.
    await expect(load(false)).resolves.toEqual({
      externallySettledTrades: [{ date: null, count: 0 }],
      externalShareTransfers: [{ date: null, count: 0 }],
      mixedSplitParents: [{ date: null, count: 0 }],
    });
  });

  it("binds the share statement's four placeholders, and no cash scope", async () => {
    // The cash boundary is meaningless to a leg with no cash at all, so the
    // statement neither names $5 nor may be bound one: a parse is the only
    // thing that tells the two apart.
    const bound: unknown[][] = [];
    await withUserContext(userId, () =>
      loadUnmeasuredFlowRows(
        (sql, params) => {
          if (sql.includes("it.linked_transaction_id")) bound.push(params);
          return withScopedDb(dataSource, (m) => m.query(sql, params));
        },
        {
          userId,
          afterDate: addDaysYMD(todayYMD(), -365),
          throughDate: todayYMD(),
          scope: [brokerageId, cashId],
          cashScope: [cashId],
        },
      ),
    );

    expect(bound).toHaveLength(1);
    expect(bound[0]).toHaveLength(4);
    expect(bound[0][3]).toEqual([brokerageId, cashId]);
  });
});
