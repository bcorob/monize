import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

import { NotificationCategory } from "./notification.entity";

/**
 * One row per (user, category): which delivery channels that user wants for a
 * family of notifications. See `docs/specs/notification-preferences.md`.
 *
 * `category` is a derived {@link NotificationCategory}, never a raw
 * `alert_type` -- so a new notification type needs no new preference row.
 *
 * Phase 1 carries the one channel live in production today, `email`. Push,
 * UnifiedPush and the throttle window arrive with the dispatch that reads them,
 * as their own columns, so the table never holds a channel nothing consults.
 * An ABSENT row means the default matrix (email defaults on, narrowed by the
 * global `user_preferences.notification_email` master switch) -- the resolver,
 * not this row, decides a default.
 */
@Entity("notification_preferences")
export class NotificationPreference {
  @PrimaryColumn({ type: "uuid", name: "user_id" })
  userId: string;

  @PrimaryColumn({ type: "varchar", length: 20 })
  category: NotificationCategory;

  /**
   * Report-mode email: the batch/digest emails that ship today (weekly/monthly
   * summaries, the daily bill reminder, budget-alert's batched critical email).
   * Live and never throttled -- a report is the batching. This is the channel
   * `resolveEmail` gates. Defaults on (an absent row keeps today's delivery).
   */
  @Column({ type: "boolean", default: true })
  email: boolean;

  /**
   * Notification-mode email: an immediate, one-per-event email, the channel the
   * throttle governs. No delivery path yet -- it lands with the push dispatch
   * (Phase 5), so the column is stored but rendered "coming soon" and defaults
   * off. See `docs/specs/notification-preferences.md` section 4.
   */
  @Column({ name: "email_notification", type: "boolean", default: false })
  emailNotification: boolean;

  /**
   * Per-category cooldown for the notification-mode fan-out, in minutes; 0
   * disables. Stored now, enforced in Phase 5 with the dispatch it gates. It
   * never suppresses the in-app row (the bell shows every notification).
   */
  @Column({ name: "throttle_minutes", type: "int", default: 0 })
  throttleMinutes: number;

  /**
   * Per-category web push: the other notification-mode fan-out beside the
   * immediate email, read by the Phase 5 dispatch and governed by the same
   * throttle. Defaults off -- a matrix cell cannot turn a device on, so push
   * stays off until the user enables a device and toggles the category.
   */
  @Column({ type: "boolean", default: false })
  push: boolean;

  /**
   * Per-category UnifiedPush/ntfy channel: the same encrypted Web Push wire as
   * `push`, delivered to a distributor endpoint instead of a browser vendor's
   * push service (spec section 15). Read by the dispatch beside `push` and
   * governed by the same throttle. Defaults off -- a matrix cell cannot register
   * a distributor, so it stays off until a UnifiedPush subscription exists.
   */
  @Column({ type: "boolean", default: false })
  unifiedpush: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
