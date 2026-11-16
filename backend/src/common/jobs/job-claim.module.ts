import { Global, Module } from "@nestjs/common";
import { JobClaimService } from "./job-claim.service";
import { UserMaintenanceService } from "./user-maintenance.service";
import { FetchSyncService } from "./fetch-sync.service";

/**
 * Global so any cron can claim its work without every feature module
 * re-declaring the provider -- and so there is exactly one claim mechanism to
 * find when the next multi-replica job needs one.
 *
 * `FetchSyncService` lives here for that second reason: it is a different
 * mechanism (a deployment-wide lease, for work that belongs to no user) and it
 * belongs beside the per-user one, not off in the currencies module where only
 * one of its callers would find it.
 */
@Global()
@Module({
  providers: [JobClaimService, UserMaintenanceService, FetchSyncService],
  exports: [JobClaimService, UserMaintenanceService, FetchSyncService],
})
export class JobClaimModule {}
