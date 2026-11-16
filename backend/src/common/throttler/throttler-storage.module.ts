import { Module } from "@nestjs/common";

import { PostgresThrottlerStorage } from "./postgres-throttler-storage";

/**
 * Makes the throttler's PostgreSQL storage injectable into
 * `ThrottlerModule.forRootAsync`.
 *
 * A one-provider module rather than an entry in `AppModule`'s own `providers`,
 * because `forRootAsync` resolves its `inject` list inside the dynamic module it
 * builds: a provider declared beside it in `AppModule` is not in scope there,
 * and the failure is a boot-time "Nest can't resolve dependencies" naming a
 * class that is plainly present. `imports` on the async options is how that
 * scope is opened, and this is the module to hand it.
 *
 * `DataSource` needs no import here -- `TypeOrmCoreModule` is global.
 */
@Module({
  providers: [PostgresThrottlerStorage],
  exports: [PostgresThrottlerStorage],
})
export class ThrottlerStorageModule {}
