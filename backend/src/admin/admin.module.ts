import { Module } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AdminController } from "./admin.controller";
import { OAuthModule } from "../oauth/oauth.module";
import { UsersModule } from "../users/users.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttachmentsModule } from "../attachments/attachments.module";
import { BackupModule } from "../backup/backup.module";

@Module({
  imports: [
    OAuthModule,
    UsersModule,
    NotificationsModule,
    // The two storage figures the user list shows. Both are read through the
    // service that owns the storage rather than queried here: attachment sizes
    // come from the metadata rows AttachmentsService owns, and the backup
    // totals from AutoBackupService, which is the only thing that knows how a
    // user's namespace is spelled in whichever store this deployment writes to.
    AttachmentsModule,
    BackupModule,
  ],
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
