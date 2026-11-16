import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager, IsNull } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { Notification } from "./entities/notification.entity";
import {
  NotificationReminder,
  ReminderRepeatMode,
} from "./entities/notification-reminder.entity";
import { NotificationService } from "./notification.service";
import { CreateNotificationReminderDto } from "./dto/create-notification-reminder.dto";
import {
  MAX_ACTIVE_REMINDERS_PER_USER,
  REMINDER_MAX_INTERVAL_MINUTES,
  REMINDER_MIN_INTERVAL_MINUTES,
} from "./notification-reminder.constants";

/** Longest `dedupe_base`, matching `notification_reminders.dedupe_base`. */
export const DEDUPE_BASE_MAX_LENGTH = 80;

/** Owner-only reminder view; structured facts let the UI localize its copy. */
export interface NotificationReminderView {
  id: string;
  sourceNotificationId: string | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  data?: Record<string, unknown> | null;
  target: string | null;
  repeatMode: ReminderRepeatMode;
  intervalMinutes: number;
  nextFireAt: string;
  lastFiredAt: string | null;
  fireCount: number;
  createdAt: string;
}

/**
 * Repeating / one-time notification reminders
 * (`docs/specs/notification-preferences.md` Section 13).
 *
 * A reminder re-delivers one notification's subject on an interval until the
 * user stops it or its source is dismissed. Each fire re-emits through the ONE
 * write door (`NotificationService.create`) with a per-fire dedupe key, so every
 * re-delivery is a fresh in-app row -- the in-app channel is always written
 * (Section 3) -- and the firing itself lives in
 * `notifications/notification-reminder-cron.service.ts`, beside the dispatch
 * seam it re-emits through, so a repeat nag also pushes and emails per the
 * matrix. This leaf keeps the CRUD and the stop door: `NotificationCenterModule`
 * depends on nothing but the connection, and a cron that imports the delivery
 * side cannot live in it without pulling the whole producer cycle in.
 */
@Injectable()
export class NotificationReminderService {
  private readonly logger = new Logger(NotificationReminderService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Create -- or re-configure -- a reminder for one of the caller's own live
   * notifications.
   *
   * The notification's content is read server-side from the source row (owned by
   * the caller) and copied into the template -- never taken from the request --
   * and the load and the write share one transaction so a source that vanishes
   * between the two cannot leave a reminder pointing at nothing.
   *
   * At most one ACTIVE reminder exists per (user, source): a second "remind me"
   * on the same notification re-configures the existing one rather than adding a
   * parallel nag (the `idx_notification_reminders_active_source` unique index is
   * the backstop against a concurrent double-submit). Only a genuinely new
   * reminder counts against the per-user cap.
   */
  async create(
    userId: string,
    dto: CreateNotificationReminderDto,
  ): Promise<NotificationReminderView> {
    const intervalMinutes = this.clampInterval(dto.intervalMinutes);

    const row = await withScopedDb(this.dataSource, async (manager) => {
      const source = await manager.getRepository(Notification).findOne({
        where: {
          id: dto.sourceNotificationId,
          userId,
          dismissedAt: IsNull(),
        },
      });
      if (!source) {
        // "Not yours" and "already dismissed" are the same answer, as on the
        // notification service: both mean there is nothing here to nag about.
        throw new NotFoundException(
          tr(
            "errors.notifications.notFound",
            `Notification with ID ${dto.sourceNotificationId} not found`,
            { id: dto.sourceNotificationId },
          ),
        );
      }
      if (isReminderReEmit(source)) {
        // A nag is not a source. The parent reminder's next fire DISMISSES its
        // previous nag (one live nag per reminder), so a child reminder pointed
        // at one would be stopped by the orphan sweep a tick later with nothing
        // telling the user. The UI hides the control on a nag row; this is the
        // server saying the same thing to a caller that did not go through it.
        throw new BadRequestException(
          tr(
            "errors.notifications.reminderOnReminder",
            "A reminder cannot be set on a reminder's own notification. Set it on the original notification instead.",
          ),
        );
      }

      // The unique-index race is recovered INSIDE this transaction, so the
      // losing INSERT must not abort it: PostgreSQL refuses every statement
      // after an error until the transaction -- or a savepoint -- is rolled
      // back (25P02, "current transaction is aborted"), and the re-read of the
      // winner's row is a statement. The savepoint is what makes the retry
      // reachable; without it the recovery path was a second error dressed as
      // a 500. Same shape as the QIF import's per-row savepoint.
      await manager.query(`SAVEPOINT ${UPSERT_SAVEPOINT}`);
      try {
        const saved = await this.upsertForSource(
          manager,
          userId,
          source,
          dto.repeatMode,
          intervalMinutes,
        );
        await manager.query(`RELEASE SAVEPOINT ${UPSERT_SAVEPOINT}`);
        return saved;
      } catch (error) {
        // Anything but the active-per-source conflict surfaces as it is; the
        // ambient transaction rolls back whole, savepoint included.
        if (!isActiveReminderConflict(error)) throw error;
        // A concurrent create for the same source lost the unique-index race:
        // roll back to the savepoint so the transaction is usable again, then
        // re-read the row the winner wrote and apply this caller's settings
        // (last write wins), rather than surfacing a 500.
        await manager.query(`ROLLBACK TO SAVEPOINT ${UPSERT_SAVEPOINT}`);
        return this.upsertForSource(
          manager,
          userId,
          source,
          dto.repeatMode,
          intervalMinutes,
        );
      }
    });

    return toReminderView(row);
  }

