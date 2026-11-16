import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { ReminderRepeatMode } from "../notification-center/entities/notification-reminder.entity";
import {
  NotificationService,
  DEDUPE_KEY_MAX_LENGTH,
} from "../notification-center/notification.service";
import {
  REMINDER_CRON_LIMIT_SPECS,
  resolveReminderCronLimits,
} from "./reminder-cron-limits";
import { NotificationDispatchService } from "./notification-dispatch.service";

/** One claimed, due row as the atomic UPDATE returns it (snake_case, new values). */
export interface ClaimedReminderRow {
  id: string;
  user_id: string;
  alert_type: string;
  severity: string;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  target: string | null;
  dedupe_base: string | null;
  repeat_mode: string;
  fire_count: number;
}

/** Default claim batch; deployments may override it at startup. */
export const CLAIM_BATCH = REMINDER_CRON_LIMIT_SPECS.claimBatch.default;
/** Default re-emit concurrency; deployments may override it at startup. */
export const REEMIT_CONCURRENCY =
  REMINDER_CRON_LIMIT_SPECS.reemitConcurrency.default;

/**
 * Fires due reminders (spec section 13.2/13.3). Lives here, in the delivery
 * layer, and not beside the reminder CRUD in `NotificationCenterModule`: a
 * re-emit goes through `NotificationDispatchService.notify`, so a repeat nag
 * interrupts by push and immediate email per the matrix and throttle -- which
 * is what makes the push Stop action (R4) reachable -- and the leaf module
 * cannot import the dispatch without pulling the producer cycle in.
 *
 * Two same-transaction follow-ups ride `notify`'s `onWritten` hook, so they
 * share the fresh row's fate: the previous nag of the same reminder is
 * dismissed (one live nag per reminder, so a month of un-opened repeats is not
 * a month of unread rows crowding the bell), and a one-shot is stopped in the
 * transaction that writes its single follow-up.
 */
@Injectable()
export class NotificationReminderCronService {
  private readonly logger = new Logger(NotificationReminderCronService.name);
  private readonly limits = resolveReminderCronLimits(process.env, this.logger);
  /** Whether a tick is in flight on this replica (see `fireDue`). */
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /**
   * Fire every due reminder, once per interval per replica-set.
   *
   * Every replica runs this, so the claim is a single conditional
   * `UPDATE ... RETURNING` (`docs/concurrency-and-idempotency.md`, atomic CAS):
   * it advances `next_fire_at` in the same statement that reads the row, so a
   * second replica's UPDATE blocks on the row lock, re-checks the `WHERE` against
   * the committed new value, and skips it -- each due row is claimed exactly
   * once. The claim commits BEFORE the re-emit, so a re-emit that fails skips
   * this occurrence and re-fires one interval later rather than risking a
   * double-fire.
   *
   * A `once` reminder is NOT stopped by the claim: consuming it here would commit
   * before the delivery, so a failed re-emit would lose the single follow-up with
   * no retry. It is stopped inside the same transaction that writes its
   * notification (`reEmit`), so the delivery and the stop cannot disagree --
   * a failure rolls back both and the next interval retries, delivering exactly
   * once.
   */
  @Cron("* * * * *")
  async fireDue(): Promise<void> {
    // @nestjs/schedule has no overlap guard: a tick that outlives its minute
    // (many due rows, a slow endpoint) would run beside the next one over the
    // same pool. The claim already makes that safe -- no row fires twice -- so
    // this guard is about not piling ticks up, not about correctness.
    if (this.running) return;
    this.running = true;
    try {
      // Stop any reminder whose cause is gone, before the claim so it cannot be
      // claimed this tick. Two shapes: the source was dismissed, or the source
      // was deleted -- the FK is ON DELETE SET NULL, so a purged read-but-never-
      // dismissed source leaves the reminder orphaned (source_notification_id
      // NULL), and a nag with no live cause must not run forever. Every reminder
      // has a source today, so NULL means orphaned. A cross-user sweep, so it
      // seeds its own system context (task C2).
      await withSystemContext(() =>
        withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `UPDATE notification_reminders r
                SET stopped_at = CURRENT_TIMESTAMP
              WHERE r.stopped_at IS NULL
                AND (
                  r.source_notification_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM notifications n
                     WHERE n.id = r.source_notification_id
                       AND n.dismissed_at IS NOT NULL
                  )
                )`,
          ),
        ),
      );

