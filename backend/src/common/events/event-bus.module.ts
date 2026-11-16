import { Global, Module } from "@nestjs/common";

import { ClusterModule } from "../cluster/cluster.module";
import { CLUSTER_MODE, ClusterMode } from "../cluster/cluster-mode";
import { PG_LISTENER, PgListener } from "../cluster/pg-listener.provider";
import { EVENT_BUS, EventBus } from "./event-bus.interface";
import { MemoryEventBus } from "./memory-event-bus";
import { PostgresEventBus } from "./postgres-event-bus";

/**
 * Binds the active `EventBus`.
 *
 * `@Global()` and imported only by `AppModule`, the shape `DemoModeModule`
 * uses: the bus is reached from the relay, and later from anything else that
 * needs to wake a waiter, and a module edge from each of those would be a
 * require cycle waiting to happen (`module-graph.spec.ts` fails one without a
 * `forwardRef`).
 *
 * The factory picks by mode: `PostgresEventBus` over the replica's `LISTEN`
 * connection in `multi`, `MemoryEventBus` in `single`, where every subscriber is
 * in the publishing process and a wake-up is a function call.
 *
 * A `multi` deployment with no listener bound is a wiring defect rather than a
 * mode: the factory refuses instead of quietly falling back to the memory bus,
 * which would leave every SSE stream waiting on its slow poll and nothing in
 * the log to say why. `main.ts` refuses the boot before this is reached, so the
 * throw is a second wall, not the first.
 */
@Global()
@Module({
  // ClusterModule is `@Global()`, so in the running application its providers
  // resolve here whether or not this imports it. Named anyway: the factory
  // below genuinely cannot be built without them, and a module that depends on
  // another only through the global registry cannot be instantiated on its own
  // -- which is the difference between a spec that exercises the real wiring
  // and one that hand-builds a substitute for it.
  imports: [ClusterModule],
  providers: [
    MemoryEventBus,
    {
      provide: EVENT_BUS,
      useFactory: async (
        mode: ClusterMode,
        memory: MemoryEventBus,
        listener: PgListener | null,
      ): Promise<EventBus> => {
        if (mode !== "multi") {
          return memory;
        }
        if (!listener) {
          throw new Error(
            "CLUSTER_MODE=multi has no notification connection, so replicas " +
              "cannot wake each other. This is a wiring defect in " +
              "ClusterModule, not a configuration one.",
          );
        }
        const bus = new PostgresEventBus(listener);
        await bus.start();
        return bus;
      },
      inject: [CLUSTER_MODE, MemoryEventBus, PG_LISTENER],
    },
  ],
  exports: [EVENT_BUS],
})
export class EventBusModule {}
