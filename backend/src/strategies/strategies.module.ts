import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CurrenciesModule } from "../currencies/currencies.module";
import { SecuritiesModule } from "../securities/securities.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Account } from "../accounts/entities/account.entity";
import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemStrategyAccount } from "./entities/gem-strategy-account.entity";
import { GemStrategyAsset } from "./entities/gem-strategy-asset.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategyController } from "./gem-strategy.controller";
import { GemStrategyService } from "./gem-strategy.service";
import { GemSignalService } from "./gem-signal.service";
import { GemPositionService } from "./gem-position.service";
import { GemPerformanceService } from "./gem-performance.service";
import { GemPriceService } from "./gem-price.service";
import { GemBackfillService } from "./gem-backfill.service";
import { GemBacktestService } from "./gem-backtest.service";
import { GemSignalChangeAlertService } from "./gem-signal-change-alert.service";

/**
 * Rule-based investing strategies. Currently GEM (Global Equities Momentum):
 * the signal is evaluated server-side and served as one read model to the
 * strategy report page.
 */
@Module({
  imports: [
    CurrenciesModule,
    SecuritiesModule,
    // For NotificationDispatchService: the GEM signal-change cron dispatches a
    // notification when a strategy's recommendation changes. NotificationsModule
    // does not import StrategiesModule, so there is no cycle (module-graph.spec).
    NotificationsModule,
    TypeOrmModule.forFeature([
      GemStrategy,
      GemStrategyAccount,
      GemStrategyAsset,
      GemStrategySignal,
      Account,
      Security,
      UserPreference,
    ]),
  ],
  controllers: [GemStrategyController],
  providers: [
    GemStrategyService,
    GemSignalService,
    GemPositionService,
    GemPerformanceService,
    GemPriceService,
    GemBackfillService,
    GemBacktestService,
    GemSignalChangeAlertService,
  ],
  exports: [GemStrategyService],
})
export class StrategiesModule {}
