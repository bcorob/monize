import { DataSource } from "typeorm";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
let currentUser: string | null = null;
jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: (userId: string, fn: () => unknown) => {
    currentUser = userId;
    return fn();
  },
}));

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  ACCOUNT_A,
  SECURITY,
  SERIES_1,
  flow,
  lot,
  security,
} from "../test-helpers/bond-valuation-fixtures";
import { NotificationType } from "../notification-center/entities/notification.entity";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { BondHoldingsService } from "./bond-holdings.service";
import { BondNotificationService } from "./bond-notification.service";
import { BondValuationService } from "./bond-valuation.service";
import { BadRequestException } from "@nestjs/common";

const TODAY = "2026-10-13";
// Item 2 reads the valuation as of three days before today.
const WINDOW_START = "2026-10-10";

describe("BondNotificationService", () => {
  let inTransaction: boolean;
  let bookedRows: Array<{ id: string }>;
  let userIds: string[];
  let benchmarkRows: Array<Record<string, unknown>>;
  let failFor: string | null;
  let valueSecurity: jest.Mock;
  let redemptionSplit: jest.Mock;
  let notify: jest.Mock;
  let service: BondNotificationService;
  let manager: ReturnType<typeof createScopedDbMocks>["manager"];
  let order: string[];

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-10-13T10:00:00Z") });
    currentUser = null;
    inTransaction = false;
    bookedRows = [];
    userIds = ["user-1"];
    benchmarkRows = [];
    failFor = null;
    order = [];

    const mocks = createScopedDbMocks([]);
    manager = mocks.manager;
    const dataSource = mocks.dataSource;
    manager.query.mockImplementation((sql: string) => {
      if (/SELECT DISTINCT user_id FROM securities/.test(sql)) {
        return Promise.resolve(userIds.map((user_id) => ({ user_id })));
      }
      if (/FROM user_preferences/.test(sql)) {
        if (currentUser === failFor) {
          return Promise.reject(new Error("preferences unavailable"));
        }
        return Promise.resolve([]);
      }
      if (/FROM securities\s+WHERE user_id/.test(sql)) {
        return Promise.resolve([{ id: SECURITY }]);
      }
      if (/FROM benchmark_values/.test(sql)) {
        return Promise.resolve(benchmarkRows);
      }
      if (/FROM investment_transactions/.test(sql)) {
        return Promise.resolve(bookedRows);
      }
      return Promise.resolve([]);
    });
    const inner = dataSource.transaction.getMockImplementation()!;
    dataSource.transaction.mockImplementation(async (...args: unknown[]) => {
      inTransaction = true;
      try {
        return await (inner as (...a: unknown[]) => unknown)(...args);
      } finally {
        inTransaction = false;
      }
    });

    valueSecurity = jest.fn();
    redemptionSplit = jest.fn();
    notify = jest.fn().mockImplementation(() => {
      order.push(`notify:${inTransaction ? "inside" : "outside"}`);
      return Promise.resolve({ id: "n-1" });
    });
    service = new BondNotificationService(
      dataSource as unknown as DataSource,
      { valueSecurity } as unknown as jest.Mocked<BondValuationService>,
      { redemptionSplit } as unknown as jest.Mocked<BondHoldingsService>,
      { notify } as unknown as NotificationDispatchService,
    );
  });

  afterEach(() => jest.useRealTimers());

  /** Today: one lot maturing in 12 days; window start: one lot paying interest today. */
  function holdings() {
    const today = security(
      [
        lot({
          quantity: 40,
          valuation: { maturityDate: "2026-10-25", quantity: 40 },
        }),
      ],
      { asOf: TODAY },
    );
    const yesterday = security(
      [
        lot({
          quantity: 10,
          valuation: {
            asOf: WINDOW_START,
            maturityDate: "2029-10-13",
            knownCashflows: [flow()],
          },
        }),
      ],
      { asOf: WINDOW_START },
    );
    valueSecurity.mockImplementation(
      (_user: string, _security: string, asOf: string) =>
        Promise.resolve(asOf === TODAY ? today : yesterday),
    );
    redemptionSplit.mockResolvedValue({
      date: "2026-10-25",
      quantity: 40,
      principal: "4000.00",
      grossInterest: "100.00",
      deduction: "0.00",
      interest: "100.00",
      principalReturned: "4000.00",
      payout: "4100.00",
      refusal: null,
    });
  }

  const typesNotified = () =>
    notify.mock.calls.map(([, input]) => input.type as NotificationType);

  it("raises the maturity and the interest of a held series at the owner's today", async () => {
    holdings();
    await service.evaluateUser("user-1");

    expect(valueSecurity).toHaveBeenCalledWith("user-1", SECURITY, TODAY);
    expect(valueSecurity).toHaveBeenCalledWith(
      "user-1",
      SECURITY,
      WINDOW_START,
    );
    expect(redemptionSplit).toHaveBeenCalledWith(
      "user-1",
      SECURITY,
      ACCOUNT_A,
      SERIES_1,
      "2026-10-25",
      40,
    );
    expect(typesNotified().sort()).toEqual([
      NotificationType.BOND_INTEREST_PAYMENT,
      NotificationType.BOND_MATURITY_SOON,
    ]);
  });

  it("dispatches after every read has left its transaction", async () => {
    holdings();
    await service.evaluateUser("user-1");
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((entry) => entry === "notify:outside")).toBe(true);
  });

  it("suppresses the interest notice when an INTEREST row of the day is booked", async () => {
    holdings();
    bookedRows = [{ id: "tx-1" }];
    await service.evaluateUser("user-1");
    expect(typesNotified()).toEqual([NotificationType.BOND_MATURITY_SOON]);
  });

  it("carries null figures and the refusal code when the split is refused with a 400", async () => {
    holdings();
    redemptionSplit.mockRejectedValue(
      new BadRequestException({
        message: "refused",
        errorCode: "OVER_REMOVAL",
      }),
    );
    await service.evaluateUser("user-1");
    const maturity = notify.mock.calls
      .map(([, input]) => input)
      .find((input) => input.type === NotificationType.BOND_MATURITY_SOON);
    expect(maturity.data).toMatchObject({
      payout: null,
      interest: null,
      principalReturned: null,
      missing: "OVER_REMOVAL",
    });
  });

  it("does not turn an unexpected failure into an unknown payout", async () => {
    holdings();
    redemptionSplit.mockRejectedValue(new Error("connection reset"));
    await service.evaluateUser("user-1");
    // The security's events are dropped and retried on the next run.
    expect(typesNotified()).toEqual([]);
  });

  it("keeps going when one security fails", async () => {
    holdings();
    valueSecurity.mockRejectedValueOnce(new Error("terms not found"));
    await expect(service.evaluateUser("user-1")).resolves.toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps today's events when only the window start's valuation fails", async () => {
    holdings();
    const todayImpl = valueSecurity.getMockImplementation()!;
    valueSecurity.mockImplementation(
      (user: string, sec: string, asOf: string) =>
        asOf === WINDOW_START
          ? Promise.reject(new Error("as of before purchase"))
          : todayImpl(user, sec, asOf),
    );
    await service.evaluateUser("user-1");
    expect(typesNotified()).toEqual([NotificationType.BOND_MATURITY_SOON]);
  });

  it("raises the interest of a day the cron skipped and checks that day's booking, not today's", async () => {
    holdings();
    const todayImpl = valueSecurity.getMockImplementation()!;
    valueSecurity.mockImplementation(
      async (user: string, sec: string, asOf: string) => {
        const v = await todayImpl(user, sec, asOf);
        return asOf !== WINDOW_START
          ? v
          : {
              ...v,
              lots: v.lots.map((l: (typeof v.lots)[number]) => ({
                ...l,
                valuation: {
                  ...l.valuation,
                  knownCashflows: [flow({ date: "2026-10-11" })],
                },
              })),
            };
      },
    );
    await service.evaluateUser("user-1");
    const interest = notify.mock.calls
      .map(([, input]) => input)
      .find((input) => input.type === NotificationType.BOND_INTEREST_PAYMENT);
    expect(interest.data).toMatchObject({ paymentDate: "2026-10-11" });
    expect(interest.dedupeKey).toBe(
      `bond:interest:${ACCOUNT_A}:${SERIES_1}:2026-10-11`,
    );
    const probe = manager.query.mock.calls.find(([sql]) =>
      /FROM investment_transactions/.test(String(sql)),
    );
    expect(probe?.[1]).toContain("2026-10-11");
  });

  it("keeps going when one notification fails to write", async () => {
    holdings();
    notify.mockRejectedValueOnce(new Error("write failed"));
    await expect(service.evaluateUser("user-1")).resolves.toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("counts only the rows written: a refused duplicate is not an event", async () => {
    holdings();
    notify.mockResolvedValue(null);
    await expect(service.evaluateUser("user-1")).resolves.toBe(0);
  });

  it("isolates users: one failing does not stop the next", async () => {
    holdings();
    userIds = ["user-1", "user-2"];
    failFor = "user-1";
    await service.run();
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls.every(([userId]) => userId === "user-2")).toBe(
      true,
    );
  });

  it("raises a freshly stored benchmark observation once per benchmark, and not a stale one", async () => {
    const reading = security([
      lot({
        valuation: {
          rateRule: {
            type: "BENCHMARK_PLUS_SPREAD",
            benchmarkId: "BENCH_A",
            annualRate: null,
            firstPeriodRate: null,
            addend: "0.02",
            benchmarkFloor: null,
          },
          rateSchedule: [
            {
              index: 2,
              start: "2026-11-01",
              end: "2027-11-01",
              annualRate: null,
              rateSource: null,
              benchmark: null,
              addend: null,
              interest: null,
              fixedPart: null,
              benchmarkPart: null,
              addendPart: null,
              announcedPart: null,
            },
          ],
        },
      }),
    ]);
    valueSecurity.mockResolvedValue(reading);
    const row = {
      kind: "MONTHLY",
      publisher: "Publisher",
      unit: "RATE_FRACTION",
      observation_date: "2026-09-01",
      value: "0.0490000000",
      published_on: "2026-10-13",
      fresh: true,
    };
    benchmarkRows = [row];
    await service.evaluateUser("user-1");
    const bench = notify.mock.calls
      .map(([, input]) => input)
      .filter(
        (input) => input.type === NotificationType.BOND_BENCHMARK_PUBLISHED,
      );
    expect(bench).toHaveLength(1);
    expect(bench[0].dedupeKey).toBe("bond:bench:BENCH_A:2026-09");

    notify.mockClear();
    benchmarkRows = [{ ...row, fresh: false }];
    await service.evaluateUser("user-1");
    expect(typesNotified()).not.toContain(
      NotificationType.BOND_BENCHMARK_PUBLISHED,
    );
  });

  it("raises a refused ledger as missing data and nothing else", async () => {
    valueSecurity.mockResolvedValue(
      security([], {
        refusal: {
          code: "OVER_REMOVAL",
          params: { action: "SELL", date: "2026-01-01", quantity: "5" },
          detail: "over removal",
        },
      }),
    );
    await service.evaluateUser("user-1");
    expect(typesNotified()).toEqual([NotificationType.BOND_DATA_MISSING]);
    expect(valueSecurity).toHaveBeenCalledTimes(1);
  });
});
