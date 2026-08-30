import { Module } from "@nestjs/common";
import { ProviderHealthService } from "./provider-health.service";

/**
 * Availability tracking for the outbound market-data providers.
 *
 * Deliberately a leaf: it depends on nothing but `DataSource`, so
 * `SecuritiesModule` can import it for the quote clients with no cycle. The
 * alert cron lives in `NotificationsModule`, which owns every email in this
 * codebase; it reads `provider_health` directly and needs only the plain
 * `providerLabel` helper, so it imports nothing from this module.
 */
@Module({
  providers: [ProviderHealthService],
  exports: [ProviderHealthService],
})
export class ProviderHealthModule {}
