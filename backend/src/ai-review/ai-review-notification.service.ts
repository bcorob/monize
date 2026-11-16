import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

/**
 * The expiring window is `[now + 2 days, now + 3 days)` in the database clock.
 * Daily runs sit 24 hours apart, so a request enters the window on exactly one
 * run (docs/specs/ai-review-notifications.md section 4).
 */
export const AI_REVIEW_EXPIRING_FROM_DAYS = 2;
export const AI_REVIEW_EXPIRING_TO_DAYS = 3;

/**
 * The notice for a count of open proposals. Counts only: never the instruction
 * (the person's own words), a payee, an amount or the email text, because push
 * and email leave the server (spec section 5).
 */
export function buildProposalsReadyNotification(
  count: number,
  added: number,
  utcHour: string,
): CreateNotificationInput {
  return {
    type: NotificationType.AI_REVIEW_PROPOSALS_READY,
    severity: NotificationSeverity.INFO,
    title: "AI review proposals wait for you",
    message: `Proposals waiting for your decision: ${count}. New since the last notice: ${added}. Open Monize to review.`,
    data: { count, added },
    target: "/ai-reviews",
    dedupeKey: `air:ready:${utcHour}`,
  };
}

/** The notice for proposals that expire within 3 days; counts and one date only. */
export function buildProposalsExpiringNotification(
  count: number,
  earliestExpiresAt: Date,
  utcDate: string,
): CreateNotificationInput {
  return {
    type: NotificationType.AI_REVIEW_PROPOSALS_EXPIRING,
    severity: NotificationSeverity.WARNING,
    title: "AI review proposals expire soon",
    message: `Proposals that expire within 3 days: ${count}. The first one expires on ${earliestExpiresAt.toISOString().slice(0, 10)}. Open Monize to review.`,
    data: { count, earliestExpiresAt: earliestExpiresAt.toISOString() },
    target: "/ai-reviews",
    dedupeKey: `air:exp:${utcDate}`,
  };
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Notification Center rows for AI review proposals that wait for the person
 * (docs/specs/ai-review-notifications.md). Only `proposed` requests count: a
 * `pending` or `claimed` one waits for an agent, and an expired one is lost.
 *
 * Two producers, both across every user:
 *
 * - {@link notifyReady}, called by the hourly sweep after expiry and release:
 *   notifies when a user has live proposals that arrived since their newest
 *   ready notice (dismissed or not), so approving everything and never
 *   dismissing the notice does not silence the next proposals.
 * - {@link notifyExpiring}, a daily cron: one notice per user for the proposals
 *   that cross the 3-day mark before expiry.
 *
 * Every replica fires both, so the dedupe key is the claim:
 * `NotificationService.create` is an `INSERT ... ON CONFLICT DO NOTHING` over
 * `idx_notifications_dedupe`, the loser gets `null` and sends nothing. Cutoffs
 * are `CURRENT_TIMESTAMP` in the database, never a clock this process holds.
 * The fan-out read runs under `withSystemContext`, each user's body under
 * `withUserContext`, and a failure of one user is logged and the loop goes on.
 */
@Injectable()
export class AiReviewNotificationService {
  private readonly logger = new Logger(AiReviewNotificationService.name);

  constructor(
    private readonly dataSource: DataSource,
    // `forwardRef`: the notifications module reaches this module back through
    // the scheduled-transactions and rules modules (module-graph.spec).
    @Inject(forwardRef(() => NotificationDispatchService))
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /**
   * Notify each user whose open proposals grew since their last live notice.
   * Never throws: the sweep that calls it must not fail on a notice. Returns
   * how many notices this replica wrote.
   */
  async notifyReady(now: Date = new Date()): Promise<number> {
    // `YYYY-MM-DDTHH` in UTC: replicas firing the same hourly sweep collapse.
    const utcHour = now.toISOString().slice(0, 13);
    let written = 0;
    try {
      const users = await withSystemContext(() =>
        this.usersWithOpenProposals(),
      );
      for (const userId of users) {
        try {
          const wrote = await withUserContext(userId, () =>
            this.notifyUserReady(userId, utcHour),
          );
          if (wrote) written += 1;
        } catch (error) {
          this.logger.error(
            `AI review ready notice failed for user ${userId}: ${describeError(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `AI review ready notices could not run: ${describeError(error)}`,
      );
    }
    return written;
  }

  /** Daily at 07:41 UTC. Returns how many notices this replica wrote. */
  @Cron("41 7 * * *", { timeZone: "UTC" })
  async notifyExpiring(now: Date = new Date()): Promise<number> {
    const utcDate = now.toISOString().slice(0, 10);
    let written = 0;
    try {
      const groups = await withSystemContext(() => this.expiringGroups());
      for (const group of groups) {
        try {
          const wrote = await withUserContext(group.userId, async () => {
            const notice = await this.dispatch.notify(
              group.userId,
              buildProposalsExpiringNotification(
                group.count,
                group.earliestExpiresAt,
                utcDate,
              ),
            );
            return notice !== null;
          });
          if (wrote) written += 1;
        } catch (error) {
          this.logger.error(
            `AI review expiring notice failed for user ${group.userId}: ${describeError(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `AI review expiring notices could not run: ${describeError(error)}`,
      );
    }
    return written;
  }

  /** Users with at least one live `proposed` request; across users. */
  private usersWithOpenProposals(): Promise<string[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{ user_id: string }>(
        await m.query(
          `SELECT DISTINCT user_id
             FROM ai_review_requests
            WHERE status = 'proposed'
              AND expires_at > CURRENT_TIMESTAMP
            ORDER BY user_id`,
        ),
      );
      return rows.map((row) => row.user_id);
    });
  }

  /** `proposed` requests inside the expiring window, grouped by user; across users. */
  private expiringGroups(): Promise<
    { userId: string; count: number; earliestExpiresAt: Date }[]
  > {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{
        user_id: string;
        total: string;
        earliest: Date | string;
      }>(
        await m.query(
          `SELECT user_id, COUNT(*) AS total, MIN(expires_at) AS earliest
             FROM ai_review_requests
            WHERE status = 'proposed'
              AND expires_at >= CURRENT_TIMESTAMP + make_interval(days => $1)
              AND expires_at < CURRENT_TIMESTAMP + make_interval(days => $2)
            GROUP BY user_id
            ORDER BY user_id`,
          [AI_REVIEW_EXPIRING_FROM_DAYS, AI_REVIEW_EXPIRING_TO_DAYS],
        ),
      );
      return rows
        .map((row) => ({
          userId: row.user_id,
          count: toCount(row.total),
          earliestExpiresAt: new Date(row.earliest),
        }))
        .filter(
          (row) =>
            row.count > 0 && Number.isFinite(row.earliestExpiresAt.getTime()),
        );
    });
  }

  /**
   * One user, inside that user's identity: the live proposals, and how many of
   * them were proposed since the user's newest ready notice (dismissed or not).
   * `updated_at` is set by the `update_ai_review_requests_updated_at` trigger
   * when a request becomes `proposed`, and a `proposed` row's every other
   * UPDATE moves it out of `proposed`. Both timestamps are the database clock.
   * No earlier notice means every live proposal counts.
   */
  private async notifyUserReady(
    userId: string,
    utcHour: string,
  ): Promise<boolean> {
    const { count, added } = await withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{ total: string; added: string }>(
        await m.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (
                    WHERE r.updated_at > COALESCE(
                      (SELECT MAX(n.created_at)
                         FROM notifications n
                        WHERE n.user_id = $1 AND n.alert_type = $2),
                      '-infinity'::timestamptz)
                  ) AS added
             FROM ai_review_requests r
            WHERE r.user_id = $1
              AND r.status = 'proposed'
              AND r.expires_at > CURRENT_TIMESTAMP`,
          [userId, NotificationType.AI_REVIEW_PROPOSALS_READY],
        ),
      );
      return {
        count: toCount(rows[0]?.total),
        added: toCount(rows[0]?.added),
      };
    });
    if (added === 0) return false;
    const notice = await this.dispatch.notify(
      userId,
      buildProposalsReadyNotification(count, added, utcHour),
    );
    return notice !== null;
  }
}
