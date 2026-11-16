import { Global, Inject, Module, OnModuleDestroy } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { CLUSTER_MODE, ClusterMode, getClusterMode } from "./cluster-mode";
import {
  PG_LISTENER,
  PgListener,
  resolveListenerClientConfig,
} from "./pg-listener.provider";
import { ReplicaCensusService } from "./replica-census.service";

/**
 * What this process needs in order to be one replica of several.
 *
 * Two providers, the shape of `DemoModeModule`: the parsed `CLUSTER_MODE`, and
 * the `LISTEN`/`NOTIFY` connection -- `null` in `single`, where the only
 * subscriber is in the publishing process and there is nothing to wake. A
 * third, `ReplicaCensusService`, counts the backend processes on this database,
 * so a `single` deployment that is not actually alone can say so (the system
 * alert sweep and `/health` read it).
 *
 * `@Global()` and imported only by `AppModule`. The listener is reached from
 * the event bus, from readiness, and later from anything else that has to wake
 * a waiter; a module edge from each of those is a require cycle waiting to
 * happen, which `module-graph.spec.ts` fails.
 *
 * The factory opens no socket. Connecting happens in `main.ts`, before
 * `app.listen`, so a database host that cannot hold a `LISTEN` is one line in
 * the log rather than a bootstrap rejection with the cause buried in a stack
 * trace -- the same reasoning as the role and schema checks beside it.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: CLUSTER_MODE,
      useFactory: (): ClusterMode => getClusterMode(),
    },
    {
      provide: PG_LISTENER,
      useFactory: (
        mode: ClusterMode,
        config: ConfigService,
      ): PgListener | null =>
        mode === "multi"
          ? new PgListener(
              resolveListenerClientConfig((name) => config.get<string>(name)),
            )
          : null,
      inject: [CLUSTER_MODE, ConfigService],
    },
    ReplicaCensusService,
  ],
  exports: [CLUSTER_MODE, PG_LISTENER, ReplicaCensusService],
})
export class ClusterModule implements OnModuleDestroy {
  constructor(
    @Inject(PG_LISTENER) private readonly listener: PgListener | null,
  ) {}

  /**
   * Close the connection on shutdown. Without this a reconnect timer and an
   * open socket outlive the application context, so a test run or a graceful
   * restart waits on a connection nobody is reading.
   */
  async onModuleDestroy(): Promise<void> {
    await this.listener?.close();
  }
}
