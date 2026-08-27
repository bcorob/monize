import { Module, forwardRef } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { DelegationService } from "./delegation.service";
import { CrossOwnerAccessService } from "./cross-owner-access.service";
import { JointAccountsService } from "./joint-accounts.service";
import { DelegationController } from "./delegation.controller";
import { AccountDelegateGuard } from "./guards/account-delegate.guard";
import { DelegateTransferMaskInterceptor } from "./interceptors/delegate-transfer-mask.interceptor";
import { DelegateScheduledTransferMaskInterceptor } from "./interceptors/delegate-scheduled-transfer-mask.interceptor";
import { NotificationsModule } from "../notifications/notifications.module";

/**
 * Self-contained: registers its own JwtModule (same secret) so the global
 * AccountDelegateGuard can verify tokens without importing AuthModule, which
 * keeps AuthModule -> DelegationModule one-directional (no circular import).
 */
@Module({
  imports: [
    // forwardRef: NotificationsModule now reaches back here through
    // ScheduledTransactionsModule (issue #1247), so this edge closes a
    // module cycle -- see `src/module-graph.spec.ts`.
    forwardRef(() => NotificationsModule),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get("JWT_SECRET"),
        signOptions: {
          expiresIn: configService.get("JWT_EXPIRATION", "15m"),
          algorithm: "HS256" as const,
        },
        verifyOptions: {
          algorithms: ["HS256" as const],
        },
      }),
    }),
  ],
  controllers: [DelegationController],
  providers: [
    DelegationService,
    CrossOwnerAccessService,
    JointAccountsService,
    AccountDelegateGuard,
    DelegateTransferMaskInterceptor,
    DelegateScheduledTransferMaskInterceptor,
    // Providing APP_GUARD here registers it globally (Nest treats the
    // APP_GUARD token specially regardless of the declaring module).
    { provide: APP_GUARD, useExisting: AccountDelegateGuard },
  ],
  exports: [
    DelegationService,
    CrossOwnerAccessService,
    JointAccountsService,
    AccountDelegateGuard,
    DelegateTransferMaskInterceptor,
    DelegateScheduledTransferMaskInterceptor,
  ],
})
export class DelegationModule {}
