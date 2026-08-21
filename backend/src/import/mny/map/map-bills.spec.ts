import { AccountSubType } from "../../../accounts/entities/account.entity";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import {
  billData,
  investmentData,
  mnyBill,
  mnyInvestmentDetail,
  mnyPayee,
  mnySecurity,
  mnySplit,
  mnyTransaction,
  mnyTransfer,
  transactionData,
} from "../__fixtures__/mny-row-builders";
import { MappedAccounts, MappedSecurities } from "../model/mny-import-model";
import { mapSecurities } from "./map-securities";
import {
  BILL_FUTURE_HORIZON_DAYS,
  MapBillsInput,
  billReferences,
  mapBills,
  selectedBills,
  shiftIsoDate,
} from "./map-bills";

/** The cut-off every horizon in these specs is measured from. */
const AS_OF = "2026-07-30";

/** Banking accounts 1, 2 and a loan account 9, plus a brokerage pair 10/11. */
function accountsFixture(): MappedAccounts {
  const banking = [1, 2, 9].map((handle) => ({
    key: `acct-${handle}`,
    handle,
    name: `Account ${handle}`,
    moneyName: `Account ${handle}`,
    accountType: "CHEQUING" as never,
    accountSubType: null,
    currencyCode: "USD",
    openingBalance: 0,
    creditLimit: null,
    closed: false,
    closedDate: null,
    favourite: false,
    excludeFromNetWorth: false,
    description: null,
    linkedKey: null,
  }));
  const pair = [
    {
      key: "acct-11",
      handle: 11,
      name: "Brokerage - Cash",
      moneyName: "Brokerage (Cash)",
      accountType: "INVESTMENT" as never,
      accountSubType: AccountSubType.INVESTMENT_CASH,
      currencyCode: "USD",
      openingBalance: 0,
      creditLimit: null,
      closed: false,
      closedDate: null,
      favourite: false,
      excludeFromNetWorth: false,
      description: null,
      linkedKey: "acct-10",
    },
    {
      key: "acct-10",
      handle: 10,
      name: "Brokerage - Investments",
      moneyName: "Brokerage",
      accountType: "INVESTMENT" as never,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      currencyCode: "USD",
      openingBalance: 0,
      creditLimit: null,
      closed: false,
      closedDate: null,
      favourite: false,
      excludeFromNetWorth: false,
      description: null,
      linkedKey: "acct-11",
    },
  ];
  const accounts = [...banking, ...pair];

  return {
    baseCurrency: "USD",
    currencyCodes: ["USD"],
    accounts,
    keyByHandle: new Map(accounts.map((a) => [a.handle as number, a.key])),
    currencyByHandle: new Map(
      accounts.map((a) => [a.handle as number, a.currencyCode]),
    ),
    skipped: 0,
    warnings: [],
  };
}

function securitiesFixture(): MappedSecurities {
  return mapSecurities({
    securities: [mnySecurity({ handle: 1, symbol: "VOO" })],
    currencyByHandle: new Map(),
    baseCurrency: "USD",
    activeHandles: new Set([1]),
  });
}

function input(overrides: Partial<MapBillsInput> = {}): MapBillsInput {
  return {
    bills: billData(),
    transactions: transactionData(),
    investments: investmentData(),
    accounts: accountsFixture(),
    securities: securitiesFixture(),
    payees: [],
    asOf: AS_OF,
    ...overrides,
  };
}

/** A recurrence template `TRN` row -- `frq != -1`, never a posting. */
function template(overrides: Parameters<typeof mnyTransaction>[0] = {}) {
  return mnyTransaction({ frequency: 3, date: null, ...overrides });
}

describe("shiftIsoDate", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftIsoDate("2026-02-27", 2)).toBe("2026-03-01");
    expect(shiftIsoDate("2026-07-30", 0)).toBe("2026-07-30");
  });
});

