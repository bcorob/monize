import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";

import {
  PG_LISTENER,
  PG_WAKEUP_CHANNEL,
} from "../cluster/pg-listener.provider";
import { EventBusModule } from "./event-bus.module";
import { PostgresEventBus } from "./postgres-event-bus";
import { EVENT_BUS, EventBus } from "./event-bus.interface";
import { MemoryEventBus } from "./memory-event-bus";

/**
 * Stands in for `TypeOrmModule.forRoot`, global in the application: the
 * `ClusterModule` this module imports builds `ReplicaCensusService` over the
 * `DataSource`, which is constructed here and never queried.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { transaction: jest.fn() } }],
  exports: [DataSource],
})
class FakeDataSourceModule {}

/**
 * The binding, not the bus. Which implementation the token resolves to is the
 * whole of what this module decides, and it is what task R6 changes -- so the
 * assertion is on `name`, the field an implementation cannot get wrong without
 * saying so.
 */
describe("EventBusModule", () => {
  it("binds EVENT_BUS to the in-process bus", async () => {
    const module = await Test.createTestingModule({
      imports: [FakeDataSourceModule, EventBusModule],
    }).compile();

    const bus = module.get<EventBus>(EVENT_BUS);
    expect(bus).toBeInstanceOf(MemoryEventBus);
    expect(bus.name).toBe("memory");

    await module.close();
  });

  it("hands every consumer the same instance", async () => {
    const module = await Test.createTestingModule({
      imports: [FakeDataSourceModule, EventBusModule],
    }).compile();

    // A per-consumer bus would deliver nothing across two of them, which is the
    // failure the relay would hit first and diagnose last.
    expect(module.get<EventBus>(EVENT_BUS)).toBe(module.get(MemoryEventBus));

    await module.close();
  });

  describe("in CLUSTER_MODE=multi", () => {
    const originalMode = process.env.CLUSTER_MODE;

    afterEach(() => {
      if (originalMode === undefined) delete process.env.CLUSTER_MODE;
      else process.env.CLUSTER_MODE = originalMode;
    });

    /**
     * The module resolves `PG_LISTENER` from the global `ClusterModule`, which
     * would open a real connection. Overriding the token is what keeps this a
     * unit test while still exercising the real factory.
     */
    const buildMulti = (listener: unknown) => {
      process.env.CLUSTER_MODE = "multi";
      return Test.createTestingModule({
        imports: [FakeDataSourceModule, EventBusModule],
      })
        .overrideProvider(PG_LISTENER)
        .useValue(listener)
        .compile();
    };

    const fakeListener = () => ({
      listened: [] as string[],
      listen(channel: string) {
        this.listened.push(channel);
        return Promise.resolve();
      },
      notify: () => Promise.resolve(),
      onNotification: () => () => undefined,
      // ClusterModule.onModuleDestroy closes the listener on teardown, so the
      // double has to answer that too or every case fails in afterEach.
      close: () => Promise.resolve(),
    });

    it("binds the PostgreSQL bus, not the in-process one", async () => {
      // The mutation this catches is the one the module's own docstring calls
      // out: falling back to the memory bus in multi leaves every SSE stream on
      // its slow poll with nothing in the log to say why.
      const module = await buildMulti(fakeListener());

      const bus = module.get<EventBus>(EVENT_BUS);
      expect(bus).toBeInstanceOf(PostgresEventBus);
      expect(bus.name).toBe("postgres");

      await module.close();
    });

    it("has already issued its LISTEN by the time the token resolves", async () => {
      // Without the awaited start(), the bus is bound and deaf: nothing else
      // in the application issues that statement.
      const listener = fakeListener();
      const module = await buildMulti(listener);

      module.get<EventBus>(EVENT_BUS);
      expect(listener.listened).toContain(PG_WAKEUP_CHANNEL);

      await module.close();
    });

    it("refuses to build when multi has no listener to wake anyone with", async () => {
      // A wiring defect, not a mode. Quietly returning the memory bus here is
      // the failure this refusal exists to make loud.
      await expect(buildMulti(null)).rejects.toThrow(
        /no notification connection/,
      );
    });
  });
});