  /**
   * Insert a reminder for this source, or re-configure the one active reminder
   * that already exists for it. The template is refreshed from the (current)
   * source on every call. A new row is subject to the per-user cap; a
   * re-configuration is not.
   */
  private async upsertForSource(
    manager: EntityManager,
    userId: string,
    source: Notification,
    repeatMode: ReminderRepeatMode,
    intervalMinutes: number,
  ): Promise<NotificationReminder> {
    const repo = manager.getRepository(NotificationReminder);
    const existing = await repo.findOne({
      where: {
        userId,
        sourceNotificationId: source.id,
        stoppedAt: IsNull(),
      },
    });

    const reminder = existing ?? new NotificationReminder();
    reminder.userId = userId;
    reminder.sourceNotificationId = source.id;
    reminder.type = source.type;
    reminder.severity = source.severity;
    reminder.title = source.title;
    reminder.message = source.message;
    reminder.data = source.data ?? {};
    reminder.target = source.target;
    // The source's own dedupe key names its subject where it has one (system
    // notifications), else its type -- the fire ordinal makes each re-emit
    // distinct regardless.
    reminder.dedupeBase = (source.dedupeKey ?? source.type).slice(
      0,
      DEDUPE_BASE_MAX_LENGTH,
    );
    reminder.repeatMode = repeatMode;
    reminder.intervalMinutes = intervalMinutes;
    // The source already delivered the first occurrence; the first nag comes one
    // interval later. A re-configure restarts the schedule but NOT the fire
    // count: the count is the ordinal in every re-emitted row's dedupe key
    // (`reEmit`), so a reset would replay keys the write door already holds and
    // ON CONFLICT DO NOTHING would swallow the next fires in silence.
    reminder.nextFireAt = new Date(Date.now() + intervalMinutes * 60_000);
    if (!existing) reminder.fireCount = 0;
    reminder.stoppedAt = null;

    if (!existing) {
      const active = await repo.count({
        where: { userId, stoppedAt: IsNull() },
      });
      if (active >= MAX_ACTIVE_REMINDERS_PER_USER) {
        throw new BadRequestException(
          tr(
            "errors.notifications.tooManyReminders",
            `You can have at most ${MAX_ACTIVE_REMINDERS_PER_USER} active reminders. Stop one before adding another.`,
            { max: MAX_ACTIVE_REMINDERS_PER_USER },
          ),
        );
      }
    }

    return repo.save(reminder);
  }

  /** The caller's active reminders, newest first. */
  async list(userId: string): Promise<NotificationReminderView[]> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(NotificationReminder).find({
        where: { userId, stoppedAt: IsNull() },
        order: { createdAt: "DESC" },
      }),
    );
    return rows.map(toReminderView);
  }

  /**
   * Stop one reminder. Idempotent and ownership-scoped: stopping an already
   * stopped reminder, or one that is not the caller's, returns `{ stopped:
   * false }` rather than a 404 -- the push Stop action needs a call it can make
   * more than once, and distinguishing "not yours" from "already stopped" would
   * leak whether the id exists.
   */
  async stop(userId: string, id: string): Promise<{ stopped: boolean }> {
    const stopped = await withScopedDb(this.dataSource, (manager) =>
      this.stopByOwner(manager, userId, id),
    );
    return { stopped };
  }

  /** One place the stop UPDATE lives, so `stop` and any future caller agree. */
  private async stopByOwner(
    manager: EntityManager,
    userId: string,
    id: string,
  ): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(
      await manager.query(
        `UPDATE notification_reminders
            SET stopped_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2 AND stopped_at IS NULL
        RETURNING id`,
        [id, userId],
      ),
    );
    return rows.length > 0;
  }

  private clampInterval(minutes: number): number {
    return Math.min(
      REMINDER_MAX_INTERVAL_MINUTES,
      Math.max(REMINDER_MIN_INTERVAL_MINUTES, Math.round(minutes)),
    );
  }
}

/** Whether a row is a reminder's re-emitted nag (`data.reminderId`, set by the cron). */
function isReminderReEmit(row: Notification): boolean {
  const value = (row.data as Record<string, unknown> | null | undefined)
    ?.reminderId;
  return typeof value === "string" && value.length > 0;
}

/** The unique index that keeps one active reminder per (user, source). */
const ACTIVE_SOURCE_INDEX = "idx_notification_reminders_active_source";

/** The savepoint `create` wraps its first upsert attempt in (a fixed identifier, never input). */
const UPSERT_SAVEPOINT = "notification_reminder_upsert";

/**
 * A unique-violation on the active-per-source index, and only that -- so a
 * concurrent double-submit is recovered by re-reading and updating the winner's
 * row, while any other error still surfaces. Scoped to the index name rather
 * than a bare 23505, so a different constraint is never mistaken for this one.
 */
function isActiveReminderConflict(error: unknown): boolean {
  const wrapped = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
    driverError?: { code?: unknown; constraint?: unknown; message?: unknown };
  };
  const code = wrapped?.code ?? wrapped?.driverError?.code;
  if (code !== "23505") return false;
  const constraint = wrapped?.constraint ?? wrapped?.driverError?.constraint;
  const message = `${wrapped?.message ?? ""} ${wrapped?.driverError?.message ?? ""}`;
  return (
    constraint === ACTIVE_SOURCE_INDEX || message.includes(ACTIVE_SOURCE_INDEX)
  );
}

function toReminderView(row: NotificationReminder): NotificationReminderView {
  return {
    id: row.id,
    sourceNotificationId: row.sourceNotificationId,
    type: row.type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    data: row.data,
    target: row.target,
    repeatMode: row.repeatMode,
    intervalMinutes: row.intervalMinutes,
    nextFireAt: new Date(row.nextFireAt).toISOString(),
    lastFiredAt: row.lastFiredAt
      ? new Date(row.lastFiredAt).toISOString()
      : null,
    fireCount: row.fireCount,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
