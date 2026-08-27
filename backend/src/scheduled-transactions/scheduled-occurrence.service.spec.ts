import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ScheduledOccurrenceService } from "./scheduled-occurrence.service";
import { ScheduledEffectiveAmountService } from "./scheduled-effective-amount.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../test-helpers/investment-fx-testing";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * The issue's worked example, as a schedule: 10 units at 100, pinned at 1.50
 * while the security was priced in EUR, so the persisted amount is -1,500 CAD.
 * With the security now in USD at 1.35 the occurrence posts -1,350 CAD.
 */
const investmentSchedule = (
  overrides: Partial<ScheduledTransaction> = {},
): ScheduledTransaction =>
  ({
    id: "st-inv",
    userId: "user-1",
    accountId: "brokerage-1",
    name: "Monthly ETF buy",
    amount: -1000,
    currencyCode: "CAD",
    frequency: "MONTHLY",
    nextDueDate: "2026-03-15",
    endDate: null,
    occurrencesRemaining: null,
    isActive: true,
    isSplit: false,
    isTransfer: false,
    transferAccountId: null,
    isInvestment: true,
    investmentAction: "BUY",
    investmentSecurityId: "SEC-1",
    investmentQuantity: 10,
    investmentPrice: 100,
    investmentCommission: 0,
    investmentExchangeRate: 1.5,
    investmentExchangeRateFromCurrency: "EUR",
    investmentExchangeRateToCurrency: "CAD",
    splits: [],
    ...overrides,
  }) as unknown as ScheduledTransaction;

