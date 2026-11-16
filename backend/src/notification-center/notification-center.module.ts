import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Notification } from "./entities/notification.entity";
import { NotificationPreference } from "./entities/notification-preference.entity";
import { NotificationReminder } from "./entities/notification-reminder.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationService } from "./notification.service";
import { NotificationPreferenceService } from "./notification-preference.service";
import { NotificationPreferenceController } from "./notification-preference.controller";
import { NotificationReminderService } from "./notification-reminder.service";
import { NotificationReminderController } from "./notification-reminder.controller";

/**
 * The durable `notifications` table and the one service that reads and writes
 * it. Deliberately depends on nothing but the connection.
 *
 * That is what keeps it out of every require cycle in the graph: budgets,
 * system alerts, backups and scheduled transactions all produce notifications,
 * so anything this module imported would become reachable from all of them. The
 * HTTP surface, which does need a producer (bill reminders are materialized on
 * read), is a separate module for the same reason -- see
 * `notification-api.module.ts`.
 *
 * Not to be confused with `NotificationsModule` (`src/notifications/`), which is
 * the delivery side -- SMTP, the email templates, the provider-outage watcher. A
 * business feature asks this module for a notification and never imports a
 * transport; see `docs/backend/notifications-and-push.md`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      NotificationReminder,
      UserPreference,
    ]),
  ],
  controllers: [
    NotificationPreferenceController,
    NotificationReminderController,
  ],
  providers: [
    NotificationService,
    NotificationPreferenceService,
    NotificationReminderService,
  ],
  exports: [
    NotificationService,
    NotificationPreferenceService,
    NotificationReminderService,
  ],
})
export class NotificationCenterModule {}
