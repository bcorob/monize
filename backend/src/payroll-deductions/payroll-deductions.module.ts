import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { NotificationsModule } from "../notifications/notifications.module";
import { PayrollDeductionRule } from "./entities/payroll-deduction-rule.entity";
import { PayrollDeductionResetReminderService } from "./payroll-deduction-reset-reminder.service";
import { PayrollDeductionsController } from "./payroll-deductions.controller";
import { PayrollDeductionsService } from "./payroll-deductions.service";

/**
 * Payroll deduction rules (docs/specs/payroll-deductions.md). The posting cap
 * and the read-model figures are plain functions in
 * `payroll-deduction-cap.ts` that take the caller's `EntityManager`, so the
 * scheduled-transactions module reaches them without a module edge and this
 * module's only feature import is `NotificationsModule`, for the reminder
 * cron's dispatch. Nothing reaches back here, so the edge is bare.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PayrollDeductionRule]),
    NotificationsModule,
  ],
  providers: [PayrollDeductionsService, PayrollDeductionResetReminderService],
  controllers: [PayrollDeductionsController],
  exports: [PayrollDeductionsService],
})
export class PayrollDeductionsModule {}