describe("ScheduledOccurrenceService", () => {
  let service: ScheduledOccurrenceService;
  let scheduledRepo: Record<string, jest.Mock>;
  let overridesRepo: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;
  let fx: InvestmentFxMock;

  const userId = "user-1";

  /** The 5-unit re-price of one occurrence: half the shares, so -675 CAD. */
  const halfSizeOverride = (
    originalDate: string,
    overrideDate = originalDate,
  ) =>
    ({
      id: "ovr-1",
      scheduledTransactionId: "st-inv",
      originalDate,
      overrideDate,
      amount: null,
      investmentQuantity: 5,
      investmentPrice: 100,
      investmentCommission: 0,
    }) as unknown as ScheduledTransactionOverride;

  beforeEach(async () => {
    scheduledRepo = { createQueryBuilder: jest.fn() };
    overridesRepo = { find: jest.fn().mockResolvedValue([]) };
    ({ dataSource } = createScopedDbMocks([
      [ScheduledTransaction, scheduledRepo as never],
      [ScheduledTransactionOverride, overridesRepo as never],
    ]));
    // The security is USD now, and USD -> CAD is 1.35 -- the state that makes the
    // persisted 1.50 snapshot wrong.
    fx = createInvestmentFxMock();
    fx.resolveSettlementCurrencyPair.mockResolvedValue({
      from: "USD",
      to: "CAD",
    });
    fx.resolveCashExchangeRateOrNull.mockResolvedValue(1.35);
    fx.resolveSettlementAccountId.mockResolvedValue("cash-1");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledOccurrenceService,
        // The real resolver over a stubbed FX source: the amounts asserted here
        // ARE its output, so a double of it would test nothing.
        ScheduledEffectiveAmountService,
        { provide: InvestmentTransactionsService, useValue: fx },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(ScheduledOccurrenceService);
  });

  it("prices every occurrence at the current rate, never the persisted snapshot", async () => {
    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-04-30",
    });

    expect(occurrences.map((o) => o.dueDate)).toEqual([
      "2026-03-15",
      "2026-04-15",
    ]);
    expect(occurrences.every((o) => o.amount === -1350)).toBe(true);
    expect(occurrences.every((o) => o.amount !== -1500)).toBe(true);
    expect(occurrences.every((o) => o.complete)).toBe(true);
    expect(occurrences[0].currencyCode).toBe("CAD");
    // The cash settles in the linked cash account, not the brokerage.
    expect(occurrences[0].settlementAccountId).toBe("cash-1");
  });

  it("gives the overridden occurrence the override's amount and the rest the base", async () => {
    overridesRepo.find.mockResolvedValue([halfSizeOverride("2026-03-15")]);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-04-30",
    });

    expect(occurrences[0]).toMatchObject({
      originalDate: "2026-03-15",
      dueDate: "2026-03-15",
      amount: -675,
      overrideId: "ovr-1",
      moved: false,
      complete: true,
    });
    expect(occurrences[1]).toMatchObject({
      dueDate: "2026-04-15",
      amount: -1350,
      overrideId: null,
    });
  });

  /**
   * The identity is `originalDate`, so a moved occurrence must still be priced
   * from its override -- and reported on the date it actually falls on. Keying
   * the lookup on `overrideDate` (the budget alert path's mistake) silently
   * returns the base amount here.
   */
  it("keeps the override when it also moved the occurrence", async () => {
    overridesRepo.find.mockResolvedValue([
      halfSizeOverride("2026-03-15", "2026-03-28"),
    ]);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-03-31",
    });

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      originalDate: "2026-03-15",
      dueDate: "2026-03-28",
      amount: -675,
      moved: true,
    });
  });

  /**
   * An override the resolver could not price reads as `null`, which is NOT the
   * same as "this occurrence has no override" -- and substituting the base amount
   * for it is the defect issue #1247 exists to prevent.
   */
  it("leaves an unpriceable override unknown instead of falling back to the base", async () => {
    overridesRepo.find.mockResolvedValue([halfSizeOverride("2026-03-15")]);
    fx.resolveCashExchangeRateOrNull.mockResolvedValue(null);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-03-31",
    });

    expect(occurrences[0].amount).toBeNull();
    expect(occurrences[0].complete).toBe(false);
    expect(occurrences[0].settlementPair).toEqual({ from: "USD", to: "CAD" });
  });

  it("reports an unknown base amount as unknown, with the pair that failed", async () => {
    fx.resolveCashExchangeRateOrNull.mockResolvedValue(null);

    const occurrences = await service.expand(userId, [investmentSchedule()], {
      through: "2026-03-31",
    });

    expect(occurrences[0]).toMatchObject({
      amount: null,
      complete: false,
      settlementPair: { from: "USD", to: "CAD" },
    });
  });

  it("returns the ordinary schedule's own amount unchanged", async () => {
    const occurrences = await service.expand(
      userId,
      [
        investmentSchedule({
          id: "st-rent",
          name: "Rent",
          amount: -1200,
          isInvestment: false,
          investmentAction: null,
          investmentSecurityId: null,
        } as Partial<ScheduledTransaction>),
      ],
      { through: "2026-03-31" },
    );

    expect(occurrences[0].amount).toBe(-1200);
    expect(occurrences[0].complete).toBe(true);
  });

  it("asks for nothing when there are no rows", async () => {
    await expect(
      service.expand(userId, [], { through: "2026-03-31" }),
    ).resolves.toEqual([]);
    expect(overridesRepo.find).not.toHaveBeenCalled();
  });

  it("narrows the candidate read on the schedule attributes a caller asks for", async () => {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    scheduledRepo.createQueryBuilder.mockReturnValue(qb);

    await service.findOccurrences(
      userId,
      { through: "2026-04-30" },
      { outflowsOnly: true, manualOnly: true },
    );

    const predicates = qb.andWhere.mock.calls.map((c) => String(c[0]));
    expect(predicates).toContain("st.autoPost = :autoPost");
    // The outflow narrowing keeps every FX-sensitive row whatever its stored
    // sign: a bare `st.amount < 0` drops a mixed-sign split parent whose
    // effective amount has crossed zero (the behaviour tests below).
    const outflowPredicate = predicates.find((p) =>
      p.includes("st.amount < 0"),
    );
    expect(outflowPredicate).toBeDefined();
    expect(outflowPredicate).toContain("st.isInvestment = true");
    expect(outflowPredicate).toContain("scheduled_transaction_splits");
    expect(predicates).not.toContain("st.amount < 0");
  });

  it("leaves the candidate read wide when no filter is asked for", async () => {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    scheduledRepo.createQueryBuilder.mockReturnValue(qb);

    await service.findOccurrences(userId, { through: "2026-04-30" });

    const predicates = qb.andWhere.mock.calls.map((c) => String(c[0]));
    expect(predicates).not.toContain("st.amount < 0");
    expect(predicates).not.toContain("st.autoPost = :autoPost");
  });

  it("loads candidates whose occurrence an override moved into the window", async () => {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    scheduledRepo.createQueryBuilder.mockReturnValue(qb);

    await service.findOccurrences(userId, { through: "2026-04-30" });

    // The candidate predicate has to reach past `next_due_date`, or a schedule
    // whose next slot sits beyond the window loses the occurrence an override
    // pulled into it.
    const predicates = qb.andWhere.mock.calls.map((c) => String(c[0]));
    expect(
      predicates.some((p) => p.includes("scheduled_transaction_overrides")),
    ).toBe(true);
    expect(
      predicates.some((p) => p.includes("override_date <= :through")),
    ).toBe(true);
  });

  /**
   * A mixed-sign split parent is the case the stored sign cannot answer.
   *
   * Only the investment line re-prices; its ordinary sibling stays put, so the
   * parent's effective total can cross zero. "An exchange rate is positive, so
   * it cannot flip a sign" is true of one scalar times one rate and false here,
   * and `outflowsOnly` used to be a bare `st.amount < 0` on the snapshot -- which
   * counted a re-priced inflow as a bill in one direction and dropped a real
   * outflow in the other.
   */
  describe("mixed-sign split parent direction", () => {
    /**
     * An ordinary child beside an embedded SELL of 10 x 100. The SELL's stored
     * pair is EUR -> CAD, which is no longer the settlement pair, so the resolver
     * re-prices it at the current USD -> CAD rate instead of reusing 1.5.
     */
    const mixedSignSplit = (
      parentAmount: number,
      ordinaryChild: number,
    ): ScheduledTransaction =>
      investmentSchedule({
        id: "st-split",
        name: "Sell 10 shares, pay the fee",
        amount: parentAmount,
        isInvestment: false,
        investmentAction: null,
        investmentSecurityId: null,
        isSplit: true,
        splits: [
          { id: "sp-1", kind: "category", amount: ordinaryChild },
          {
            id: "sp-2",
            kind: "investment",
            amount: parentAmount - ordinaryChild,
            investmentAction: "SELL",
            investmentSecurityId: "SEC-1",
            investmentQuantity: 10,
            investmentPrice: 100,
            investmentCommission: 0,
            investmentExchangeRate: 1.5,
            investmentExchangeRateFromCurrency: "EUR",
            investmentExchangeRateToCurrency: "CAD",
          },
        ],
      } as unknown as Partial<ScheduledTransaction>);

    const candidateRead = (rows: ScheduledTransaction[]) => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
    };

    it("reports the effective sign, not the stored one", async () => {
      // Stored -200 (ordinary -1200 + SELL +1000); the SELL re-prices to +1350.
      const occurrences = await service.expand(
        userId,
        [mixedSignSplit(-200, -1200)],
        { through: "2026-03-31" },
      );

      expect(occurrences[0].amount).toBe(150);
      expect(occurrences[0].directionAmount).toBe(150);
    });

    it("drops a stored outflow whose occurrence has become an inflow", async () => {
      candidateRead([mixedSignSplit(-200, -1200)]);

      const occurrences = await service.findOccurrences(
        userId,
        { through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      // The old predicate kept this row and a budget counted abs(+150) as a bill.
      expect(occurrences).toEqual([]);
    });

    it("keeps a stored inflow whose occurrence has become an outflow", async () => {
      // The security's currency moved the other way: 10 x 100 x 0.5 = +500.
      fx.resolveCashExchangeRateOrNull.mockResolvedValue(0.5);
      candidateRead([mixedSignSplit(300, -1200)]);

      const occurrences = await service.findOccurrences(
        userId,
        { through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].amount).toBe(-700);
      expect(occurrences[0].directionAmount).toBe(-700);
    });

    it("keeps a stored INFLOW whose override made the occurrence an outflow", async () => {
      // An override replaces the amount outright, sign included, so a schedule
      // stored at +100 with a -250 override on its next slot is a real outflow the
      // snapshot cannot see. The candidate read used to narrow to `st.amount < 0`
      // plus the FX-sensitive shapes, so this row never reached the pricing.
      const deposit = investmentSchedule({
        id: "st-plain",
        name: "Quarterly rebate",
        amount: 100,
        isInvestment: false,
        investmentAction: null,
        investmentSecurityId: null,
        nextDueDate: "2026-03-15",
      } as unknown as Partial<ScheduledTransaction>);
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-charge",
          scheduledTransactionId: "st-plain",
          originalDate: "2026-03-15",
          overrideDate: "2026-03-15",
          amount: -250,
        } as unknown as ScheduledTransactionOverride,
      ]);
      candidateRead([deposit]);

      const occurrences = await service.findOccurrences(
        userId,
        { from: "2026-03-01", through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].amount).toBe(-250);
      // And the read that fetched it says why it was not pre-filtered away.
      const predicates = (
        scheduledRepo.createQueryBuilder.mock.results[0].value.andWhere.mock
          .calls as unknown[][]
      ).map((c) => String(c[0]));
      expect(
        predicates.some((p) =>
          p.includes("scheduled_transaction_overrides ovr"),
        ),
      ).toBe(true);
    });

    it("caps after the direction filter, so a credited occurrence cannot hide a real one", async () => {
      // Rent stored at -1,500 with the NEAREST occurrence overridden into a +200
      // credit, and an ordinary -1,500 occurrence later the same month. Capping
      // inside the expander kept only the credit, which the direction filter then
      // dropped -- so the budget reported no upcoming rent at all.
      const rent = investmentSchedule({
        id: "st-rent",
        name: "Rent",
        amount: -1500,
        isInvestment: false,
        investmentAction: null,
        investmentSecurityId: null,
        frequency: "WEEKLY",
        nextDueDate: "2026-03-02",
      } as unknown as Partial<ScheduledTransaction>);
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-credit",
          scheduledTransactionId: "st-rent",
          originalDate: "2026-03-02",
          overrideDate: "2026-03-02",
          amount: 200,
        } as unknown as ScheduledTransactionOverride,
      ]);
      candidateRead([rent]);

      const occurrences = await service.findOccurrences(
        userId,
        { from: "2026-03-01", through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].dueDate).toBe("2026-03-09");
      expect(occurrences[0].amount).toBe(-1500);
    });

    it("reports an unpriceable MIXED-SIGN occurrence as direction-unknown", async () => {
      // The case the whole idea exists for. A +10 parent made of a fixed -1,200
      // beside a SELL line worth +1,210 posts on either side of zero depending on
      // the rate nobody has: the direction is not derivable, and copying the
      // parent's `+10` would assert a deposit the data cannot support.
      fx.resolveCashExchangeRateOrNull.mockResolvedValue(null);
      candidateRead([mixedSignSplit(10, -1200)]);

      const occurrences = await service.findOccurrences(
        userId,
        { from: "2026-03-01", through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      // Kept, not dropped: it MIGHT be an outflow, and its amount is unknown, so
      // the consumer's total is withheld either way.
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].amount).toBeNull();
      expect(occurrences[0].directionAmount).toBeNull();
    });

    it("keeps the stored sign for an unpriceable SAME-SIGNED split", async () => {
      // Every line points the same way -- a fixed -1,200 beside a BUY, whose cash
      // impact is negative at any rate -- so the total stays negative whatever the
      // missing rate turns out to be. The sign is provable; only the magnitude is
      // not.
      fx.resolveCashExchangeRateOrNull.mockResolvedValue(null);
      const buySplit = investmentSchedule({
        id: "st-split-buy",
        name: "Buy shares and pay the fee",
        amount: -2200,
        isInvestment: false,
        investmentAction: null,
        investmentSecurityId: null,
        isSplit: true,
        splits: [
          { id: "sp-1", kind: "category", amount: -1200 },
          {
            id: "sp-2",
            kind: "investment",
            amount: -1000,
            investmentAction: "BUY",
            investmentSecurityId: "SEC-1",
            investmentQuantity: 10,
            investmentPrice: 100,
            investmentCommission: 0,
            investmentExchangeRate: 1,
            investmentExchangeRateFromCurrency: "EUR",
            investmentExchangeRateToCurrency: "CAD",
          },
        ],
      } as unknown as Partial<ScheduledTransaction>);
      candidateRead([buySplit]);

      const occurrences = await service.findOccurrences(
        userId,
        { from: "2026-03-01", through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].amount).toBeNull();
      expect(occurrences[0].directionAmount).toBe(-2200);
    });

    it("keeps the stored sign for an unpriceable TOP-LEVEL investment", async () => {
      // One scalar times one rate, and a rate is positive: the sign cannot move.
      fx.resolveCashExchangeRateOrNull.mockResolvedValue(null);
      candidateRead([investmentSchedule()]);

      const occurrences = await service.findOccurrences(
        userId,
        { from: "2026-03-01", through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].amount).toBeNull();
      expect(occurrences[0].directionAmount).toBe(-1000);
    });

    it("keeps a schedule whose override introduces the investment split", async () => {
      // The override carries the shape, not just the amount: `isSplit` with an
      // embedded investment line and `amount` NULL, because the lines carry it.
      // A prefilter that asked only about `ovr.amount` dropped this row before the
      // override was ever loaded.
      const deposit = investmentSchedule({
        id: "st-plain-shape",
        name: "Quarterly rebate",
        amount: 100,
        isInvestment: false,
        investmentAction: null,
        investmentSecurityId: null,
        isSplit: false,
        splits: [],
      } as unknown as Partial<ScheduledTransaction>);
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-shape",
          scheduledTransactionId: "st-plain-shape",
          originalDate: "2026-03-15",
          overrideDate: "2026-03-15",
          amount: null,
          isSplit: true,
          splits: [
            { amount: -100 },
            {
              investment: {
                action: "BUY",
                securityId: "SEC-1",
                quantity: 10,
                price: 100,
                commission: 0,
                exchangeRate: 1,
                exchangeRateFromCurrency: "EUR",
                exchangeRateToCurrency: "CAD",
              },
            },
          ],
        } as unknown as ScheduledTransactionOverride,
      ]);
      candidateRead([deposit]);

      const occurrences = await service.findOccurrences(
        userId,
        { from: "2026-03-01", through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      expect(occurrences).toHaveLength(1);
      // -100 fixed plus a BUY of 10 x 100 at 1.35 = -1,450.
      expect(occurrences[0].amount).toBe(-1450);
      expect(occurrences[0].directionAmount).toBe(-1450);
      const predicates = (
        scheduledRepo.createQueryBuilder.mock.results[0].value.andWhere.mock
          .calls as unknown[][]
      ).map((c) => String(c[0]));
      expect(predicates.some((p) => p.includes("ovr.is_split = true"))).toBe(
        true,
      );
    });

    it("excludes an occurrence an override turned into a deposit", async () => {
      // The mirror of the kept case: a negative base whose override is positive is
      // not an outflow, and the post-pricing filter is what establishes that.
      const bill = investmentSchedule({
        id: "st-plain-neg",
        name: "Monthly fee",
        amount: -100,
        isInvestment: false,
        investmentAction: null,
        investmentSecurityId: null,
        isSplit: false,
        splits: [],
      } as unknown as Partial<ScheduledTransaction>);
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-credit",
          scheduledTransactionId: "st-plain-neg",
          originalDate: "2026-03-15",
          overrideDate: "2026-03-15",
          amount: 75,
        } as unknown as ScheduledTransactionOverride,
      ]);
      candidateRead([bill]);

      const occurrences = await service.findOccurrences(
        userId,
        { from: "2026-03-01", through: "2026-03-31", maxOccurrences: 1 },
        { outflowsOnly: true },
      );

      expect(occurrences).toEqual([]);
    });
  });
});
