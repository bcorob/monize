import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";

import {
  Notification,
  NotificationSeverity,
  NotificationType,
} from "./notification.entity";

/**
 * How a reminder re-delivers. The preference-level `off` from the spec's
 * Section 5 means *no reminder row exists*, so it is not a value here: a row is
 * always one of these two.
 */
export enum ReminderRepeatMode {
  /** Deliver a single follow-up after the interval, then stop. */
  ONCE = "once",
  /** Re-deliver every interval until stopped. */
  REPEAT = "repeat",
}

/**
 * An active, repeating (or one-shot follow-up) re-delivery of one notification's
 * subject, until the user stops it or its source is dismissed
 * (`docs/specs/notification-preferences.md` Section 13).
 *
 * The row carries the TEMPLATE a fire re-emits -- the same public fields a
 * notification row has -- so a fire re-emits without reloading the source,
 * which the user may have dismissed. The firing cron
 * (`notifications/notification-reminder-cron.service.ts`) re-emits through the
 * dispatch seam (`NotificationDispatchService.notify`): a fresh in-app row
 * (always written, Section 3), then push/email per the matrix and throttle.
 */
@Entity("notification_reminders")
export class NotificationReminder {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  /**
   * The notification whose subject this nags about. `ON DELETE SET NULL`, and
   * the reminder is stopped when the source is dismissed -- a nag cannot outlive
   * its cause.
   */
  @Column({ type: "uuid", name: "source_notification_id", nullable: true })
  sourceNotificationId: string | null;

  @ManyToOne(() => Notification, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "source_notification_id" })
  sourceNotification?: Notification | null;

  /** Still `alert_type` in the database, as on `notifications`. */
  @Column({ type: "varchar", length: 30, name: "alert_type" })
  type: NotificationType;

  @Column({ type: "varchar", length: 20 })
  severity: NotificationSeverity;

  @Column({ type: "varchar", length: 255 })
  title: string;

  @Column({ type: "text" })
  message: string;

  @Column({ type: "jsonb", default: {} })
  data: Record<string, unknown>;

  @Column({ type: "varchar", length: 255, nullable: true })
  target: string | null;

  /**
   * Base for the per-fire dedupe key; each fire appends the fire ordinal so
   * every re-emit is a fresh bell row. Bounded so `base:rem:<uuid>:<n>` stays
   * inside `notifications.dedupe_key` (120).
   */
  @Column({
    type: "varchar",
    length: 80,
    name: "dedupe_base",
    nullable: true,
  })
  dedupeBase: string | null;

  @Column({ type: "varchar", length: 10, name: "repeat_mode" })
  repeatMode: ReminderRepeatMode;

  @Column({ type: "int", name: "interval_minutes" })
  intervalMinutes: number;

  @Column({ type: "timestamp", name: "next_fire_at" })
  nextFireAt: Date;

  @Column({ type: "timestamp", name: "last_fired_at", nullable: true })
  lastFiredAt: Date | null;

  @Column({ type: "int", name: "fire_count", default: 0 })
  fireCount: number;

  @Column({ type: "timestamp", name: "stopped_at", nullable: true })
  stoppedAt: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
