import {
  CLAIM_BATCH,
  NotificationReminderCronService,
  REEMIT_CONCURRENCY,
} from "./notification-reminder-cron.service";
import * as scopedDb from "../common/db/scoped-db";
import * as withContext from "../common/db/with-context";

jest.mock("../common/db/scoped-db");
jest.mock("../common/db/with-context");

describe("NotificationReminderCronService", () => {
  let service: NotificationReminderCronService;
  let query: jest.Mock;
  let notify: jest.Mock;
  let dismissSuperseded: jest.Mock;
  let manager: { query: jest.Mock };

  function claim(overrides: Record<string, unknown> = {}) {
    return {
      id: "rem-1",
      user_id: "u1",
      alert_type: "BILL_DUE",
      severity: "warning",
      title: "Rent due",
      message: "Rent is due",
      data: { budget: "x" },
      target: "/bills",
      dedupe_base: "BILL_DUE",
      repeat_mode: "repeat",
      fire_count: 3,
      ...overrides,
    };
  }

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([[], 0]);
    manager = { query };
    (scopedDb.withScopedDb as jest.Mock).mockImplementation(
      (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
    );
    (withContext.withSystemContext as jest.Mock).mockImplementation(
      (fn: () => unknown) => fn(),
    );
    (withContext.withUserContext as jest.Mock).mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
    // The dispatch double behaves like the real seam: it writes (here: returns)
    // the row and runs the caller's same-transaction hook before returning.
    notify = jest.fn(
      async (
        _userId: string,
        input: { type: string },
        options?: {
          onWritten?: (m: unknown, row: unknown) => Promise<void>;
        },
      ) => {
        const row = { id: "n-fresh", ...input };
        await options?.onWritten?.(manager, row);
        return row;
      },
    );
    dismissSuperseded = jest.fn().mockResolvedValue(0);
    service = new NotificationReminderCronService(
      {} as never,
      { dismissSupersededReminderRows: dismissSuperseded } as never,
      { notify } as never,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  it("uses operator limits for the claim and actual re-emit concurrency", async () => {
    const previous = { ...process.env };
    try {
      process.env.NOTIFICATION_REMINDER_CLAIM_BATCH = "7";
      process.env.NOTIFICATION_REMINDER_REEMIT_CONCURRENCY = "2";
      const configured = new NotificationReminderCronService(
        {} as never,
        { dismissSupersededReminderRows: dismissSuperseded } as never,
        { notify } as never,
      );
      query
        .mockResolvedValueOnce([[], 0])
        .mockResolvedValueOnce([
          Array.from({ length: 7 }, (_, i) => claim({ id: `rem-${i}` })),
          7,
        ]);
      let inFlight = 0;
      let peak = 0;
      notify.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return null;
      });
      await configured.fireDue();
      expect(query.mock.calls[1][1]).toEqual([7]);
      expect(peak).toBe(2);
      expect(notify).toHaveBeenCalledTimes(7);
    } finally {
      process.env = previous;
    }
  });

  it("does nothing when no reminder is due", async () => {
    await service.fireDue();
    expect(notify).not.toHaveBeenCalled();
  });

  it("sweeps dismissed and orphaned sources under system context before claiming", async () => {
    await service.fireDue();
    const sweep = String(query.mock.calls[0][0]);
    expect(sweep).toContain("stopped_at = CURRENT_TIMESTAMP");
    expect(sweep).toContain("dismissed_at IS NOT NULL");
    expect(sweep).toContain("source_notification_id IS NULL");
    expect(withContext.withSystemContext).toHaveBeenCalled();
  });

  it("re-emits each claimed row THROUGH THE DISPATCH SEAM with a per-fire dedupe key and the reminder id", async () => {
    query
      .mockResolvedValueOnce([[], 0]) // sweep
      .mockResolvedValueOnce([[claim()], 1]); // claim
    await service.fireDue();

    // Through notify, not the write door directly: that is what makes a repeat
    // nag push and email per the matrix, and the push Stop action reachable.
    expect(notify).toHaveBeenCalledTimes(1);
    const [userId, input] = notify.mock.calls[0];
    expect(userId).toBe("u1");
    expect(input.type).toBe("BILL_DUE");
    // fresh row: the fire ordinal makes the dedupe key unique per fire.
    expect(input.dedupeKey).toBe("BILL_DUE:rem:rem-1:3");
    // the reminder id travels on the row for the Stop control / push action.
    expect(input.data).toMatchObject({ budget: "x", reminderId: "rem-1" });
    // no budget linkage on a re-emit -> the dedupe_key index, not the
    // fingerprint index.
    expect(input.budgetId).toBeUndefined();
    // ...under the owner's context.
    expect(withContext.withUserContext).toHaveBeenCalledWith(
      "u1",
      expect.any(Function),
    );
  });

  it("does NOT consume a one-shot in the claim (a failed delivery must be able to retry)", async () => {
    await service.fireDue();
    // The claim UPDATE is the second query. It advances next_fire_at and
    // fire_count but never sets stopped_at -- the one-shot is stopped only
    // after its delivery is written (onWritten), so a failed delivery retries.
    const claimSql = String(query.mock.calls[1][0]);
    expect(claimSql).toContain("next_fire_at = CURRENT_TIMESTAMP");
    expect(claimSql).toContain("stopped_at IS NULL");
    expect(claimSql).not.toContain("stopped_at = CURRENT_TIMESTAMP");
    expect(claimSql).not.toContain("repeat_mode = $1");
    expect(claimSql).toContain("repeat_mode"); // returned, for reEmit's decision
  });

  it("bounds the claim and skips rows another replica holds", async () => {
    await service.fireDue();
    const [claimSql, params] = query.mock.calls[1];
    expect(String(claimSql)).toContain("LIMIT $1");
    expect(String(claimSql)).toContain("FOR UPDATE SKIP LOCKED");
    expect(params).toEqual([CLAIM_BATCH]);
  });

  it("does not start a second tick while one is in flight", async () => {
    let release!: () => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([[], 0]);
        }),
    );
    const first = service.fireDue();
    await Promise.resolve();
    // The second call returns without touching the database.
    await service.fireDue();
    expect(query).toHaveBeenCalledTimes(1);
    release();
    await first;
    // The first tick then ran its claim (call 2)...
    expect(query).toHaveBeenCalledTimes(2);
    // ...and once it is done, the next tick runs again: sweep + claim.
    await service.fireDue();
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("re-emits a few at a time, every claim reached", async () => {
    const claims = Array.from({ length: 12 }, (_, i) =>
      claim({ id: `r${i}`, user_id: `u${i}` }),
    );
    query.mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([claims, 12]);
    let inFlight = 0;
    let peak = 0;
    notify.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return null;
    });
    await service.fireDue();
    expect(notify).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(REEMIT_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it("supersedes the previous nag of the same reminder in the write transaction", async () => {
    query.mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([[claim()], 1]);
    await service.fireDue();
    // Inside onWritten (the dispatch double runs it before returning), keyed on
    // the reminder and sparing the row just written.
    expect(dismissSuperseded).toHaveBeenCalledWith("u1", "rem-1", "n-fresh");
  });

  it("stops a one-shot in the SAME transaction as its delivery, not before", async () => {
    query
      .mockResolvedValueOnce([[], 0]) // sweep
      .mockResolvedValueOnce([[claim({ repeat_mode: "once" })], 1]) // claim
      .mockResolvedValueOnce([[{ id: "rem-1" }], 1]); // onWritten's stop UPDATE
    await service.fireDue();

    expect(notify).toHaveBeenCalledTimes(1);
    // The stop ran on the manager the hook was handed, ownership-scoped and
    // guarded on stopped_at IS NULL, as the third query (after sweep + claim).
    const stopCall = query.mock.calls[2];
    expect(String(stopCall[0])).toContain("stopped_at = CURRENT_TIMESTAMP");
    expect(String(stopCall[0])).toContain("stopped_at IS NULL");
    expect(stopCall[1]).toEqual(["rem-1", "u1"]);
  });

  it("does not consume a one-shot whose follow-up the write door refused (nothing was delivered)", async () => {
    query
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([[claim({ repeat_mode: "once" })], 1]);
    // ON CONFLICT DO NOTHING lost: notify returns null and never runs the hook.
    notify.mockResolvedValue(null);
    await service.fireDue();
    expect(notify).toHaveBeenCalledTimes(1);
    // Only sweep + claim ran: no stop, no supersede. The reminder stays
    // claimable for the next interval.
    expect(query).toHaveBeenCalledTimes(2);
    expect(dismissSuperseded).not.toHaveBeenCalled();
    expect(service["logger"].warn).toHaveBeenCalledWith(
      expect.stringContaining("rem-1"),
    );
  });

  it("does not stop a repeating reminder after firing", async () => {
    query
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([[claim({ repeat_mode: "repeat" })], 1]);
    await service.fireDue();
    expect(notify).toHaveBeenCalledTimes(1);
    // Only sweep + claim ran; no stop UPDATE for a repeat.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing re-emit: one user's failure does not skip the rest", async () => {
    notify.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(null);
    query
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([
        [
          claim({ id: "r1", user_id: "uA" }),
          claim({ id: "r2", user_id: "uB" }),
        ],
        2,
      ]);
    await expect(service.fireDue()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("never throws out of the cron even if the claim query fails", async () => {
    query.mockRejectedValue(new Error("db down"));
    await expect(service.fireDue()).resolves.toBeUndefined();
  });
});