describe("mapBills", () => {
  it("reports a Money 2001 file as unsupported rather than empty", () => {
    const result = mapBills(
      input({ bills: billData({ supported: false, bills: [] }) }),
    );

    expect(result.supported).toBe(false);
    expect(result.bills).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  describe("active-series detection", () => {
    it("reduces an accumulation of instance rows to one candidate per live series -- the 1,844-rows scenario", () => {
      // Two live series, each with years of past instances; one dead series
      // whose last instance is long past. PR #192 imported every row.
      const rows = [
        // Series 100: monthly hydro bill, 24 past instances + the next one.
        ...Array.from({ length: 24 }, (unused, index) =>
          mnyBill({
            handle: 100 + index,
            series: 100,
            instance: index,
            nextDue: shiftIsoDate(AS_OF, -30 * (index + 1)),
            templateTransaction: 500,
          }),
        ),
        mnyBill({
          handle: 199,
          series: 100,
          instance: 24,
          nextDue: shiftIsoDate(AS_OF, 5),
          templateTransaction: 500,
        }),
        // Series 200: rent, one upcoming instance.
        mnyBill({
          handle: 200,
          series: 200,
          nextDue: shiftIsoDate(AS_OF, 1),
          templateTransaction: 501,
        }),
        // Series 300: dead for two years.
        mnyBill({
          handle: 300,
          series: 300,
          nextDue: shiftIsoDate(AS_OF, -730),
          templateTransaction: 502,
        }),
      ];
      const result = mapBills(
        input({
          bills: billData({ bills: rows }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1, amount: -120 }),
              template({ handle: 501, account: 1, amount: -1500 }),
              template({ handle: 502, account: 1, amount: -60 }),
            ],
          }),
        }),
      );

      expect(result.seriesInFile).toBe(3);
      expect(result.bills.map((bill) => bill.handle).sort()).toEqual([
        199, 200,
      ]);
      expect(result.skipped).toBe(0);
    });

    it("picks the earliest instance still due on or after the cut-off", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 1,
                series: 50,
                nextDue: shiftIsoDate(AS_OF, 40),
                templateTransaction: 500,
              }),
              mnyBill({
                handle: 2,
                series: 50,
                nextDue: shiftIsoDate(AS_OF, 10),
                templateTransaction: 500,
              }),
              mnyBill({
                handle: 3,
                series: 50,
                nextDue: shiftIsoDate(AS_OF, -20),
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1, amount: -80 })],
          }),
        }),
      );

      expect(result.bills).toHaveLength(1);
      expect(result.bills[0].handle).toBe(2);
      expect(result.bills[0].nextDueDate).toBe(shiftIsoDate(AS_OF, 10));
    });

    it("keeps a recently-overdue series and drops one past the grace period", () => {
      // A monthly series is judged over max(400, 31 + 92) = 400 days. Handle 1
      // is current and so pins the file's present at AS_OF.
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 1, nextDue: AS_OF, templateTransaction: 500 }),
              mnyBill({
                handle: 2,
                nextDue: shiftIsoDate(AS_OF, -BILL_FUTURE_HORIZON_DAYS),
                templateTransaction: 501,
              }),
              mnyBill({
                handle: 3,
                nextDue: shiftIsoDate(AS_OF, -(BILL_FUTURE_HORIZON_DAYS + 1)),
                templateTransaction: 502,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1 }),
              template({ handle: 501, account: 1 }),
              template({ handle: 502, account: 1 }),
            ],
          }),
        }),
      );

      expect(result.bills.map((bill) => bill.handle).sort()).toEqual([1, 2]);
    });

    it("judges a series against its own cadence, not a flat quarter", () => {
      // The defect this guards: a flat 92-day window declared a yearly bill
      // dead 100 days after its last occurrence, when it had missed nothing.
      const yearly = (handle: number, daysAgo: number) =>
        mnyBill({
          handle,
          frequency: 5,
          nextDue: shiftIsoDate(AS_OF, -daysAgo),
          templateTransaction: 500 + handle,
        });

      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 1, nextDue: AS_OF, templateTransaction: 500 }),
              yearly(2, 100),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1 }),
              template({ handle: 502, account: 1 }),
            ],
          }),
        }),
      );

      expect(result.bills.map((bill) => bill.handle)).toContain(2);
    });

    it("measures the horizon from the file's own present, not the clock", () => {
      // A .mny is a snapshot. Judging it against the wall clock meant that the
      // longer a user waited before importing, the fewer bills survived -- and
      // at a quarter old, none did. This file was last used a year ago and its
      // bills are still its bills.
      const lastUsed = shiftIsoDate(AS_OF, -365);
      const result = mapBills(
        input({
          asOf: AS_OF,
          bills: billData({
            bills: [
              mnyBill({
                handle: 1,
                nextDue: lastUsed,
                templateTransaction: 500,
              }),
              mnyBill({
                handle: 2,
                nextDue: shiftIsoDate(lastUsed, -30),
                templateTransaction: 501,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1 }),
              template({ handle: 501, account: 1 }),
            ],
          }),
        }),
      );

      expect(result.bills.map((bill) => bill.handle).sort()).toEqual([1, 2]);
    });

    it("rolls a stale due date forward to the next occurrence", () => {
      // Money's newest instance is where the series stood when the file was
      // last used. Written through unchanged, a monthly bill arrives in Monize
      // a year overdue instead of due next month.
      const result = mapBills(
        input({
          asOf: AS_OF,
          bills: billData({
            bills: [
              mnyBill({
                handle: 1,
                nextDue: shiftIsoDate(AS_OF, -365),
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills[0].frequency).toBe("MONTHLY");
      // The next occurrence, not merely some future date: one cycle's worth of
      // slack and no more. (The shared helper clamps a 30th onto a short
      // February and keeps the earlier day thereafter, which is the
      // scheduler's own behaviour, so the day of month is not asserted.)
      expect(result.bills[0].nextDueDate >= AS_OF).toBe(true);
      expect(result.bills[0].nextDueDate <= shiftIsoDate(AS_OF, 31)).toBe(true);
    });

    it("drops a series whose next due date is implausibly far out", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 1,
                nextDue: shiftIsoDate(AS_OF, BILL_FUTURE_HORIZON_DAYS + 1),
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills).toEqual([]);
    });

    it("drops a series that already ended", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 1,
                nextDue: shiftIsoDate(AS_OF, 10),
                endsOn: shiftIsoDate(AS_OF, -1),
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills).toEqual([]);
    });

    it("ignores a series whose instances carry no date", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [mnyBill({ handle: 1, nextDue: null })],
          }),
        }),
      );

      expect(result.bills).toEqual([]);
      expect(result.skipped).toBe(0);
    });
  });

  describe("template resolution", () => {
    it("maps a plain bill from its template transaction", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 7,
                nextDue: shiftIsoDate(AS_OF, 3),
                endsOn: shiftIsoDate(AS_OF, 200),
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({
                handle: 500,
                account: 1,
                payee: 42,
                category: 60,
                amount: -95.5,
                memo: "Hydro",
              }),
            ],
          }),
          payees: [mnyPayee({ handle: 42, name: "Hydro One" })],
        }),
      );

      expect(result.bills).toHaveLength(1);
      expect(result.bills[0]).toMatchObject({
        handle: 7,
        name: "Hydro One",
        accountKey: "acct-1",
        payeeHandle: 42,
        categoryHandle: 60,
        amount: -95.5,
        currencyCode: "USD",
        frequency: FrequencyType.MONTHLY,
        approximate: false,
        nextDueDate: shiftIsoDate(AS_OF, 3),
        endDate: shiftIsoDate(AS_OF, 200),
        isTransfer: false,
        investment: null,
        splits: [],
      });
    });

    it("falls back to the template memo, then a generated name", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 7,
                nextDue: AS_OF,
                templateTransaction: 500,
              }),
              mnyBill({
                handle: 8,
                series: 8,
                nextDue: AS_OF,
                templateTransaction: 501,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1, memo: "Gym\nsecond line" }),
              template({ handle: 501, account: 1 }),
            ],
          }),
        }),
      );

      const names = result.bills.map((bill) => bill.name).sort();
      expect(names).toEqual(["Bill 8", "Gym"]);
    });

    it("skips and warns when the template transaction is missing", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: null }),
              mnyBill({
                handle: 8,
                series: 8,
                nextDue: AS_OF,
                templateTransaction: 999,
              }),
            ],
          }),
        }),
      );

      expect(result.bills).toEqual([]);
      expect(result.skipped).toBe(2);
      expect(
        result.warnings.filter((w) => w.code === "billTemplateMissing"),
      ).toHaveLength(2);
    });

    it("silently leaves out a bill whose account the user excluded", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            ],
          }),
          transactions: transactionData({
            // Account 77 is not in the import's account map.
            transactions: [template({ handle: 500, account: 77 })],
          }),
        }),
      );

      expect(result.bills).toEqual([]);
      expect(result.skipped).toBe(0);
      expect(result.warnings).toEqual([]);
    });

    it("warns when the template has no account at all", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: null })],
          }),
        }),
      );

      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([
        { code: "unusableBill", subject: "hbill=7", detail: "no account" },
      ]);
    });
  });

  describe("frequency mapping", () => {
    it("maps an exact unit and rate combination to its own type", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 7,
                // Money's "Every three months": the quarterly unit, once each.
                frequency: 4,
                occurrencesPerUnit: 1,
                nextDue: AS_OF,
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills[0].frequency).toBe(FrequencyType.QUARTERLY);
      expect(result.bills[0].approximate).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it("downgrades an unrepresentable rate and warns per bill", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 7,
                frequency: 2,
                occurrencesPerUnit: 3,
                nextDue: AS_OF,
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1, payee: 42 })],
          }),
          payees: [mnyPayee({ handle: 42, name: "Gym" })],
        }),
      );

      // Three times a week is 2.3 days, which no Monize type expresses, so it
      // rounds down to the nearest that still fires at least as often.
      expect(result.bills[0].frequency).toBe(FrequencyType.DAILY);
      expect(result.bills[0].approximate).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: "billFrequencyApproximated",
          subject: "Gym",
          detail: "frq=2 cFrqInst=3",
        },
      ]);
    });

    it("skips and warns on a recurrence code outside the known set", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 7,
                frequency: 99,
                nextDue: AS_OF,
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([
        {
          code: "unusableBill",
          subject: "hbill=7",
          detail: "frq=99 cFrqInst=1",
        },
      ]);
    });

    it("imports a yearly series as YEARLY, not every two months (issue #1150)", () => {
      // The report: a Money Plus Sunset file's annual bills arrived recurring
      // every two months, which is what `frq` 5 mapped to on PR #192's word.
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({
                handle: 7,
                frequency: 5,
                nextDue: AS_OF,
                templateTransaction: 500,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills[0].frequency).toBe(FrequencyType.YEARLY);
      expect(result.bills[0].approximate).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it("takes the cadence from the series' own instances over its code", () => {
      // Instances a year apart are the file saying "yearly" in data. Whatever
      // `BILL.frq` 3 is taken to mean, it does not outrank that.
      const result = mapBills(
        input({
          bills: billData({
            bills: [2022, 2023, 2024, 2025, 2026].map((year, index) =>
              mnyBill({
                handle: 7 + index,
                series: 7,
                instance: index,
                frequency: 3,
                nextDue: `${year}-07-30`,
                templateTransaction: 500,
              }),
            ),
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills).toHaveLength(1);
      expect(result.bills[0].frequency).toBe(FrequencyType.YEARLY);
      expect(result.bills[0].approximate).toBe(false);
    });

    it("keeps a series whose code is unknown but whose instances are regular", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: ["2026-05-30", "2026-06-30", "2026-07-30"].map(
              (nextDue, index) =>
                mnyBill({
                  handle: 7 + index,
                  series: 7,
                  instance: index,
                  frequency: 4,
                  nextDue,
                  templateTransaction: 500,
                }),
            ),
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
        }),
      );

      expect(result.bills).toHaveLength(1);
      expect(result.bills[0].frequency).toBe(FrequencyType.MONTHLY);
      expect(result.skipped).toBe(0);
      expect(result.warnings).toEqual([]);
    });

    it("keeps the approximation flag when the instances agree with the code", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: ["2026-06-18", "2026-07-09", "2026-07-30"].map(
              (nextDue, index) =>
                mnyBill({
                  handle: 7 + index,
                  series: 7,
                  instance: index,
                  frequency: 2,
                  occurrencesPerUnit: 3,
                  nextDue,
                  templateTransaction: 500,
                }),
            ),
          }),
          transactions: transactionData({
            transactions: [template({ handle: 500, account: 1 })],
          }),
          payees: [],
        }),
      );

      // Three-weekly spacing matches no Monize type, so the inference declines
      // and the code's downgrade -- three times a week, rounded down to DAILY
      // and flagged -- stands.
      expect(result.bills[0].frequency).toBe(FrequencyType.DAILY);
      expect(result.bills[0].approximate).toBe(true);
    });
  });

  describe("split templates", () => {
    it("maps template split children, keeping a transfer leg a transfer -- the loan-payment shape", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1, amount: -1000, payee: 42 }),
              // Principal leg: a transfer into the loan account.
              template({ handle: 501, account: 1, amount: -700 }),
              // Interest leg: a category split.
              template({
                handle: 502,
                account: 1,
                amount: -300,
                category: 61,
                memo: "interest",
              }),
              // The loan-side counterpart template.
              template({ handle: 503, account: 9, amount: 700 }),
            ],
            splits: [
              mnySplit({ parent: 500, child: 501, position: 0 }),
              mnySplit({ parent: 500, child: 502, position: 1 }),
            ],
            transfers: [mnyTransfer({ from: 501, to: 503 })],
          }),
          payees: [mnyPayee({ handle: 42, name: "Bank" })],
        }),
      );

      expect(result.bills).toHaveLength(1);
      const bill = result.bills[0];
      expect(bill.categoryHandle).toBeNull();
      expect(bill.isTransfer).toBe(false);
      expect(bill.splits).toEqual([
        {
          kind: SplitKind.TRANSFER,
          categoryHandle: null,
          transferAccountKey: "acct-9",
          amount: -700,
          memo: null,
        },
        {
          kind: SplitKind.CATEGORY,
          categoryHandle: 61,
          transferAccountKey: null,
          amount: -300,
          memo: "interest",
        },
      ]);
    });
  });

  describe("transfer templates", () => {
    it("maps a top-level transfer bill to the counterpart's account", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1, amount: -250 }),
              template({ handle: 501, account: 2, amount: 250 }),
            ],
            transfers: [mnyTransfer({ from: 500, to: 501 })],
          }),
        }),
      );

      expect(result.bills).toHaveLength(1);
      expect(result.bills[0].isTransfer).toBe(true);
      expect(result.bills[0].transferAccountKey).toBe("acct-2");
      expect(result.bills[0].categoryHandle).toBeNull();
    });

    it("keeps one bill when both sides of a transfer pair have BILL rows", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
              mnyBill({
                handle: 8,
                series: 8,
                nextDue: AS_OF,
                templateTransaction: 501,
              }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1, amount: -250 }),
              template({ handle: 501, account: 2, amount: 250 }),
            ],
            transfers: [mnyTransfer({ from: 500, to: 501 })],
          }),
        }),
      );

      // The paying side (negative amount) is the bill.
      expect(result.bills.map((bill) => bill.handle)).toEqual([7]);
      expect(result.bills[0].transferAccountKey).toBe("acct-2");
    });

    it("downgrades to a plain bill when the counterpart account is excluded", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 1, amount: -250, category: 60 }),
              template({ handle: 501, account: 77, amount: 250 }),
            ],
            transfers: [mnyTransfer({ from: 500, to: 501 })],
          }),
        }),
      );

      expect(result.bills[0].isTransfer).toBe(false);
      expect(result.bills[0].transferAccountKey).toBeNull();
      expect(result.bills[0].categoryHandle).toBe(60);
    });
  });

  describe("investment templates", () => {
    it("maps a recurring buy with its TRN_INV detail", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({
                handle: 500,
                account: 10,
                security: 1,
                action: 0,
                amount: -400,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 500,
                quantity: 2,
                price: 200,
                commission: 4.99,
              }),
            ],
          }),
        }),
      );

      expect(result.bills).toHaveLength(1);
      expect(result.bills[0].accountKey).toBe("acct-10");
      expect(result.bills[0].investment).toEqual({
        action: InvestmentAction.BUY,
        securityHandle: 1,
        quantity: 2,
        price: 200,
        commission: 4.99,
      });
      expect(result.bills[0].categoryHandle).toBeNull();
    });

    it("skips and warns on an unknown investment action", () => {
      const result = mapBills(
        input({
          bills: billData({
            bills: [
              mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            ],
          }),
          transactions: transactionData({
            transactions: [
              template({ handle: 500, account: 10, security: 1, action: 42 }),
            ],
          }),
        }),
      );

      expect(result.bills).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(result.warnings[0]).toMatchObject({
        code: "unusableBill",
        detail: "act=42",
      });
    });
  });
});

describe("billReferences and selectedBills", () => {
  it("collects references only from the selected bills", () => {
    const mapped = mapBills(
      input({
        bills: billData({
          bills: [
            mnyBill({ handle: 7, nextDue: AS_OF, templateTransaction: 500 }),
            mnyBill({
              handle: 8,
              series: 8,
              nextDue: AS_OF,
              templateTransaction: 501,
            }),
          ],
        }),
        transactions: transactionData({
          transactions: [
            template({ handle: 500, account: 1, payee: 42, category: 60 }),
            template({ handle: 501, account: 1, payee: 43, category: 61 }),
          ],
        }),
        payees: [
          mnyPayee({ handle: 42, name: "Hydro One" }),
          mnyPayee({ handle: 43, name: "Gym" }),
        ],
      }),
    );

    const kept = selectedBills(mapped, [7]);
    expect(kept.map((bill) => bill.handle)).toEqual([7]);

    const references = billReferences(kept);
    expect([...references.payees]).toEqual([42]);
    expect([...references.categories]).toEqual([60]);
  });
});
