import {
  STALE_UNRECONCILED_DAYS,
  classifyStaleRow,
  staleCutoffDate,
} from "./stale-reconciliation";
import { TransactionStatus } from "./entities/transaction.entity";

describe("staleCutoffDate", () => {
  it("subtracts the window from the given day", () => {
    expect(staleCutoffDate("2026-08-18", 45)).toBe("2026-07-04");
  });

  it("crosses a month and a year boundary by the calendar, not by 30-day months", () => {
    expect(staleCutoffDate("2026-01-10", 45)).toBe("2025-11-26");
  });

  it("counts 29 February in a leap year", () => {
    // 2024-03-05 minus 5 days lands on 2024-02-29, which exists only in a leap
    // year -- a cutoff derived by arithmetic on month lengths would miss it.
    expect(staleCutoffDate("2024-03-05", 5)).toBe("2024-02-29");
  });

  it("defaults to the exported window", () => {
    expect(staleCutoffDate("2026-08-18")).toBe(
      staleCutoffDate("2026-08-18", STALE_UNRECONCILED_DAYS),
    );
  });
});

describe("classifyStaleRow", () => {
  const lastReconciled = "2026-06-30";
  const overdueBefore = "2026-07-04";

  it("calls a row on the last reconciled date missed, not overdue", () => {
    // The boundary is inclusive: a row dated exactly on the statement date was
    // part of that statement, so reconciling without it is the defect the
    // `missed` reason names.
    expect(
      classifyStaleRow(
        TransactionStatus.CLEARED,
        lastReconciled,
        lastReconciled,
        overdueBefore,
      ),
    ).toBe("missed");
  });

  it("calls an older row missed", () => {
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        "2026-01-01",
        lastReconciled,
        overdueBefore,
      ),
    ).toBe("missed");
  });

  it("keeps the two reasons disjoint when a row satisfies both", () => {
    // 2026-01-01 is before the last reconciled date AND before the cutoff.
    // Counting it twice would make missed + overdue exceed the total.
    const reason = classifyStaleRow(
      TransactionStatus.UNRECONCILED,
      "2026-01-01",
      lastReconciled,
      overdueBefore,
    );
    expect(reason).toBe("missed");
    expect(reason).not.toBe("overdue");
  });

  it("calls a row after the statement but before the cutoff overdue", () => {
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        "2026-07-03",
        lastReconciled,
        overdueBefore,
      ),
    ).toBe("overdue");
  });

  it("leaves a row on the cutoff alone", () => {
    // Exclusive at this end: the row is exactly `staleAfterDays` old, which is
    // the first day it is *not yet* overdue.
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        overdueBefore,
        lastReconciled,
        overdueBefore,
      ),
    ).toBeNull();
  });

  it("leaves a recent row alone", () => {
    expect(
      classifyStaleRow(
        TransactionStatus.CLEARED,
        "2026-08-15",
        lastReconciled,
        overdueBefore,
      ),
    ).toBeNull();
  });

  it("reports nothing for an account that has never been reconciled", () => {
    // Reconciliation is opt-in per account. Without that guard a user who has
    // never reconciled anything would be told every old transaction they own is
    // overdue, which is the failure mode that makes a reminder ignorable.
    expect(
      classifyStaleRow(
        TransactionStatus.UNRECONCILED,
        "2019-01-01",
        null,
        overdueBefore,
      ),
    ).toBeNull();
  });

  it("reports nothing for a reconciled row", () => {
    expect(
      classifyStaleRow(
        TransactionStatus.RECONCILED,
        "2019-01-01",
        lastReconciled,
        overdueBefore,
      ),
    ).toBeNull();
  });

  it("reports nothing for a void row", () => {
    // A VOID row records something that did not happen, so it is not money the
    // bank is holding a different opinion about.
    expect(
      classifyStaleRow(
        TransactionStatus.VOID,
        "2019-01-01",
        lastReconciled,
        overdueBefore,
      ),
    ).toBeNull();
  });
});
