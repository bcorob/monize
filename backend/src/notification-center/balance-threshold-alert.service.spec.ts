import { DataSource } from "typeorm";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: (_userId: string, fn: () => unknown) => fn(),
}));

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  BalanceThresholdAlertService,
  buildBalanceNotification,
} from "./balance-threshold-alert.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  NotificationSeverity,
  NotificationType,
} from "./entities/notification.entity";

const firedLowRow = {
  current_balance: "40.0000",
  threshold: "50.0000",
  currency_code: "CAD",
  name: "Chequing",
};

describe("BalanceThresholdAlertService", () => {
  function makeService(lowFires: boolean, highFires: boolean) {
    const { manager, dataSource } = createScopedDbMocks([]);
    manager.query.mockImplementation((sql: string) => {
      if (/SET low_alert_armed = true/.test(sql)) {
        return Promise.resolve(lowFires ? [firedLowRow] : []);
      }
      if (/SET high_alert_armed = true/.test(sql)) {
        return Promise.resolve(
          highFires ? [{ ...firedLowRow, threshold: "9000.0000" }] : [],
        );
      }
      return Promise.resolve([]); // re-arm updates return nothing
    });
    const dispatch = {
      notify: jest.fn().mockResolvedValue({ id: "n-1" }),
    } as unknown as NotificationDispatchService;
    const service = new BalanceThresholdAlertService(
      dataSource as unknown as DataSource,
      dispatch,
    );
    return { service, manager, dispatch };
  }

  it("fires a low crossing when the CAS arms the latch", async () => {
    const { service, dispatch } = makeService(true, false);
    await service.evaluateAccounts("user-1", ["acc-1"]);
    expect(dispatch.notify).toHaveBeenCalledTimes(1);
    const [, input] = (dispatch.notify as jest.Mock).mock.calls[0];
    expect(input.type).toBe(NotificationType.BALANCE_BELOW_THRESHOLD);
    expect(input.severity).toBe(NotificationSeverity.WARNING);
    expect(input.dedupeKey).toBeUndefined();
  });

  it("does not fire when the low CAS matches nothing (re-arm path)", async () => {
    const { service, dispatch, manager } = makeService(false, false);
    await service.evaluateAccounts("user-1", ["acc-1"]);
    expect(dispatch.notify).not.toHaveBeenCalled();
    // A re-arm UPDATE ran for each kind (armed=false claim returned nothing).
    const rearmLow = manager.query.mock.calls.filter(([sql]: [string]) =>
      /SET low_alert_armed = false/.test(sql),
    );
    expect(rearmLow.length).toBe(1);
  });

  it("fires a high crossing independently", async () => {
    const { service, dispatch } = makeService(false, true);
    await service.evaluateAccounts("user-1", ["acc-1"]);
    expect(dispatch.notify).toHaveBeenCalledTimes(1);
    const [, input] = (dispatch.notify as jest.Mock).mock.calls[0];
    expect(input.type).toBe(NotificationType.BALANCE_ABOVE_THRESHOLD);
    expect(input.severity).toBe(NotificationSeverity.INFO);
  });

  it("isolates one account's failure from the rest", async () => {
    const { manager, dataSource } = createScopedDbMocks([]);
    let call = 0;
    manager.query.mockImplementation((sql: string) => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("boom")); // first account's low CAS
      if (/SET low_alert_armed = true/.test(sql)) {
        return Promise.resolve([firedLowRow]);
      }
      return Promise.resolve([]);
    });
    const dispatch = {
      notify: jest.fn().mockResolvedValue({ id: "n-1" }),
    } as unknown as NotificationDispatchService;
    const service = new BalanceThresholdAlertService(
      dataSource as unknown as DataSource,
      dispatch,
    );
    await service.evaluateAccounts("user-1", ["bad", "good"]);
    // The second account still fired despite the first throwing.
    expect(dispatch.notify).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty account list", async () => {
    const { service, dispatch } = makeService(true, true);
    await service.evaluateAccounts("user-1", []);
    expect(dispatch.notify).not.toHaveBeenCalled();
  });

  // `dispatch.notify` writes the row in its own transaction and then awaits the
  // push/email fan-out. Called inside the CAS `withScopedDb`, that fan-out would
  // run before the latch commits and while the `accounts` row lock is held
  // across the push HTTP -- so the crossing is collected in the transaction and
  // dispatched only after it has resolved. Moving `notify` back inside the
  // callback re-orders these and fails the test.
  it("dispatches only after the CAS transaction has resolved", async () => {
    const order: string[] = [];
    const { manager, dataSource } = createScopedDbMocks([]);
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        /SET low_alert_armed = true/.test(sql) ? [firedLowRow] : [],
      ),
    );
    const inner = dataSource.transaction.getMockImplementation()!;
    dataSource.transaction.mockImplementation(async (...args: unknown[]) => {
      const result = await (inner as (...a: unknown[]) => unknown)(...args);
      order.push("tx-resolved");
      return result;
    });
    const dispatch = {
      notify: jest.fn().mockImplementation(() => {
        order.push("notify");
        return Promise.resolve({ id: "n-1" });
      }),
    } as unknown as NotificationDispatchService;
    const service = new BalanceThresholdAlertService(
      dataSource as unknown as DataSource,
      dispatch,
    );

    await service.evaluateAccounts("user-1", ["acc-1"]);

    expect(order).toEqual(["tx-resolved", "notify"]);
  });
});

describe("buildBalanceNotification", () => {
  it("maps a low crossing to a WARNING with an account target and no dedupe key", () => {
    const input = buildBalanceNotification("acc-9", firedLowRow, "low");
    expect(input.type).toBe(NotificationType.BALANCE_BELOW_THRESHOLD);
    expect(input.severity).toBe(NotificationSeverity.WARNING);
    expect(input.target).toBe("/accounts/acc-9");
    expect(input.dedupeKey).toBeUndefined();
    expect(input.data).toMatchObject({
      accountId: "acc-9",
      balance: 40,
      threshold: 50,
      currencyCode: "CAD",
      kind: "low",
    });
  });

  it("maps a high crossing to an INFO", () => {
    const input = buildBalanceNotification(
      "acc-9",
      { ...firedLowRow, threshold: "9000.0000" },
      "high",
    );
    expect(input.type).toBe(NotificationType.BALANCE_ABOVE_THRESHOLD);
    expect(input.severity).toBe(NotificationSeverity.INFO);
    expect(input.data).toMatchObject({ kind: "high" });
  });
});
