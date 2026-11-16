import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { CreateNotificationInput } from "../notification-center/notification.service";

/**
 * The expiry reminders a warranty raises (docs/specs/warranty-tracker.md
 * decisions 3 and 10, sections 6.6 and 6.7), as pure functions of the facts
 * they report. Nothing here reads a clock or a database: the reminder service
 * reads the warranty and the reader's today and passes them in, so the
 * threshold choice and the dedupe key are testable without either.
 *
 * `data` holds facts (the name, the expiry date, the threshold and the days
 * left on the day it was written), never "in 3 days" text: the client renders
 * the row in the reader's language and the email composes its copy from `name`
 * and `expiresOn` at delivery. `title` and `message` are the English fallbacks
 * for a reader with no client.
 *
 * Every row's `target` is a template literal on `/warranties/<id>`, written
 * inline in the builder: the frontend's `notification-target.contract.test.ts`
 * reads a producer's target out of the source and checks that it is a real
 * page, and a target held in a constant is one it cannot verify.
 */

/**
 * The days-left marks a warranty reminder fires at (decision 3). The first is
 * the `expiring` window (`WARRANTY_EXPIRING_WINDOW_DAYS`, held equal by the
 * spec); `0` is the day of expiry, and nothing fires after it.
 */
export const WARRANTY_REMINDER_THRESHOLDS = [30, 7, 0] as const;
export type WarrantyReminderThreshold =
  (typeof WARRANTY_REMINDER_THRESHOLDS)[number];

/**
 * The reminder a warranty with `daysLeft` whole days remaining is owed: the
 * smallest threshold `t` with `daysLeft <= t` (`consentReminderThreshold`'s
 * rule, over this feature's marks). 20 days left is the 30-day reminder, 5 is
 * the 7-day one, 0 is "expires today". A missed run only moves a later one to
 * a smaller mark, so the skipped marks never fire as a burst. `null` above 30
 * days, after the day of expiry (`daysLeft < 0`), and for a count that is not
 * a whole number: unknown is not a reminder.
 */
export function warrantyReminderThreshold(
  daysLeft: number,
): WarrantyReminderThreshold | null {
  if (!Number.isInteger(daysLeft) || daysLeft < 0) return null;
  const ascending = [...WARRANTY_REMINDER_THRESHOLDS].reverse();
  return ascending.find((threshold) => daysLeft <= threshold) ?? null;
}

/**
 * The dedupe key of one warranty reminder (WTY-004). The expiry date is part of
 * it, so a warranty whose `expires_on` changes starts a fresh set of keys and
 * hears its reminders again (example 4); the old keys stay with their rows.
 */
export function warrantyExpiryDedupeKey(
  warrantyId: string,
  expiresOn: string,
  threshold: WarrantyReminderThreshold,
): string {
  return `wty:exp:${warrantyId}:${expiresOn}:${threshold}`;
}

/** Info a month out, a warning from the last week to the day itself. */
export function warrantyReminderSeverity(
  threshold: WarrantyReminderThreshold,
): NotificationSeverity {
  return threshold === 30
    ? NotificationSeverity.INFO
    : NotificationSeverity.WARNING;
}

/** The facts of the warranty a reminder is about. */
export interface WarrantyReminderFacts {
  warrantyId: string;
  name: string;
  /** The stored expiry date, `YYYY-MM-DD`. */
  expiresOn: string;
}

export function buildWarrantyExpiringNotification(
  warranty: WarrantyReminderFacts,
  threshold: WarrantyReminderThreshold,
  /** Whole days from the reader's today to `expiresOn`, on the day of writing. */
  daysLeft: number,
  /** Today in the reader's timezone. */
  localToday: string,
): CreateNotificationInput {
  const { warrantyId, name, expiresOn } = warranty;
  const shared = {
    severity: warrantyReminderSeverity(threshold),
    data: { warrantyId, name, expiresOn, threshold, daysLeft },
    periodStart: localToday,
    dedupeKey: warrantyExpiryDedupeKey(warrantyId, expiresOn, threshold),
  };
  if (threshold === 0) {
    return {
      type: NotificationType.WARRANTY_EXPIRES_TODAY,
      title: `${name}: warranty expires today`,
      message:
        `The warranty for ${name} expires today, ${expiresOn}. ` +
        "Open to review its documents or record a claim.",
      target: `/warranties/${warrantyId}`,
      ...shared,
    };
  }
  return {
    type: NotificationType.WARRANTY_EXPIRING,
    title: `${name}: warranty expires soon`,
    message:
      `The warranty for ${name} expires on ${expiresOn}. ` +
      "Open to review its documents or record a claim.",
    target: `/warranties/${warrantyId}`,
    ...shared,
  };
}
