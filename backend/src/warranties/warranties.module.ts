import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { DelegationModule } from "../delegation/delegation.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Warranty } from "./entities/warranty.entity";
import { WarrantyClaim } from "./entities/warranty-claim.entity";
import { WarrantiesController } from "./warranties.controller";
import { WarrantiesService } from "./warranties.service";
import { WarrantyClaimsController } from "./warranty-claims.controller";
import { WarrantyClaimsService } from "./warranty-claims.service";
import { WarrantyExpiryReminderService } from "./warranty-expiry-reminder.service";
import { WarrantyImportService } from "./warranty-import.service";

/**
 * Warranties and their claims (docs/specs/warranty-tracker.md). The
 * module reads the linked transaction and payee through their entities inside
 * its own transaction and never reaches a ledger writer (WTY-001,
 * `warranties.guard.spec.ts`). Its feature imports are `DelegationModule`,
 * for the account scope an acting delegate's linked purchases are narrowed to
 * (WTY-007), and `NotificationsModule`, for the expiry reminder cron's
 * dispatch; nothing reaches back here from either, so both edges are bare.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Warranty, WarrantyClaim]),
    DelegationModule,
    // For NotificationDispatchService: the expiry reminders are written through
    // it so the WARRANTIES category's channels apply (decision 10).
    NotificationsModule,
  ],
  providers: [
    WarrantiesService,
    WarrantyClaimsService,
    WarrantyExpiryReminderService,
    WarrantyImportService,
  ],
  controllers: [WarrantiesController, WarrantyClaimsController],
  exports: [WarrantiesService],
})
export class WarrantiesModule {}
