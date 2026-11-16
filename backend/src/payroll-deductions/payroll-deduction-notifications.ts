import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { CreateNotificationInput } from "../notification-center/notification.service";

/**
 * The reminder a rule raises two months before it resets
 * (docs/specs/payroll-deductions.md section 5.4, INV-PAYROLL-004), as a pure
 * function of the facts it reports. `data` holds facts the client renders in
 * the reader's language; `title` and `message` are the English fallbacks.
 */
export interface ResetReminderFacts {
  ruleId: string;
  categoryName: string;
  scheduledTransactionName: string;
  /** The day the count starts again, `YYYY-MM-DD`. */
  resetOn: string;
  yearlyMaximum: number;
  currencyCode: string;
}

/** One key per rule per reset date, so the window fires once (INV-PAYROLL-004). */
export function resetReminderDedupeKey(
  ruleId: string,
  resetOn: string,
): string {
  return `pdr:reset:${ruleId}:${resetOn}`;
}

export function buildResetReminderNotification(
  facts: ResetReminderFacts,
  /** Today in the reader's timezone. */
  localToday: string,
): CreateNotificationInput {
  const {
    ruleId,
    categoryName,
    scheduledTransactionName,
    resetOn,
    yearlyMaximum,
    currencyCode,
  } = facts;
  return {
    type: NotificationType.PAYROLL_DEDUCTION_RESET_DUE,
    severity: NotificationSeverity.INFO,
    title: `${categoryName}: confirm next year's maximum`,
    message:
      `The ${categoryName} deduction on ${scheduledTransactionName} resets on ${resetOn}. ` +
      `Update the yearly maximum if it changes; otherwise ${yearlyMaximum} ${currencyCode} applies again.`,
    data: {
      ruleId,
      categoryName,
      scheduledTransactionName,
      resetOn,
      yearlyMaximum,
      currencyCode,
    },
    target: `/taxes/payroll-deductions`,
    periodStart: localToday,
    dedupeKey: resetReminderDedupeKey(ruleId, resetOn),
  };
}
