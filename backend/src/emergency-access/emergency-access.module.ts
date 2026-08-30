import { Module } from "@nestjs/common";
import { EmergencyAccessService } from "./emergency-access.service";
import { EmergencyAccessMonitorService } from "./emergency-access-monitor.service";
import { EmergencyAccessController } from "./emergency-access.controller";
import { EmergencyAccessClaimController } from "./emergency-access-claim.controller";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EncryptionModule } from "../common/encryption/encryption.module";

@Module({
  imports: [AuthModule, NotificationsModule, EncryptionModule],
  providers: [EmergencyAccessService, EmergencyAccessMonitorService],
  controllers: [EmergencyAccessController, EmergencyAccessClaimController],
})
export class EmergencyAccessModule {}
