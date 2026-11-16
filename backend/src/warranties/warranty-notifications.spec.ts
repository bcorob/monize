import {
  NotificationSeverity,
  NotificationType,
  notificationCategoryOf,
  NotificationCategory,
} from "../notification-center/entities/notification.entity";
import {
  WARRANTY_REMINDER_THRESHOLDS,
  buildWarrantyExpiringNotification,
  warrantyExpiryDedupeKey,
  warrantyReminderSeverity,
  warrantyReminderThreshold,
} from "./warranty-notifications";
import { WARRANTY_EXPIRING_WINDOW_DAYS } from "./warranty-status.util";

const WARRANTY_ID = "5a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const facts = {
  warrantyId: WARRANTY_ID,
  name: "Dishwasher",
  expiresOn: "2026-11-10",
};

describe("warranty reminder thresholds (decision 3, WTY-004)", () => {
  it("fires at 30, 7 and 0 days, the first mark being the expiring window", () => {
    expect([...WARRANTY_REMINDER_THRESHOLDS]).toEqual([30, 7, 0]);
    expect(WARRANTY_REMINDER_THRESHOLDS[0]).toBe(WARRANTY_EXPIRING_WINDOW_DAYS);
  });

  // Truth table B, the threshold column.
  it.each([
    [45, null],
    [31, null],
    [30, 30],
    [29, 30],
    [20, 30],
    [8, 30],
    [7, 7],
    [6, 7],
    [1, 7],
    [0, 0],
    [-1, null],
    [-30, null],
  ] as const)("%s days left owes the %s mark", (daysLeft, mark) => {
    expect(warrantyReminderThreshold(daysLeft)).toBe(mark);
  });

  it("owes nothing for a count that is not a whole number", () => {
    expect(warrantyReminderThreshold(Number.NaN)).toBeNull();
    expect(warrantyReminderThreshold(6.5)).toBeNull();
    expect(warrantyReminderThreshold(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("warrantyExpiryDedupeKey", () => {
  it("names the warranty, its expiry date and the mark", () => {
    expect(warrantyExpiryDedupeKey(WARRANTY_ID, "2026-11-10", 7)).toBe(
      `wty:exp:${WARRANTY_ID}:2026-11-10:7`,
    );
  });

  it("forms a new key when the expiry date moves (example 4)", () => {
    expect(warrantyExpiryDedupeKey(WARRANTY_ID, "2027-11-10", 30)).not.toBe(
      warrantyExpiryDedupeKey(WARRANTY_ID, "2026-11-10", 30),
    );
  });
});

describe("warrantyReminderSeverity", () => {
  it("is info a month out and a warning from the last week on", () => {
    expect(warrantyReminderSeverity(30)).toBe(NotificationSeverity.INFO);
    expect(warrantyReminderSeverity(7)).toBe(NotificationSeverity.WARNING);
    expect(warrantyReminderSeverity(0)).toBe(NotificationSeverity.WARNING);
  });
});

describe("buildWarrantyExpiringNotification", () => {
  it("builds the expiring reminder at the 30 and 7-day marks", () => {
    const input = buildWarrantyExpiringNotification(
      facts,
      30,
      20,
      "2026-10-21",
    );
    expect(input).toEqual({
      type: NotificationType.WARRANTY_EXPIRING,
      severity: NotificationSeverity.INFO,
      title: "Dishwasher: warranty expires soon",
      message:
        "The warranty for Dishwasher expires on 2026-11-10. Open to review its documents or record a claim.",
      data: {
        warrantyId: WARRANTY_ID,
        name: "Dishwasher",
        expiresOn: "2026-11-10",
        threshold: 30,
        daysLeft: 20,
      },
      target: `/warranties/${WARRANTY_ID}`,
      periodStart: "2026-10-21",
      dedupeKey: `wty:exp:${WARRANTY_ID}:2026-11-10:30`,
    });
    expect(
      buildWarrantyExpiringNotification(facts, 7, 7, "2026-11-03"),
    ).toMatchObject({
      type: NotificationType.WARRANTY_EXPIRING,
      severity: NotificationSeverity.WARNING,
      dedupeKey: `wty:exp:${WARRANTY_ID}:2026-11-10:7`,
      data: { threshold: 7, daysLeft: 7 },
    });
  });

  it("builds the expires-today reminder at the 0 mark", () => {
    const input = buildWarrantyExpiringNotification(facts, 0, 0, "2026-11-10");
    expect(input).toMatchObject({
      type: NotificationType.WARRANTY_EXPIRES_TODAY,
      severity: NotificationSeverity.WARNING,
      title: "Dishwasher: warranty expires today",
      message:
        "The warranty for Dishwasher expires today, 2026-11-10. Open to review its documents or record a claim.",
      target: `/warranties/${WARRANTY_ID}`,
      periodStart: "2026-11-10",
      dedupeKey: `wty:exp:${WARRANTY_ID}:2026-11-10:0`,
      data: { threshold: 0, daysLeft: 0, expiresOn: "2026-11-10" },
    });
  });

  it("files both types under the WARRANTIES category", () => {
    for (const threshold of WARRANTY_REMINDER_THRESHOLDS) {
      const { type } = buildWarrantyExpiringNotification(
        facts,
        threshold,
        threshold,
        "2026-10-21",
      );
      expect(notificationCategoryOf(type)).toBe(
        NotificationCategory.WARRANTIES,
      );
    }
  });

  it("stores facts, never relative prose, in data", () => {
    const { data } = buildWarrantyExpiringNotification(
      facts,
      7,
      5,
      "2026-11-05",
    );
    expect(Object.keys(data ?? {}).sort()).toEqual(
      ["daysLeft", "expiresOn", "name", "threshold", "warrantyId"].sort(),
    );
    expect(JSON.stringify(data)).not.toMatch(/days? left|in \d+ days/);
  });
});