      // Claim due rows atomically. next_fire_at is set to now + interval (not
      // previous + interval) so a cron that missed several ticks fires once and
      // reschedules, never a catch-up burst.
      // Bounded by the configured claim batch (the rest are still due and
      // go next minute), and `FOR UPDATE SKIP LOCKED` so a concurrent replica's
      // tick takes different rows instead of queueing on the same ones. The
      // CTE names its column `due_id` so the RETURNING list stays unqualified.
      const claimed = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) =>
          returnedRows<ClaimedReminderRow>(
            await manager.query(
              `WITH due AS (
                 SELECT id AS due_id FROM notification_reminders
                  WHERE stopped_at IS NULL AND next_fire_at <= CURRENT_TIMESTAMP
                  ORDER BY next_fire_at
                  LIMIT $1
                  FOR UPDATE SKIP LOCKED
               )
               UPDATE notification_reminders
                  SET next_fire_at = CURRENT_TIMESTAMP
                                     + (interval_minutes * INTERVAL '1 minute'),
                      last_fired_at = CURRENT_TIMESTAMP,
                      fire_count = fire_count + 1
                 FROM due
                WHERE notification_reminders.id = due.due_id
              RETURNING id, user_id, alert_type, severity, title, message,
                        data, target, dedupe_base, repeat_mode, fire_count`,
              [this.limits.claimBatch],
            ),
          ),
        ),
      );

      if (claimed.length === 0) return;

      // Re-emits run a few at a time, each isolated: one user's failure must
      // not skip the rest, and one stalled push endpoint (bounded per send by
      // the sender's deadline) must not hold every other user's nag behind it.
      let fired = 0;
      for (let i = 0; i < claimed.length; i += this.limits.reemitConcurrency) {
        const batch = claimed.slice(i, i + this.limits.reemitConcurrency);
        const outcomes = await Promise.allSettled(
          batch.map((claim) =>
            withUserContext(claim.user_id, () => this.reEmit(claim)),
          ),
        );
        outcomes.forEach((outcome, index) => {
          if (outcome.status === "fulfilled") {
            fired += 1;
            return;
          }
          this.logger.error(
            `Failed to re-emit reminder ${batch[index].id}`,
            outcome.reason instanceof Error
              ? outcome.reason.stack
              : outcome.reason,
          );
        });
      }
      if (fired > 0) {
        this.logger.log(`Re-emitted ${fired} due reminder(s)`);
      }
    } catch (error) {
      this.logger.error(
        "Failed to fire due reminders",
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Re-emit one claimed reminder through the dispatch seam: a fresh bell row
   * (per-fire dedupe key), fanned out per the matrix and throttle like any other
   * notification, with the same-transaction follow-ups in `onWritten`.
   *
   * Runs under the caller's `withUserContext`. `notify` returns `null` when the
   * write door refused the row (its dedupe key already held), and then nothing
   * was delivered by THIS fire: the hook never ran, a one-shot stays claimable,
   * and the next interval tries the next ordinal.
   */
  private async reEmit(claim: ClaimedReminderRow): Promise<void> {
    const base = claim.dedupe_base ?? claim.alert_type;
    // `base:rem:<uuid>:<n>` -- the fire ordinal makes every re-emit distinct, so
    // ON CONFLICT DO NOTHING never swallows a nag against the still-live previous
    // one. Bounded to the column, dropping from the base rather than the ordinal
    // (the ordinal is what keeps it unique).
    const suffix = `:rem:${claim.id}:${claim.fire_count}`;
    const dedupeKey = `${base.slice(0, DEDUPE_KEY_MAX_LENGTH - suffix.length)}${suffix}`;

    const written = await this.dispatch.notify(
      claim.user_id,
      {
        type: claim.alert_type as NotificationType,
        severity: claim.severity as NotificationSeverity,
        title: claim.title,
        message: claim.message,
        // The reminder id travels on the row so the bell can offer a Stop
        // control and the push can carry the id its Stop action needs.
        data: {
          ...((claim.data ?? {}) as Record<string, unknown>),
          reminderId: claim.id,
        },
        target: claim.target,
        dedupeKey,
      },
      {
        onWritten: async (manager, row) => {
          // This nag supersedes the previous one of the same reminder: dismiss
          // it in the same transaction, so the bell holds one live nag per
          // reminder and the purge can retire the rest.
          await this.notifications.dismissSupersededReminderRows(
            claim.user_id,
            claim.id,
            row.id,
          );
          // A one-shot is stopped only once its follow-up is written, in this
          // same transaction. Guarded on `stopped_at IS NULL` so a concurrent
          // stop (the app, or the source-dismissed sweep) is not clobbered.
          if (claim.repeat_mode === ReminderRepeatMode.ONCE) {
            await manager.query(
              `UPDATE notification_reminders
                  SET stopped_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND user_id = $2 AND stopped_at IS NULL`,
              [claim.id, claim.user_id],
            );
          }
        },
      },
    );
    if (!written) {
      this.logger.warn(
        `Reminder ${claim.id}: follow-up ${claim.fire_count} was not written (dedupe key already held); leaving it claimable`,
      );
    }
  }
}
