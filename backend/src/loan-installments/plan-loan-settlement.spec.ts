import { Account, AccountType } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { sumMoney } from "../common/round.util";
import {
  LoanFactsUnavailable,
  LoanOccurrenceClaim,
  LoanSettlementFacts,
} from "./loan-settlement-facts";
import { occurrenceSlotsInRange } from "./occurrence-slots";
import {
  applyAmountPolicy,
  LoanSettlementRow,
  planLoanSettlement,
} from "./plan-loan-settlement";
import {
  LOAN_SETTLEMENT_TOLERANCE_MINOR_UNITS,
  LoanSettlementAction,
  LoanSettlementPlan,
  pricingColumn,
  PriorSettlement,
} from "./loan-settlement.types";

/**
 * The pure settlement planner against the fixtures of
 * `docs/specs/loan-installment-settlement.md`: section 8 (every row of the
 * amount-policy table and its totality), section 9 (every worked example),
 * the fold of 9.4 with its "dated on or before the slot" condition, the
 * missing-data policy of section 10 and refusals 11 to 19 of section 11 in
 * their order. Every figure is the spec's, produced independently of this
 * implementation; a case that disagrees with the spec is wrong here.
 */
describe("planLoanSettlement", () => {
  const userId = "user-1";
  const loanId = "acc-loan";
  const chequingId = "acc-chequing";
  const scheduleId = "st-loan";
  const interestCategoryId = "cat-interest";

  const action = (
    overrides: Partial<LoanSettlementAction> = {},
  ): LoanSettlementAction => ({
    loanAccountId: loanId,
    dueDateWindow: { daysBefore: 3, daysAfter: 7 },
    excess: "extra_principal",
    shortfall: "refuse",
    ...overrides,
  });

  const row = (
    amount: number,
    overrides: Partial<LoanSettlementRow> = {},
  ): LoanSettlementRow => ({
    id: "tx-row",
    date: "2024-01-03",
    amount,
    currencyCode: "EUR",
    accountId: chequingId,
    ...overrides,
  });

  const linearAccount = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanId,
      userId,
      accountType: AccountType.MORTGAGE,
      name: "Hypotheek",
      currencyCode: "EUR",
      isClosed: false,
      interestBookingMode: "AUTO",
      mortgageType: "LINEAR",
      prepaymentMode: null,
      interestRate: 2,
      paymentAmount: null,
      extraPaymentAmount: null,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      amortizationMonths: 360,
      originalPrincipal: 300000,
      openingBalance: -300000,
      currentBalance: -300000,
      interestCategoryId,
      scheduledTransactionId: scheduleId,
      ...overrides,
    }) as unknown as Account;

  const annuityAccount = (overrides: Partial<Account> = {}): Account =>
    linearAccount({
      accountType: AccountType.LOAN,
      mortgageType: "ANNUITY",
      interestRate: 6,
      paymentAmount: 1500,
      paymentStartDate: null,
      amortizationMonths: null,
      originalPrincipal: null,
      openingBalance: -200000,
      currentBalance: -200000,
      ...overrides,
    });

  interface Fixture {
    account?: Account;
    principal?: number;
    interest?: number;
    extra?: number;
    schedule?: Partial<ScheduledTransaction>;
    splits?: ScheduledTransactionSplit[];
    rateChanges?: LoanRateChange[];
    claims?: LoanOccurrenceClaim[];
    postedRowIds?: string[];
    /** The ledger debt at every slot, or per slot date. */
    debt?: number | Record<string, number>;
    range?: { from: string; to: string };
  }

  const makeFacts = (fixture: Fixture = {}): LoanSettlementFacts => {
    const account = fixture.account ?? linearAccount();
    const principal = fixture.principal ?? 833.3333;
    const interest = fixture.interest ?? 500;
    const extra = fixture.extra ?? 0;
    const schedule = {
      id: scheduleId,
      userId,
      accountId: chequingId,
      name: "Mortgage",
      amount: -(principal + interest + extra),
      currencyCode: account.currencyCode,
      frequency: "MONTHLY",
      startDate: "2024-01-01",
      nextDueDate: "2024-01-01",
      endDate: null,
      occurrencesRemaining: null,
      isActive: true,
      isSplit: true,
      ...fixture.schedule,
    } as unknown as ScheduledTransaction;
    const splits =
      fixture.splits ??
      ([
        {
          id: "split-principal",
          scheduledTransactionId: scheduleId,
          transferAccountId: loanId,
          categoryId: null,
          amount: -principal,
          memo: "Principal",
        },
        {
          id: "split-interest",
          scheduledTransactionId: scheduleId,
          transferAccountId: null,
          categoryId: interestCategoryId,
          amount: -interest,
          memo: "Interest",
        },
        ...(extra > 0
          ? [
              {
                id: "split-extra",
                scheduledTransactionId: scheduleId,
                transferAccountId: loanId,
                categoryId: null,
                amount: -extra,
                memo: "Extra Principal",
              },
            ]
          : []),
      ] as unknown as ScheduledTransactionSplit[]);
    const slots = occurrenceSlotsInRange(
      schedule,
      fixture.range ?? { from: "2023-12-01", to: "2024-12-31" },
    );
    const debt = fixture.debt ?? Math.abs(Number(account.openingBalance));
    const debtByDueDate = new Map<string, number>();
    for (const slot of slots) {
      debtByDueDate.set(
        slot.date,
        typeof debt === "number" ? debt : (debt[slot.date] ?? 0),
      );
    }
    return {
      kind: "facts",
      loanAccount: account,
      schedule,
      splits,
      rateChanges: fixture.rateChanges ?? [],
      slots,
      claims: fixture.claims ?? [],
      postedRowIds: new Set(fixture.postedRowIds ?? []),
      debtByDueDate,
    };
  };

  const claim = (
    originalDueDate: string,
    overrides: Partial<LoanOccurrenceClaim> = {},
  ): LoanOccurrenceClaim => ({
    id: `claim-${originalDueDate}`,
    originalDueDate,
    source: "post",
    transactionId: null,
    ...overrides,
  });

  const plan = (
    amount: number,
    facts: LoanSettlementFacts | LoanFactsUnavailable = makeFacts(),
    actionOverrides: Partial<LoanSettlementAction> = {},
    rowOverrides: Partial<LoanSettlementRow> = {},
    prior: PriorSettlement[] = [],
  ) =>
    planLoanSettlement(
      action(actionOverrides),
      row(amount, rowOverrides),
      facts,
      prior,
    );

  /** The written lines as `principal / interest / extra`, with the outcome. */
  const lines = (result: ReturnType<typeof plan>) => {
    if (!result.ok) return result.reason;
    const { settlement } = result;
    return [
      settlement.principal,
      settlement.interest,
      settlement.extraPrincipal,
      settlement.outcome,
    ];
  };

  const planned = (result: ReturnType<typeof plan>): LoanSettlementPlan => {
    if (!result.ok) {
      throw new Error(`expected a plan, got ${result.reason}`);
    }
    return result.settlement;
  };

  describe("9.1 LINEAR, EUR 300,000 over 360 months at 2 %, slot 1", () => {
    it.each([
      ["L1", -1333.33, {}, [833.33, 500, 0, "exact"]],
      ["L2", -1333.35, {}, [833.33, 500.02, 0, "tolerance"]],
      ["L3", -1333.3, {}, [833.33, 499.97, 0, "tolerance"]],
      ["L4", -1333.39, {}, [833.33, 500, 0.06, "extra_principal"]],
      ["L4r", -1333.39, { excess: "refuse" }, "installment_amount_excess"],
      ["L5", -1533.33, {}, [833.33, 500, 200, "extra_principal"]],
      ["L6", -1533.33, { excess: "refuse" }, "installment_amount_excess"],
      ["L7", -1300, {}, "installment_amount_shortfall"],
      [
        "L8",
        -1300,
        { shortfall: "interest_first" },
        [800, 500, 0, "interest_first"],
      ],
    ] as Array<[string, number, Partial<LoanSettlementAction>, unknown]>)(
      "%s: a row of %p gives %p",
      (_name, amount, overrides, expected) => {
        expect(lines(plan(amount, makeFacts(), overrides))).toEqual(expected);
      },
    );

    it("prices 833.3333 + 500.0000 and books 833.33 + 500.00 = 1,333.33", () => {
      const settlement = planned(plan(-1333.33));
      expect(settlement.priced).toEqual({
        principal: 833.3333,
        interest: 500,
        extra: 0,
        total: 1333.3333,
      });
      expect(settlement.booked).toEqual({
        principal: 833.33,
        interest: 500,
        extra: 0,
        total: 1333.33,
      });
      expect(settlement).toMatchObject({
        loanAccountId: loanId,
        scheduledTransactionId: scheduleId,
        dueDate: "2024-01-01",
        installmentNumber: 1,
        method: "LINEAR",
        prepaymentMode: "SHORTEN_TERM",
        currencyCode: "EUR",
        debtLedger: 300000,
        foldedPrincipal: 0,
        debtBefore: 300000,
        annualRate: 2,
        periodicRate: 2 / 100 / 12,
        paid: 1333.33,
        difference: 0,
        toleranceApplied: 0,
        policy: { excess: "extra_principal", shortfall: "refuse" },
        advancesCursor: true,
      });
    });

    it("L2 records the tolerance the interest line absorbed; L7 names the expected total and what was paid", () => {
      expect(planned(plan(-1333.35)).toleranceApplied).toBe(0.02);
      expect(planned(plan(-1333.3)).toleranceApplied).toBe(-0.03);
      expect(plan(-1300)).toEqual({
        ok: false,
        reason: "installment_amount_shortfall",
        detail: { dueDate: "2024-01-01", expected: 1333.33, paid: 1300 },
      });
      expect(plan(-1533.33, makeFacts(), { excess: "refuse" })).toEqual({
        ok: false,
        reason: "installment_amount_excess",
        detail: {
          dueDate: "2024-01-01",
          expected: 1333.33,
          paid: 1533.33,
          debtBefore: 300000,
        },
      });
    });

    it("writes the split with the row's sign, the loan as the transfer target and the configured interest category", () => {
      const result = plan(-1533.33);
      if (!result.ok) throw new Error(result.reason);
      expect(result.structure).toEqual({
        kind: "split",
        parts: [
          {
            amount: -833.33,
            categoryId: null,
            transferAccountId: loanId,
            payeeId: null,
            memo: "Principal",
          },
          {
            amount: -500,
            categoryId: interestCategoryId,
            transferAccountId: null,
            payeeId: null,
            memo: "Interest",
          },
          {
            amount: -200,
            categoryId: null,
            transferAccountId: loanId,
            payeeId: null,
            memo: "Extra Principal",
          },
        ],
      });
    });

    it("the action's interest category wins over the loan's", () => {
      const result = plan(-1333.33, makeFacts(), {
        interestCategoryId: "cat-rente",
      });
      if (!result.ok) throw new Error(result.reason);
      expect(result.structure.parts[1].categoryId).toBe("cat-rente");
    });

    describe("slot 2, priced on debtBefore", () => {
      it("L9: after L1 is written, 299,166.67 prices 833.33 + 498.61", () => {
        const facts = makeFacts({
          debt: { "2024-01-01": 300000, "2024-02-01": 299166.67 },
          claims: [
            claim("2024-01-01", { source: "rule", transactionId: "tx-l1" }),
          ],
        });
        const settlement = planned(
          plan(-1331.94, facts, {}, { date: "2024-02-02" }),
        );
        expect(settlement.priced).toEqual({
          principal: 833.3333,
          interest: 498.6111,
          extra: 0,
          total: 1331.9444,
        });
        expect([
          settlement.principal,
          settlement.interest,
          settlement.outcome,
        ]).toEqual([833.33, 498.61, "exact"]);
        expect(settlement.installmentNumber).toBe(2);
        // The cursor still stands on slot 1: a later slot does not advance it.
        expect(settlement.advancesCursor).toBe(false);
      });

      it("L10: after L5 is written, 298,966.67 prices 833.33 + 498.28", () => {
        const facts = makeFacts({
          debt: { "2024-01-01": 300000, "2024-02-01": 298966.67 },
          claims: [
            claim("2024-01-01", { source: "rule", transactionId: "tx-l5" }),
          ],
        });
        const settlement = planned(
          plan(-1331.61, facts, {}, { date: "2024-02-02" }),
        );
        expect(settlement.priced).toEqual({
          principal: 833.3333,
          interest: 498.2778,
          extra: 0,
          total: 1331.6111,
        });
        expect([
          settlement.principal,
          settlement.interest,
          settlement.outcome,
        ]).toEqual([833.33, 498.28, "exact"]);
      });
    });
  });

  describe("9.2 ANNUITY, EUR 200,000 at 6 % monthly, payment 1,500", () => {
    const facts = () =>
      makeFacts({ account: annuityAccount(), principal: 500, interest: 1000 });

    it.each([
      ["A1", -1500, {}, [500, 1000, 0, "exact"]],
      ["A2", -1500.04, {}, [500, 1000.04, 0, "tolerance"]],
      ["A3", -1700, {}, [500, 1000, 200, "extra_principal"]],
      ["A4", -1450, {}, "installment_amount_shortfall"],
      [
        "A5",
        -1450,
        { shortfall: "interest_first" },
        [450, 1000, 0, "interest_first"],
      ],
    ] as Array<[string, number, Partial<LoanSettlementAction>, unknown]>)(
      "%s: a row of %p gives %p",
      (_name, amount, overrides, expected) => {
        expect(lines(plan(amount, facts(), overrides))).toEqual(expected);
      },
    );

    it("A6: slot 2 after A1, debtBefore 199,500.00, prices 997.50 interest and 502.50 principal", () => {
      const settlement = planned(
        plan(
          -1500,
          makeFacts({
            account: annuityAccount(),
            principal: 500,
            interest: 1000,
            debt: { "2024-01-01": 200000, "2024-02-01": 199500 },
            claims: [
              claim("2024-01-01", { source: "rule", transactionId: "tx-a1" }),
            ],
          }),
          {},
          { date: "2024-02-02" },
        ),
      );
      expect([
        settlement.principal,
        settlement.interest,
        settlement.outcome,
      ]).toEqual([502.5, 997.5, "exact"]);
      expect(settlement.method).toBe("LOAN");
      expect(settlement.prepaymentMode).toBeNull();
    });

    it.each([
      [198500, 992.5, 507.5],
      [198000, 990, 510],
    ])(
      "the pricing spec's section 5 rows: debtBefore %p prices %p interest and %p principal",
      (debt, interest, principal) => {
        const settlement = planned(
          plan(
            -1500,
            makeFacts({
              account: annuityAccount(),
              principal: 500,
              interest: 1000,
              debt,
            }),
          ),
        );
        expect([settlement.principal, settlement.interest]).toEqual([
          principal,
          interest,
        ]);
      },
    );

    it("prices the dated payment (decision 12): a rate-change row's new payment on or before the slot, not the template", () => {
      const rateChanges = [
        {
          effectiveDate: "2023-06-01",
          annualRate: 6,
          newPaymentAmount: 1600,
          source: "manual",
        },
        {
          effectiveDate: "2024-01-01",
          annualRate: 6,
          newPaymentAmount: 1500,
          source: "manual",
        },
        {
          effectiveDate: "2024-02-01",
          annualRate: 7,
          newPaymentAmount: 1700,
          source: "inferred",
        },
      ] as unknown as LoanRateChange[];
      const facts = makeFacts({
        account: annuityAccount({ paymentAmount: 9999 }),
        // A template clamped to a different figure must not drive the price.
        principal: 480,
        interest: 1000,
        rateChanges,
      });
      expect(lines(plan(-1500, facts))).toEqual([500, 1000, 0, "exact"]);
      // At slot 2 the 2024-02-01 row applies: 7 % on 200,000 = 1,166.67; payment 1,700.
      const second = planned(plan(-1700, facts, {}, { date: "2024-02-02" }));
      expect([second.annualRate, second.principal, second.interest]).toEqual([
        7, 533.33, 1166.67,
      ]);
    });

    it("a rate-change payment states the base, so the standing extra rides on top of it (7.3 step 3)", () => {
      const rateChanges = [
        {
          effectiveDate: "2024-01-01",
          annualRate: 6,
          newPaymentAmount: 1500,
          source: "manual",
        },
      ] as unknown as LoanRateChange[];
      const facts = makeFacts({
        account: annuityAccount({ paymentAmount: null }),
        principal: 400,
        interest: 1000,
        extra: 100,
        rateChanges,
      });
      const settlement = planned(plan(-1600, facts, { excess: "refuse" }));
      expect(settlement.priced).toEqual({
        principal: 500,
        interest: 1000,
        extra: 100,
        total: 1600,
      });
      expect([
        settlement.principal,
        settlement.interest,
        settlement.extraPrincipal,
        settlement.outcome,
      ]).toEqual([500, 1000, 100, "exact"]);
      // Without the extra the stated base is the whole installment.
      expect(
        lines(
          plan(
            -1500,
            makeFacts({
              account: annuityAccount({ paymentAmount: null }),
              principal: 500,
              interest: 1000,
              rateChanges,
            }),
          ),
        ),
      ).toEqual([500, 1000, 0, "exact"]);
    });

    it("an initial row and accounts.payment_amount already hold the extra, so it is not added twice", () => {
      const initial = [
        {
          effectiveDate: "2024-01-01",
          annualRate: 6,
          newPaymentAmount: 1600,
          source: "initial",
        },
      ] as unknown as LoanRateChange[];
      const fromInitial = makeFacts({
        account: annuityAccount({ paymentAmount: null }),
        principal: 400,
        interest: 1000,
        extra: 100,
        rateChanges: initial,
      });
      expect(lines(plan(-1600, fromInitial, { excess: "refuse" }))).toEqual([
        500,
        1000,
        100,
        "exact",
      ]);
      const fromAccount = makeFacts({
        account: annuityAccount({ paymentAmount: 1600 }),
        principal: 400,
        interest: 1000,
        extra: 100,
      });
      expect(lines(plan(-1600, fromAccount, { excess: "refuse" }))).toEqual([
        500,
        1000,
        100,
        "exact",
      ]);
    });
  });

  describe("9.3 edges", () => {
    const interestOnly = () =>
      makeFacts({
        account: linearAccount({ mortgageType: "INTEREST_ONLY" }),
        principal: 0,
        interest: 500,
      });

    it("E1: INTEREST_ONLY keeps the 0.00 principal line (decision 15)", () => {
      const result = plan(-500, interestOnly());
      expect(lines(result)).toEqual([0, 500, 0, "exact"]);
      if (!result.ok) throw new Error(result.reason);
      expect(result.structure.parts.map((p) => [p.amount, p.memo])).toEqual([
        [0, "Principal"],
        [-500, "Interest"],
      ]);
      expect(result.settlement.method).toBe("INTEREST_ONLY");
    });

    it("E2: an INTEREST_ONLY excess is extra principal", () => {
      expect(lines(plan(-700, interestOnly()))).toEqual([
        0,
        500,
        200,
        "extra_principal",
      ]);
    });

    it("E3: an INTEREST_ONLY shortfall interest-first books all of it as interest", () => {
      expect(
        lines(plan(-450, interestOnly(), { shortfall: "interest_first" })),
      ).toEqual([0, 450, 0, "interest_first"]);
    });

    const retiring = () =>
      makeFacts({
        account: annuityAccount(),
        principal: 500,
        interest: 1000,
        debt: 1000,
      });

    it("E4: the final annuity installment retires the loan: principal clamped to the debt", () => {
      const settlement = planned(plan(-1005, retiring()));
      expect([
        settlement.principal,
        settlement.interest,
        settlement.outcome,
      ]).toEqual([1000, 5, "exact"]);
      expect(settlement.booked.total).toBe(1005);
    });

    it("E5: an excess that would exceed the debt is refused, naming the debt", () => {
      expect(plan(-1105, retiring())).toEqual({
        ok: false,
        reason: "installment_amount_excess",
        detail: {
          dueDate: "2024-01-01",
          expected: 1005,
          paid: 1105,
          debtBefore: 1000,
        },
      });
    });

    const zeroRate = () =>
      makeFacts({
        account: annuityAccount({ interestRate: 0, paymentAmount: 500 }),
        principal: 500,
        interest: 0,
      });

    it("E6: a within-tolerance difference that would make interest negative is a shortfall (decision 14)", () => {
      expect(lines(plan(-499.97, zeroRate()))).toBe(
        "installment_amount_shortfall",
      );
    });

    it("E7: and under interest_first it books interest 0 and the rest as principal", () => {
      expect(
        lines(plan(-499.97, zeroRate(), { shortfall: "interest_first" })),
      ).toEqual([499.97, 0, 0, "interest_first"]);
    });

    const withExtra = () => makeFacts({ extra: 100 });

    it.each([
      ["E8", -1433.33, [833.33, 500, 100, "exact"]],
      ["E9", -1533.33, [833.33, 500, 200, "extra_principal"]],
      ["E10", -1383.33, [833.33, 500, 50, "extra_shed"]],
      ["E11", -1333.31, [833.33, 499.98, 0, "tolerance"]],
      ["E12", -1300, "installment_amount_shortfall"],
    ] as Array<[string, number, unknown]>)(
      "%s: with a standing extra of 100.00 a row of %p gives %p",
      (_name, amount, expected) => {
        expect(lines(plan(amount, withExtra()))).toEqual(expected);
      },
    );

    it("E9 merges the excess into the one standing extra line", () => {
      const result = plan(-1533.33, withExtra());
      if (!result.ok) throw new Error(result.reason);
      expect(result.structure.parts).toHaveLength(3);
      expect(result.structure.parts[2]).toMatchObject({
        amount: -200,
        memo: "Extra Principal",
      });
      expect(result.settlement.booked).toEqual({
        principal: 833.33,
        interest: 500,
        extra: 100,
        total: 1433.33,
      });
    });

    it("E11 drops the extra line entirely when the row paid only the base", () => {
      const result = plan(-1333.31, withExtra());
      if (!result.ok) throw new Error(result.reason);
      expect(result.structure.parts).toHaveLength(2);
      expect(result.settlement.toleranceApplied).toBe(-0.02);
    });

    const yen = () =>
      makeFacts({
        account: annuityAccount({
          currencyCode: "JPY",
          interestRate: 1.2,
          paymentAmount: 120000,
          openingBalance: -30000000,
        }),
        principal: 90000,
        interest: 30000,
      });

    /**
     * The policy table at 0 decimals (the acceptance asks for every row at 2
     * and at 0): LOAN JPY 30,000,000 at 1.2 %, `payment_amount` 125,000 (base
     * 120,000 plus a standing extra of 5,000): P 90,000, I 30,000, E 5,000,
     * T 125,000, B 120,000, `tol` 5.
     */
    const yenWithExtra = (debt?: number) =>
      makeFacts({
        account: annuityAccount({
          currencyCode: "JPY",
          interestRate: 1.2,
          paymentAmount: 125000,
          openingBalance: -30000000,
        }),
        principal: 90000,
        interest: 30000,
        extra: 5000,
        debt,
      });

    it.each([
      ["row 1", -125000, {}, [90000, 30000, 5000, "exact"]],
      ["row 2", -125004, {}, [90000, 30004, 5000, "tolerance"]],
      ["row 3", -125006, {}, [90000, 30000, 5006, "extra_principal"]],
      ["row 5", -125006, { excess: "refuse" }, "installment_amount_excess"],
      ["row 6", -122000, {}, [90000, 30000, 2000, "extra_shed"]],
      ["row 7", -119997, {}, [90000, 29997, 0, "tolerance"]],
      ["row 8", -119000, {}, "installment_amount_shortfall"],
      [
        "row 9",
        -119000,
        { shortfall: "interest_first" },
        [89000, 30000, 0, "interest_first"],
      ],
    ] as Array<[string, number, Partial<LoanSettlementAction>, unknown]>)(
      "section 8 at 0 decimals, %s: a row of %p gives %p",
      (_name, amount, overrides, expected) => {
        expect(
          lines(
            plan(amount, yenWithExtra(), overrides, { currencyCode: "JPY" }),
          ),
        ).toEqual(expected);
      },
    );

    it("section 8 at 0 decimals, row 4: an excess beyond the debt is refused", () => {
      // debtBefore 95,000: interest 95, principal clamped to 95,000, the extra
      // shed, T 95,095; 95,200 would retire more than is owed.
      expect(
        plan(-95200, yenWithExtra(95000), {}, { currencyCode: "JPY" }),
      ).toEqual({
        ok: false,
        reason: "installment_amount_excess",
        detail: {
          dueDate: "2024-01-01",
          expected: 95095,
          paid: 95200,
          debtBefore: 95000,
        },
      });
    });

    it("E13: JPY books whole yen and the tolerance is 5 yen", () => {
      expect(lines(plan(-120004, yen(), {}, { currencyCode: "JPY" }))).toEqual([
        90000,
        30004,
        0,
        "tolerance",
      ]);
    });

    it("E14: 6 yen above the total is extra principal", () => {
      expect(lines(plan(-120006, yen(), {}, { currencyCode: "JPY" }))).toEqual([
        90000,
        30000,
        6,
        "extra_principal",
      ]);
    });

    it("E15: a debt below 0.01 is retired, a known zero and not a missing figure", () => {
      expect(plan(-1333.33, makeFacts({ debt: 0.004 }))).toEqual({
        ok: false,
        reason: "loan_debt_retired",
        detail: { dueDate: "2024-01-01" },
      });
    });

    it("E15 boundary: 0.0099 is retired, 0.01 and 0.02 are owed", () => {
      expect(plan(-1333.33, makeFacts({ debt: 0.0099 }))).toEqual({
        ok: false,
        reason: "loan_debt_retired",
        detail: { dueDate: "2024-01-01" },
      });
      for (const debt of [0.01, 0.02]) {
        const result = plan(-debt, makeFacts({ debt }));
        expect(
          result.ok === false && result.reason === "loan_debt_retired",
        ).toBe(false);
      }
    });

    it("E16: a tolerance that would make interest negative falls to the extra (row 6)", () => {
      // `accounts.payment_amount` holds the installment total, extra included
      // (LoanPaymentSetupService): base 500.00 plus the standing 100.00.
      const facts = makeFacts({
        account: annuityAccount({ interestRate: 0, paymentAmount: 600 }),
        principal: 500,
        interest: 0,
        extra: 100,
      });
      expect(lines(plan(-599.97, facts))).toEqual([
        500,
        0,
        99.97,
        "extra_shed",
      ]);
      expect(planned(plan(-600, facts)).booked).toEqual({
        principal: 500,
        interest: 0,
        extra: 100,
        total: 600,
      });
    });
  });

  describe("9.4 the fold in one pass (INV-RULE-005)", () => {
    const first: PriorSettlement = {
      loanAccountId: loanId,
      rowDate: "2024-01-03",
      dueDate: "2024-01-01",
      principal: 833.33,
      extraPrincipal: 200,
    };

    it("prices the second row on the ledger less the first row's principal and extra", () => {
      const settlement = planned(
        plan(-1331.61, makeFacts(), {}, { date: "2024-02-02" }, [first]),
      );
      expect(settlement).toMatchObject({
        dueDate: "2024-02-01",
        debtLedger: 300000,
        foldedPrincipal: 1033.33,
        debtBefore: 298966.67,
        principal: 833.33,
        interest: 498.28,
        outcome: "exact",
      });
    });

    it("without the fold the second row would be refused as a shortfall", () => {
      expect(
        lines(plan(-1331.61, makeFacts(), {}, { date: "2024-02-02" })),
      ).toBe("installment_amount_shortfall");
    });

    it("excludes a prior whose row is dated after the slot: its leg is outside the slot's ledger", () => {
      const later: PriorSettlement = {
        ...first,
        rowDate: "2024-02-05",
        dueDate: "2024-03-01",
      };
      const settlement = planned(
        plan(-1333.33, makeFacts(), {}, { date: "2024-02-02" }, [later]),
      );
      expect(settlement).toMatchObject({
        dueDate: "2024-02-01",
        foldedPrincipal: 0,
        debtBefore: 300000,
      });
    });

    it("includes a prior dated on the slot itself (on or before)", () => {
      const onSlot: PriorSettlement = {
        ...first,
        rowDate: "2024-02-01",
        dueDate: "2024-01-01",
      };
      expect(
        planned(
          plan(-1331.61, makeFacts(), {}, { date: "2024-02-02" }, [onSlot]),
        ).foldedPrincipal,
      ).toBe(1033.33);
    });

    it("ignores a prior on another loan", () => {
      const other: PriorSettlement = {
        ...first,
        loanAccountId: "acc-other-loan",
      };
      expect(
        planned(
          plan(-1333.33, makeFacts(), {}, { date: "2024-02-02" }, [other]),
        ).foldedPrincipal,
      ).toBe(0);
    });

    it("treats a prior's slot as claimed (6.3 row 9)", () => {
      expect(
        plan(-1333.33, makeFacts(), {}, { date: "2024-01-05" }, [first]),
      ).toEqual({
        ok: false,
        reason: "occurrence_already_posted",
        detail: { dueDates: ["2024-01-01"] },
      });
    });
  });

  describe("section 8: the table is total and the lines always sum to what was paid", () => {
    const cases: Array<[string, () => LoanSettlementFacts, string, number]> = [
      ["LINEAR EUR", () => makeFacts(), "EUR", 1333.33],
      [
        "LINEAR EUR with extra",
        () => makeFacts({ extra: 100 }),
        "EUR",
        1433.33,
      ],
      [
        "ANNUITY 0 % EUR with extra",
        () =>
          makeFacts({
            account: annuityAccount({ interestRate: 0, paymentAmount: 600 }),
            principal: 500,
            interest: 0,
            extra: 100,
          }),
        "EUR",
        600,
      ],
      [
        "LOAN JPY",
        () =>
          makeFacts({
            account: annuityAccount({
              currencyCode: "JPY",
              interestRate: 1.2,
              paymentAmount: 120000,
              openingBalance: -30000000,
            }),
            principal: 90000,
            interest: 30000,
          }),
        "JPY",
        120000,
      ],
    ];
    const policies: Array<Pick<LoanSettlementAction, "excess" | "shortfall">> =
      [
        { excess: "extra_principal", shortfall: "refuse" },
        { excess: "extra_principal", shortfall: "interest_first" },
        { excess: "refuse", shortfall: "refuse" },
        { excess: "refuse", shortfall: "interest_first" },
      ];

    it.each(cases)("%s", (_name, facts, currency, total) => {
      const unit = currency === "JPY" ? 1 : 0.01;
      const offsets = [
        -250, -101, -100, -99, -50, -6, -5, -4, -3, -1, 0, 1, 3, 5, 6, 50, 100,
        250,
      ];
      for (const policy of policies) {
        for (const offset of offsets) {
          const paid = Math.round((total + offset * unit) / unit) * unit;
          const result = plan(-paid, facts(), policy, {
            currencyCode: currency,
          });
          if (!result.ok) {
            expect([
              "installment_amount_excess",
              "installment_amount_shortfall",
            ]).toContain(result.reason);
            continue;
          }
          const { settlement, structure } = result;
          expect(
            sumMoney([
              settlement.principal,
              settlement.interest,
              settlement.extraPrincipal,
            ]),
          ).toBe(settlement.paid);
          expect(sumMoney(structure.parts.map((p) => p.amount))).toBe(
            -settlement.paid,
          );
          expect(structure.parts.length).toBe(
            settlement.extraPrincipal > 0 ? 3 : 2,
          );
          expect(settlement.interest).toBeGreaterThanOrEqual(0);
          expect(settlement.principal).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("the policy on scaled integers, row by row", () => {
      const booked = {
        principal: 83333,
        interest: 50000,
        extra: 10000,
        total: 143333,
      };
      const defaults = {
        excess: "extra_principal",
        shortfall: "refuse",
      } as const;
      const at = (
        paid: number,
        policy: Pick<LoanSettlementAction, "excess" | "shortfall"> = defaults,
      ) => applyAmountPolicy(paid, booked, 5, 30000000, policy);
      expect(at(143333)).toMatchObject({
        kind: "lines",
        lines: { outcome: "exact" },
      });
      expect(at(143338)).toMatchObject({
        lines: { interest: 50005, outcome: "tolerance", toleranceApplied: 5 },
      });
      expect(at(143339)).toMatchObject({
        lines: { extra: 10006, outcome: "extra_principal" },
      });
      expect(at(143339, { excess: "refuse", shortfall: "refuse" })).toEqual({
        kind: "excess",
      });
      expect(applyAmountPolicy(143339, booked, 5, 93338, defaults)).toEqual({
        kind: "excess",
      });
      expect(at(140000)).toMatchObject({
        lines: { extra: 6667, outcome: "extra_shed" },
      });
      expect(at(133333)).toMatchObject({
        lines: { extra: 0, interest: 50000, outcome: "extra_shed" },
      });
      expect(at(133330)).toMatchObject({
        lines: {
          interest: 49997,
          extra: 0,
          outcome: "tolerance",
          toleranceApplied: -3,
        },
      });
      expect(at(133327)).toEqual({ kind: "shortfall" });
      expect(
        at(133327, { excess: "extra_principal", shortfall: "interest_first" }),
      ).toMatchObject({
        lines: {
          principal: 83327,
          interest: 50000,
          extra: 0,
          outcome: "interest_first",
        },
      });
      expect(
        at(40000, { excess: "extra_principal", shortfall: "interest_first" }),
      ).toMatchObject({
        lines: { principal: 0, interest: 40000, extra: 0 },
      });
    });

    it("the tolerance constant is five minor units", () => {
      expect(LOAN_SETTLEMENT_TOLERANCE_MINOR_UNITS).toBe(5);
    });
  });

  describe("sections 10 and 11: the refusals, in order", () => {
    const unavailable = { kind: "unavailable", reason: "gone" } as const;

    it("5 zero_amount", () => {
      expect(plan(0)).toEqual({ ok: false, reason: "zero_amount" });
      expect(plan(Number.NaN)).toEqual({ ok: false, reason: "zero_amount" });
    });

    it("6 transfer_same_account, before anything about the loan is read", () => {
      expect(plan(-1333.33, unavailable, {}, { accountId: loanId })).toEqual({
        ok: false,
        reason: "transfer_same_account",
      });
      expect(plan(1333.33, makeFacts(), {}, { accountId: loanId })).toEqual({
        ok: false,
        reason: "transfer_same_account",
      });
    });

    it("8 transfer_currency_mismatch", () => {
      expect(plan(-1333.33, makeFacts(), {}, { currencyCode: "USD" })).toEqual({
        ok: false,
        reason: "transfer_currency_mismatch",
      });
      expect(plan(-1333.33, makeFacts(), {}, { currencyCode: "eur" }).ok).toBe(
        true,
      );
    });

    it("9 row_from_scheduled_posting: the server-set option, or a claim of either source naming the row", () => {
      expect(
        plan(-1333.33, unavailable, {}, { fromScheduledPosting: true }),
      ).toEqual({
        ok: false,
        reason: "row_from_scheduled_posting",
      });
      const facts = makeFacts({
        claims: [claim("2024-01-01", { transactionId: "tx-row" })],
      });
      expect(plan(-1333.33, facts)).toEqual({
        ok: false,
        reason: "row_from_scheduled_posting",
      });
      // A post claim on another schedule, found by the row's id.
      expect(plan(-1333.33, makeFacts({ postedRowIds: ["tx-row"] }))).toEqual({
        ok: false,
        reason: "row_from_scheduled_posting",
      });
      expect(plan(-1333.33, makeFacts({ postedRowIds: ["tx-other"] })).ok).toBe(
        true,
      );
      // A rule's claim naming this row (a settlement edited down to one line,
      // spec section 15 item 9): the row already pays an occurrence, refused
      // before the claim's INSERT could conflict on the per-transaction index.
      expect(
        plan(
          -1333.33,
          makeFacts({
            claims: [
              claim("2024-01-01", { source: "rule", transactionId: "tx-row" }),
            ],
          }),
        ),
      ).toEqual({ ok: false, reason: "row_from_scheduled_posting" });
      // A rule's claim naming another row is an ordinary occupied slot.
      const other = makeFacts({
        claims: [
          claim("2024-01-01", { source: "rule", transactionId: "tx-other" }),
        ],
      });
      expect(plan(-1333.33, other).ok).toBe(false);
      expect((plan(-1333.33, other) as { reason: string }).reason).toBe(
        "occurrence_already_posted",
      );
    });

    it("10 row_is_income, before the loan is checked", () => {
      expect(plan(1333.33, unavailable)).toEqual({
        ok: false,
        reason: "row_is_income",
      });
      expect(plan(1333.33)).toEqual({ ok: false, reason: "row_is_income" });
    });

    it("11 loan_account_unavailable: facts that could not be read, a LINE_OF_CREDIT, a closed loan", () => {
      expect(plan(-1333.33, unavailable)).toEqual({
        ok: false,
        reason: "loan_account_unavailable",
      });
      expect(
        plan(
          -1333.33,
          makeFacts({
            account: linearAccount({
              accountType: AccountType.LINE_OF_CREDIT,
              interestBookingMode: "SEPARATE",
            }),
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "loan_account_unavailable",
        detail: { accountType: "LINE_OF_CREDIT" },
      });
      expect(
        plan(
          -1333.33,
          makeFacts({ account: linearAccount({ isClosed: true }) }),
        ),
      ).toEqual({
        ok: false,
        reason: "loan_account_unavailable",
        detail: { accountType: "MORTGAGE" },
      });
    });

    it("12 loan_interest_booked_separately, before any configuration is checked", () => {
      expect(
        plan(
          -1333.33,
          makeFacts({
            account: linearAccount({
              interestBookingMode: "SEPARATE",
              interestCategoryId: null,
            }),
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "loan_interest_booked_separately",
      });
    });

    describe("13 loan_not_configured, naming every missing static input", () => {
      it("no scheduled payment", () => {
        const facts = { ...makeFacts(), schedule: null, splits: [], slots: [] };
        expect(plan(-1333.33, facts)).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: { missing: ["scheduledPayment"] },
        });
      });

      it("a template line beyond principal, interest and extra principal", () => {
        const base = makeFacts();
        const facts = {
          ...base,
          splits: [
            ...base.splits,
            {
              id: "split-escrow",
              transferAccountId: null,
              categoryId: "cat-escrow",
              amount: -200,
              memo: "Escrow",
            } as unknown as ScheduledTransactionSplit,
          ],
        };
        expect(plan(-1533.33, facts)).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: { missing: ["managedTemplate"] },
        });
      });

      it("a schedule whose cadence is not the loan's (6.3 row 18)", () => {
        expect(
          plan(-1333.33, makeFacts({ schedule: { frequency: "BIWEEKLY" } })),
        ).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: { missing: ["scheduleCalendar"] },
        });
      });

      it("no interest category on the action or the loan", () => {
        expect(
          plan(
            -1333.33,
            makeFacts({ account: linearAccount({ interestCategoryId: null }) }),
          ),
        ).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: { missing: ["interestCategory"] },
        });
        expect(
          plan(
            -1333.33,
            makeFacts({ account: linearAccount({ interestCategoryId: null }) }),
            { interestCategoryId: "cat-rente" },
          ).ok,
        ).toBe(true);
      });

      it("a LINEAR term (missingMethodTerms)", () => {
        expect(
          plan(
            -1333.33,
            makeFacts({ account: linearAccount({ amortizationMonths: null }) }),
          ),
        ).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: { missing: ["amortizationMonths"] },
        });
        expect(
          plan(
            -1333.33,
            makeFacts({
              account: linearAccount({
                paymentStartDate: null,
                originalPrincipal: null,
                openingBalance: 0,
              }),
            }),
          ),
        ).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: { missing: ["paymentStartDate", "originalPrincipal"] },
        });
      });

      it("an unknown cadence on an annuity is not 12 periods (decision 16)", () => {
        expect(
          plan(
            -1500,
            makeFacts({
              account: annuityAccount({ paymentFrequency: "FORTNIGHTLY" }),
              principal: 500,
              interest: 1000,
            }),
          ),
        ).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: { missing: ["paymentFrequency"] },
        });
      });

      it("an annuity with no stored cadence takes the schedule's", () => {
        expect(
          plan(
            -1500,
            makeFacts({
              account: annuityAccount({ paymentFrequency: null }),
              principal: 500,
              interest: 1000,
            }),
          ).ok,
        ).toBe(true);
      });

      it("names every missing input at once, each once", () => {
        const facts = {
          ...makeFacts({
            account: linearAccount({
              interestCategoryId: null,
              amortizationMonths: null,
              paymentFrequency: null,
            }),
          }),
          schedule: null,
          splits: [],
          slots: [],
        };
        expect(plan(-1333.33, facts)).toEqual({
          ok: false,
          reason: "loan_not_configured",
          detail: {
            missing: [
              "scheduledPayment",
              "interestCategory",
              "amortizationMonths",
              "paymentFrequency",
            ],
          },
        });
      });
    });

    it("14 no_installment_in_window, naming the window (6.3 row 4)", () => {
      expect(plan(-1333.33, makeFacts(), {}, { date: "2024-01-09" })).toEqual({
        ok: false,
        reason: "no_installment_in_window",
        detail: { windowFrom: "2024-01-02", windowTo: "2024-01-12" },
      });
    });

    it("15 occurrence_already_posted, naming the taken slots (6.3 row 7)", () => {
      expect(
        plan(
          -1333.33,
          makeFacts({ claims: [claim("2024-01-01")] }),
          {},
          { date: "2024-01-05" },
        ),
      ).toEqual({
        ok: false,
        reason: "occurrence_already_posted",
        detail: { dueDates: ["2024-01-01"] },
      });
    });

    it("16 loan_not_configured for a dated input: a missing rate is unknown, not 0 %", () => {
      expect(
        plan(
          -1333.33,
          makeFacts({ account: linearAccount({ interestRate: null }) }),
        ),
      ).toEqual({
        ok: false,
        reason: "loan_not_configured",
        detail: { missing: ["rate"], dueDate: "2024-01-01" },
      });
      // A rate recorded only after the slot does not apply to it.
      const later = [
        { effectiveDate: "2024-02-01", annualRate: 2, newPaymentAmount: null },
      ] as unknown as LoanRateChange[];
      expect(
        plan(
          -1333.33,
          makeFacts({
            account: linearAccount({ interestRate: null }),
            rateChanges: later,
          }),
        ),
      ).toMatchObject({
        reason: "loan_not_configured",
        detail: { missing: ["rate"], dueDate: "2024-01-01" },
      });
      expect(
        plan(
          -1333.33,
          makeFacts({
            account: linearAccount({ interestRate: null }),
            rateChanges: later,
          }),
          {},
          { date: "2024-02-02" },
        ).ok,
      ).toBe(true);
    });

    it("16 a missing annuity payment is not the template's amount", () => {
      expect(
        plan(
          -1500,
          makeFacts({
            account: annuityAccount({ paymentAmount: null }),
            principal: 500,
            interest: 1000,
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "loan_not_configured",
        detail: { missing: ["payment"], dueDate: "2024-01-01" },
      });
      expect(
        plan(
          -1500,
          makeFacts({
            account: annuityAccount({
              paymentAmount: null,
              interestRate: null,
            }),
            principal: 500,
            interest: 1000,
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "loan_not_configured",
        detail: { missing: ["rate", "payment"], dueDate: "2024-01-01" },
      });
    });

    it("a recorded 0 % is a rate, not a missing one", () => {
      const zero = [
        { effectiveDate: "2024-01-01", annualRate: 0, newPaymentAmount: null },
      ] as unknown as LoanRateChange[];
      const settlement = planned(
        plan(
          -833.33,
          makeFacts({
            account: linearAccount({ interestRate: null }),
            rateChanges: zero,
          }),
        ),
      );
      expect([settlement.annualRate, settlement.interest]).toEqual([0, 0]);
    });

    it("17 loan_debt_retired, after the dated inputs and before the amount policy", () => {
      expect(
        plan(
          -1333.33,
          makeFacts({
            account: linearAccount({ interestRate: null }),
            debt: 0,
          }),
        ),
      ).toMatchObject({
        reason: "loan_not_configured",
      });
      expect(plan(-1333.33, makeFacts({ debt: 0 }))).toEqual({
        ok: false,
        reason: "loan_debt_retired",
        detail: { dueDate: "2024-01-01" },
      });
      // A debt the fold retires is retired too.
      const prior: PriorSettlement = {
        loanAccountId: loanId,
        rowDate: "2024-01-02",
        dueDate: "2024-01-01",
        principal: 1000,
        extraPrincipal: 0,
      };
      expect(
        plan(-5, makeFacts({ debt: 1000 }), {}, { date: "2024-02-02" }, [
          prior,
        ]),
      ).toMatchObject({ reason: "loan_debt_retired" });
      // A fold that leaves one whole minor unit (0.01) leaves it owed.
      expect(
        plan(-5, makeFacts({ debt: 1000 }), {}, { date: "2024-02-02" }, [
          { ...prior, principal: 999.99 },
        ]),
      ).not.toMatchObject({ reason: "loan_debt_retired" });
    });

    it("an unread ledger at the slot is loan_account_unavailable", () => {
      const facts = {
        ...makeFacts(),
        debtByDueDate: new Map<string, number>(),
      };
      expect(plan(-1333.33, facts)).toEqual({
        ok: false,
        reason: "loan_account_unavailable",
        detail: { dueDate: "2024-01-01" },
      });
    });

    it("the configuration is refused before the window is looked at", () => {
      expect(
        plan(
          -1333.33,
          makeFacts({ account: linearAccount({ interestCategoryId: null }) }),
          {},
          { date: "2024-01-09" },
        ),
      ).toMatchObject({
        reason: "loan_not_configured",
      });
    });
  });

  /**
   * The dated annuity payment at the matched slot (decision 12; the pricing
   * spec's section 7.2 and the settlement rows S1 to S3 after its table
   * 7.4), on that spec's fixture 5.1: ANNUITY, 100,000.00 over 300 monthly
   * payments from 2023-02-03, 584.59 at 5.0 %, Timeline A 4.5 % / 560.00
   * effective 2023-04-15, each slot before the matched one posted on its
   * due date. The rule itself (`datedAnnuityPayment`) is asserted once, in
   * `price-installment.spec.ts`, for every caller.
   */
  describe("the dated annuity payment at the slot (decision 12, pricing spec 7.4 S1 to S3)", () => {
    const fixtureAccount = (overrides: Partial<Account> = {}): Account =>
      linearAccount({
        mortgageType: "ANNUITY",
        interestRate: 5,
        paymentAmount: 584.59,
        paymentStartDate: "2023-02-03" as unknown as Date,
        amortizationMonths: 300,
        originalPrincipal: 100000,
        openingBalance: -100000,
        currentBalance: -100000,
        ...overrides,
      });
    const rateRow = (
      effectiveDate: string,
      annualRate: number,
      newPaymentAmount: number | null,
      source: "initial" | "manual" = "manual",
    ) =>
      ({
        effectiveDate,
        annualRate,
        newPaymentAmount,
        source,
      }) as unknown as LoanRateChange;
    const timelineA = (initialPayment = 584.59) => [
      rateRow("2023-02-03", 5, initialPayment, "initial"),
      rateRow("2023-04-15", 4.5, 560),
    ];
    const atSlot = (
      slot: string,
      debt: number,
      overrides: Partial<Parameters<typeof makeFacts>[0]> = {},
    ) =>
      makeFacts({
        account: fixtureAccount(),
        principal: 169.33,
        interest: 415.26,
        rateChanges: timelineA(),
        schedule: { startDate: "2023-02-03", nextDueDate: slot },
        range: { from: "2023-01-01", to: "2025-12-31" },
        debt: { [slot]: debt },
        ...overrides,
      });

    it("S1: the slot before the change prices the initial row's 584.59", () => {
      const settlement = planned(
        plan(
          -584.59,
          atSlot("2023-04-03", 99663.46),
          {},
          { date: "2023-04-03" },
        ),
      );
      expect(settlement).toMatchObject({
        dueDate: "2023-04-03",
        installmentNumber: 3,
        debtBefore: 99663.46,
        annualRate: 5,
        principal: 169.33,
        interest: 415.26,
        extraPrincipal: 0,
        outcome: "exact",
      });
    });

    it("S2: the first slot the change applies to prices the stated 560.00", () => {
      const settlement = planned(
        plan(-560, atSlot("2023-05-03", 99494.13), {}, { date: "2023-05-03" }),
      );
      expect(settlement).toMatchObject({
        dueDate: "2023-05-03",
        installmentNumber: 4,
        debtBefore: 99494.13,
        annualRate: 4.5,
        principal: 186.9,
        interest: 373.1,
        extraPrincipal: 0,
        outcome: "exact",
      });
      // The same slot paid at the old 584.59 is money above the priced total.
      expect(
        lines(
          plan(
            -584.59,
            atSlot("2023-05-03", 99494.13),
            {},
            { date: "2023-05-03" },
          ),
        ),
      ).toEqual([186.9, 373.1, 24.59, "extra_principal"]);
    });

    it("S3: a stated base takes the standing extra of 50.00 on top", () => {
      const settlement = planned(
        plan(
          -610,
          atSlot("2023-05-03", 99343.51, {
            account: fixtureAccount({
              paymentAmount: 634.59,
              extraPaymentAmount: 50,
            }),
            extra: 50,
            rateChanges: timelineA(634.59),
          }),
          {},
          { date: "2023-05-03" },
        ),
      );
      expect(settlement).toMatchObject({
        debtBefore: 99343.51,
        principal: 187.46,
        interest: 372.54,
        extraPrincipal: 50,
        outcome: "exact",
      });
    });

    it("Timeline B: the 2024-06-03 slot prices the stated 557.00 (table 5.3, row 17)", () => {
      const settlement = planned(
        plan(
          -557,
          atSlot("2024-06-03", 97227.62, {
            rateChanges: [
              rateRow("2023-02-03", 5, 584.59, "initial"),
              rateRow("2024-05-15", 4.5, 557),
              rateRow("2025-06-15", 4.0, 531.1),
            ],
          }),
          {},
          { date: "2024-06-03" },
        ),
      );
      expect(settlement).toMatchObject({
        installmentNumber: 17,
        debtBefore: 97227.62,
        annualRate: 4.5,
        principal: 192.4,
        interest: 364.6,
        outcome: "exact",
      });
    });
  });

  describe("pricingColumn (spec section 5.3)", () => {
    it("is the plan minus its policy and cursor flag, in the canonical key order, money as strings", () => {
      const first: PriorSettlement = {
        loanAccountId: loanId,
        rowDate: "2024-01-03",
        dueDate: "2024-01-01",
        principal: 833.33,
        extraPrincipal: 200,
      };
      const settlement = planned(
        plan(-1331.61, makeFacts(), {}, { date: "2024-02-02" }, [first]),
      );
      const record = pricingColumn(settlement);
      expect(record).toEqual({
        version: 1,
        dueDate: "2024-02-01",
        installmentNumber: 2,
        method: "LINEAR",
        prepaymentMode: "SHORTEN_TERM",
        currencyCode: "EUR",
        debtLedger: "300000.0000",
        foldedPrincipal: "1033.3300",
        debtBefore: "298966.6700",
        annualRate: "2",
        periodicRate: 0.0016666666666666668,
        priced: {
          principal: "833.3333",
          interest: "498.2778",
          extra: "0.0000",
          total: "1331.6111",
        },
        booked: {
          principal: "833.33",
          interest: "498.28",
          extra: "0.00",
          total: "1331.61",
        },
        paid: "1331.61",
        difference: "0.00",
        outcome: "exact",
        lines: { principal: "833.33", interest: "498.28", extra: "0.00" },
      });
      expect(Object.keys(record)).toEqual([
        "version",
        "dueDate",
        "installmentNumber",
        "method",
        "prepaymentMode",
        "currencyCode",
        "debtLedger",
        "foldedPrincipal",
        "debtBefore",
        "annualRate",
        "periodicRate",
        "priced",
        "booked",
        "paid",
        "difference",
        "outcome",
        "lines",
      ]);
      expect(record).not.toHaveProperty("policy");
      expect(record).not.toHaveProperty("advancesCursor");
    });

    it("prints the booked, paid and written figures at the currency's unit", () => {
      const facts = makeFacts({
        account: annuityAccount({
          currencyCode: "JPY",
          interestRate: 1.2,
          paymentAmount: 120000,
          openingBalance: -30000000,
        }),
        principal: 90000,
        interest: 30000,
      });
      const record = pricingColumn(
        planned(plan(-120004, facts, {}, { currencyCode: "JPY" })),
      );
      expect(record).toMatchObject({
        method: "LOAN",
        prepaymentMode: null,
        currencyCode: "JPY",
        debtLedger: "30000000.0000",
        priced: { total: "120000.0000" },
        booked: { total: "120000" },
        paid: "120004",
        difference: "4",
        outcome: "tolerance",
        lines: { principal: "90000", interest: "30004", extra: "0" },
      });
    });
  });
});
