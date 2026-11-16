import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { addDaysYMD, todayInTimezoneOrUtc } from "../common/date-utils";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  buildWarrantyExpiringNotification,
  warrantyReminderThreshold,
} from "./warranty-notifications";
import { warrantyStatus } from "./warranty-status.util";

/**
 * How far either side of the UTC today a warranty is read as a CANDIDATE.
 * `expires_on` is a calendar date and days left are counted in the reader's
 * zone, whose today is at most one day either side of UTC's: one day back
 * reaches an "expires today" in a zone still behind UTC, and 31 ahead reaches
 * a 30-day mark in a zone already ahead of it. The day count
 * (`warrantyReminderThreshold`) alone decides whether a reminder is owed.
 */
const LOOK_BACK_DAYS = 1;
const LOOK_AHEAD_DAYS = 31;

/** An unarchived, non-lifetime warranty near its expiry. */
interface WarrantyCandidate {
  id: string;
  userId: string;
  name: string;
  expiresOn: string;
}

/** What one evaluation did, for the log line. */
export interface WarrantyReminderTally {
  /** Notification rows this replica wrote. */
  written: number;
}

/**
 * Warranty expiry reminders (docs/specs/warranty-tracker.md section
 * 6.7), once a day at 06:17 UTC. A warranty is reminded of when 30, 7 and 0
 * days remain, in the owner's timezone; nothing fires after the day of expiry.
 *
 * **A reminder fires on reaching a threshold, once per expiry date, never on
 * mere observation.** The threshold owed is the smallest mark the days left are
 * at or under (`warrantyReminderThreshold`), so a missed run moves the next one
 * to a smaller mark instead of firing the skipped ones in a burst.
 *
 * **Every replica fires every cron, so the dedupe key is the claim (WTY-004).**
 * A notification's `dedupeKey` names the warranty, its `expires_on` and the
 * mark; `NotificationService.create` is an `INSERT ... ON CONFLICT DO NOTHING`
 * over `idx_notifications_dedupe`, so one replica wins each reminder and the
 * other gets `null` and sends nothing. A changed `expires_on` forms new keys,
 * so the reminders fire again for the new date.
 *
 * The shape is the ordinary out-of-request one: `withSystemContext` for the
 * cross-user read, `withUserContext(userId)` around each user's whole body, a
 * failure of one warranty or one user logged and the loop continues. A user
 * with no resolvable timezone counts in UTC.
 */
@Injectable()
export class WarrantyExpiryReminderService {
  private readonly logger = new Logger(WarrantyExpiryReminderService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Cron("17 6 * * *", { timeZone: "UTC" })
  async run(): Promise<void> {
    try {
      const tally = await this.evaluate(new Date());
      if (tally.written > 0) {
        this.logger.log(
          `Warranty expiry reminders: ${tally.written} written by this replica`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Warranty expiry reminders could not run: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Judge every unarchived, non-lifetime warranty expiring within the
   * candidate window (see {@link LOOK_AHEAD_DAYS}), as of `now`. Public so a
   * test can pin the clock; the cron passes the real one. Safe to run twice at
   * once: see the class comment.
   */
  async evaluate(now: Date): Promise<WarrantyReminderTally> {
    // Every user's timezone is read only when there is a candidate to judge
    // in it: most days there is none, and the users read is the larger one.
    const { candidates, timezoneOf } = await withSystemContext(async () => {
      const found = await this.candidates(now);
      return {
        candidates: found,
        timezoneOf:
          found.length === 0
            ? new Map<string, string>()
            : await this.timezones(),
      };
    });

    const byUser = new Map<string, WarrantyCandidate[]>();
    for (const candidate of candidates) {
      byUser.set(candidate.userId, [
        ...(byUser.get(candidate.userId) ?? []),
        candidate,
      ]);
    }

    const tally: WarrantyReminderTally = { written: 0 };
    for (const [userId, warranties] of byUser) {
      try {
        const today = todayInTimezoneOrUtc(
          timezoneOf.get(userId) ?? "UTC",
          now,
        );
        await withUserContext(userId, async () => {
          for (const warranty of warranties) {
            try {
              if (await this.remind(warranty, today)) tally.written += 1;
            } catch (error) {
              this.logger.error(
                `Warranty reminder for ${warranty.id} failed: ${errorMessage(error)}`,
              );
            }
          }
        });
      } catch (error) {
        this.logger.error(
          `Warranty reminders failed for user ${userId}: ${errorMessage(error)}`,
        );
      }
    }
    return tally;
  }

  /** Candidate warranties across users; ids, names and dates only. */
  private async candidates(now: Date): Promise<WarrantyCandidate[]> {
    const utcToday = now.toISOString().slice(0, 10);
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{
        id: string;
        user_id: string;
        name: string;
        expires_on: string;
      }>(
        await m.query(
          `SELECT id, user_id, name,
                  TO_CHAR(expires_on, 'YYYY-MM-DD') AS expires_on
             FROM warranties
            WHERE archived_at IS NULL
              AND is_lifetime = false
              AND expires_on BETWEEN $1::date AND $2::date
            ORDER BY user_id, expires_on, id`,
          [
            addDaysYMD(utcToday, -LOOK_BACK_DAYS),
            addDaysYMD(utcToday, LOOK_AHEAD_DAYS),
          ],
        ),
      );
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        expiresOn: row.expires_on,
      }));
    });
  }

  /** Every user's effective timezone, read once under the system context. */
  private async timezones(): Promise<Map<string, string>> {
    const byZone = await getUsersByEffectiveTimezone(this.dataSource);
    const byUser = new Map<string, string>();
    for (const [timezone, userIds] of byZone) {
      for (const userId of userIds) byUser.set(userId, timezone);
    }
    return byUser;
  }

  /**
   * One warranty of one user, inside that user's identity. True when this
   * replica wrote the row; a lost insert (`null`) is the other replica's.
   */
  private async remind(
    warranty: WarrantyCandidate,
    today: string,
  ): Promise<boolean> {
    // The cron reads the status rule, never compares the two dates itself
    // (WTY-002); a candidate is never lifetime, so `daysLeft` is a count.
    const { daysLeft } = warrantyStatus(warranty.expiresOn, false, today);
    if (daysLeft === null) return false;
    const threshold = warrantyReminderThreshold(daysLeft);
    if (threshold === null) return false;
    const written = await this.dispatch.notify(
      warranty.userId,
      buildWarrantyExpiringNotification(
        {
          warrantyId: warranty.id,
          name: warranty.name,
          expiresOn: warranty.expiresOn,
        },
        threshold,
        daysLeft,
        today,
      ),
    );
    return written !== null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
