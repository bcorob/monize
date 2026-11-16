import { Module } from "@nestjs/common";

import { ThrottlerStorageModule } from "../common/throttler/throttler-storage.module";
import { HealthController } from "./health.controller";

/**
 * `ThrottlerStorageModule` because `/health` reports whether rate limiting is
 * actually functioning. The storage fails open by design, so a structural
 * failure is invisible on every other signal -- the probe is where it surfaces.
 */
@Module({
  imports: [ThrottlerStorageModule],
  controllers: [HealthController],
})
export class HealthModule {}
