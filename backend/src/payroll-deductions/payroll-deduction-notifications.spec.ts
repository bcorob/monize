import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import {
  buildResetReminderNotification,
  resetReminderDedupeKey,
} from "./payroll-deduction-notifications";

describe("payroll deduction reset reminder", () => {
  const facts = {
    ruleId: "rule-1",
    categoryName: "EI",
    scheduledTransactionName: "Paycheque",
    resetOn: "2027-01-01",
    yearlyMaximum: 1077.48,
    currencyCode: "CAD",
  };

  it("keys one reminder per rule per reset date", () => {
    expect(resetReminderDedupeKey("rule-1", "2027-01-01")).toBe(
      "pdr:reset:rule-1:2027-01-01",
    );
  });

  it("builds a PAYMENTS-category row carrying the facts and the page", () => {
    const row = buildResetReminderNotification(facts, "2026-11-01");
    expect(row).toMatchObject({
      type: NotificationType.PAYROLL_DEDUCTION_RESET_DUE,
      severity: NotificationSeverity.INFO,
      target: "/taxes/payroll-deductions",
      periodStart: "2026-11-01",
      dedupeKey: "pdr:reset:rule-1:2027-01-01",
      data: facts,
    });
    expect(row.title).toContain("EI");
    expect(row.message).toContain("2027-01-01");
    expect(row.message).toContain("Paycheque");
  });
});
