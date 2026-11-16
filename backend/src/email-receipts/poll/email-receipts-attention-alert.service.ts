import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";

import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  NotificationSeverity,
  NotificationType,
} from "../../notification-center/entities/notification.entity";
import { CreateNotificationInput } from "../../notification-center/notification.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

/**
 * What waits for the owner in the receipts inbox: emails no profile claims
 * (`no_parser`) and emails a profile claims but could not read (`parse_failed`).
 * `unmatched` and `ambiguous` are a different question (which bank transaction)
 * and are deliberately not counted here.
 */
export interface EmailReceiptsAttentionCounts {
  noParser: number;
  parseFailed: number;
}

/** The notification a pair of counts raises, as a pure function of the counts. */
export function buildEmailReceiptsAttentionNotification(
  counts: EmailReceiptsAttentionCounts,
): CreateNotificationInput {
  return {
    type: NotificationType.EMAIL_RECEIPTS_ATTENTION,
    severity: NotificationSeverity.INFO,
    title: "Email receipts need attention",
    message: `Your receipts inbox holds ${counts.noParser} without a profile and ${counts.parseFailed} that their profile did not recognize. Open Monize to review.`,
    data: { noParser: counts.noParser, parseFailed: counts.parseFailed },
    // The receipts hub on its Emails tab (the tab has no status parameter).
    target: "/email-receipts?tab=emails",
    // One row per pair of counts: the unique (user_id, dedupe_key) index makes
    // the same pair a no-op on every later poll and on a second replica.
    dedupeKey: `email-receipts:${counts.noParser}:${counts.parseFailed}`,
  };
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Raises one notification per user when the receipts inbox holds emails that need
 * a profile (`no_parser`) or a fix (`parse_failed`), after the poll has processed
 * the mailbox. Called under the owner's identity (the cron's `withUserContext`, or
 * "Poll now" under the request's), so it opens no context of its own.
 *
 * Not repeated on every poll: a notification is raised only when a count GREW
 * past the owner's latest live attention row, and the dedupe key (the pair of
 * counts) makes a second replica or a repeated pair a no-op. Zero in both groups
 * raises nothing. It never throws: a failure is logged and the poll goes on.
 */
@Injectable()
export class EmailReceiptsAttentionAlertService {
  private readonly logger = new Logger(EmailReceiptsAttentionAlertService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /** Returns whether a notification was written. */
  async evaluate(userId: string): Promise<boolean> {
    try {
      const { counts, previous } = await withScopedDb(
        this.dataSource,
        async (manager) => {
          const grouped = returnedRows<{ status: string; total: string }>(
            await manager.query(
              `SELECT status, COUNT(*) AS total
                 FROM email_receipts
                WHERE user_id = $1 AND status IN ('no_parser', 'parse_failed')
                GROUP BY status`,
              [userId],
            ),
          );
          const read = (status: string): number =>
            count(grouped.find((row) => row.status === status)?.total);
          const prior = returnedRows<{ data: Record<string, unknown> | null }>(
            await manager.query(
              `SELECT data
                 FROM notifications
                WHERE user_id = $1 AND alert_type = $2 AND dismissed_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1`,
              [userId, NotificationType.EMAIL_RECEIPTS_ATTENTION],
            ),
          );
          return {
            counts: {
              noParser: read("no_parser"),
              parseFailed: read("parse_failed"),
            },
            previous: prior[0]
              ? {
                  noParser: count(prior[0].data?.noParser),
                  parseFailed: count(prior[0].data?.parseFailed),
                }
              : null,
          };
        },
      );

      if (counts.noParser + counts.parseFailed === 0) return false;
      if (
        previous !== null &&
        counts.noParser <= previous.noParser &&
        counts.parseFailed <= previous.parseFailed
      ) {
        return false;
      }
      const written = await this.dispatch.notify(
        userId,
        buildEmailReceiptsAttentionNotification(counts),
        // "Poll now" is a request: a stalled push endpoint must not hold it.
        { fanOut: "detached" },
      );
      return written !== null;
    } catch (error) {
      this.logger.warn(
        `Receipts attention alert failed user=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
