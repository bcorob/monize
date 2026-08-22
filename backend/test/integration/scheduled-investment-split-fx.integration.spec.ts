import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { SecuritiesModule } from "@/securities/securities.module";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "@/securities/entities/investment-transaction.entity";
import { Security } from "@/securities/entities/security.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import { investmentSplitCashAmount } from "@/securities/cash-impact.util";

/**
 * Issue #1167 F-rev3.2 -- the cross-boundary half.
 *
 * A scheduled split-investment posting re-resolves an embedded split's cash FX
 * rate and recomputes its cash amount from that rate (unit-tested in
 * scheduled-transactions.service.spec.ts). The amount it emits is
 * `investmentSplitCashAmount(action, qty, price, commission, effectiveRate)`,
 * and the effective rate is what it forwards as `investment.exchangeRate`. This
 * suite proves the *consumer* half end-to-end: that exact payload, run through
 * the real `TransactionsService.create -> TransactionSplitService.createSplits
 * -> InvestmentTransactionsService.createEmbeddedForSplit`, books the recomputed
 * amount on the parent, the split and the embedded investment row -- and that a
 * stale amount (the pre-#1167 stored figure) is refused there rather than
 * silently written. Together with the producer unit tests, the two halves close
 * the loop the scheduled posting relies on.
 *
 * The security settles in a different currency from its cash sleeve (USD ->
 * CAD), which is the shape #1167 is about; the rate travels as an explicit
 * `investment.exchangeRate`, exactly as the posting forwards its resolved rate,
 * so no FX provider is involved.
 */
describe("Scheduled investment split FX at posting (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let cashAccountId: string;
  let brokerageAccountId: string;
  let securityId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([
      SecuritiesModule,
      TransactionsModule,
    ]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "securities",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2), ('CAD', 'Canadian Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    // The brokerage and its CAD cash sleeve. An embedded investment split's
    // parent transaction lives on the INVESTMENT_CASH account, whose
    // linkedAccountId names the brokerage.
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    brokerageAccountId = brokerage.id;

    const cash = await createTestAccount(dataSource, userId, {
      name: "Brokerage Cash",
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, cash.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
      linkedAccountId: brokerageAccountId,
    });
    cashAccountId = cash.id;

    // A USD-denominated security: the cash impact is in USD, the settlement is
    // in CAD, so the amount depends on the FX rate the posting resolves.
    const security = dataSource.manager.create(Security, {
      userId,
      symbol: "USDX",
      name: "USD Security",
      securityType: "STOCK",
      currencyCode: "USD",
      skipPriceUpdates: true,
    });
    const savedSecurity = await dataSource.manager.save(security);
    securityId = savedSecurity.id;
  });

  const buildSplitPayload = (amount: number, exchangeRate: number) => ({
    accountId: cashAccountId,
    transactionDate: "2026-05-09",
    amount,
    currencyCode: "CAD",
    isSplit: true,
    splits: [
      {
        amount,
        investment: {
          action: InvestmentAction.BUY,
          securityId,
          quantity: 10,
          price: 100,
          commission: 0,
          exchangeRate,
        },
      },
    ],
  });

  it("books the effective (re-resolved) rate and recomputed amount through createEmbeddedForSplit", async () => {
    // What the scheduled posting emits: the effective rate it resolved (1.35)
    // and the amount computed from it by the shared helper. cash impact of a BUY
    // 10 @ 100 USD is -1000; at 1.35 that is -1350 CAD.
    const rate = 1.35;
    const amount = investmentSplitCashAmount(
      InvestmentAction.BUY,
      10,
      100,
      0,
      rate,
    );
    expect(amount).toBe(-1350);

    const result = await withUserContext(userId, () =>
      service.create(userId, buildSplitPayload(amount, rate) as any),
    );

    // Parent and split both carry the recomputed CAD amount.
    expect(Number(result.amount)).toBe(-1350);
    expect(result.splits).toHaveLength(1);
    expect(Number(result.splits[0].amount)).toBe(-1350);

    // The embedded investment row settled at the forwarded rate, with the cash
    // account moved by the recomputed amount.
    const embedded = await dataSource.manager.find(InvestmentTransaction, {
      where: { userId },
    });
    expect(embedded).toHaveLength(1);
    expect(Number(embedded[0].exchangeRate)).toBe(1.35);
    expect(embedded[0].accountId).toBe(brokerageAccountId);

    const cash = await dataSource.manager.findOneOrFail(Account, {
      where: { id: cashAccountId },
    });
    expect(Number(cash.currentBalance)).toBe(-1350);
  });

  it("refuses a stale split amount that disagrees with the forwarded rate", async () => {
    // The pre-#1167 defect: the stored amount is the figure computed at the
    // *old* rate (1.5 -> -1500) while the forwarded/effective rate is 1.35. The
    // embedded-split consistency check refuses it rather than writing two halves
    // that describe different money.
    const staleAmount = -1500;
    const effectiveRate = 1.35;

    // The refusal fires at the split-consistency guard (whichever of
    // validateSplits or createEmbeddedForSplit reaches it first): the amount is
    // measured against the cash impact converted at the forwarded 1.35, so -1500
    // cannot pass while -1350 is what that rate produces.
    await expect(
      withUserContext(userId, () =>
        service.create(
          userId,
          buildSplitPayload(staleAmount, effectiveRate) as any,
        ),
      ),
    ).rejects.toThrow(/expected -1350/);

    // Nothing was written: no parent, no split, no investment row.
    const txs = await dataSource.manager.find(Transaction, {
      where: { userId },
    });
    expect(txs).toHaveLength(0);
    const splits = await dataSource.manager.find(TransactionSplit, {});
    expect(splits).toHaveLength(0);
    const embedded = await dataSource.manager.find(InvestmentTransaction, {
      where: { userId },
    });
    expect(embedded).toHaveLength(0);
  });
});
