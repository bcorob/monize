import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SystemAlertService } from "./system-alert.service";
import { SystemAlertMonitorService } from "./system-alert-monitor.service";
import { DeploymentStatusController } from "./deployment-status.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { NotificationCenterModule } from "../notification-center/notification-center.module";

/**
 * System-level issues raised through the existing alerts interface (the
 * `notifications` bell), fanned out to administrators -- see
 * `docs/specs/system-alerts.md`.
 *
 * `forwardRef` because NotificationsModule imports this module back
 * (ProviderOutageAlertService raises the in-app companion rows), so the edge
 * sits on a require cycle -- `src/module-graph.spec.ts` proves it.
 */
@Module({
  imports: [
    ConfigModule,
    forwardRef(() => NotificationsModule),
    // For NotificationService: an admin alert lands as a notification row
    // through the one write door.
    NotificationCenterModule,
  ],
  providers: [SystemAlertService, SystemAlertMonitorService],
  // The admin banner's signal (a weak JWT_SECRET), read through the monitor so
  // the banner and the weekly alert apply one rule.
  controllers: [DeploymentStatusController],
  exports: [SystemAlertService],
})
export class SystemAlertsModule {}
