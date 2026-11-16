import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { CLUSTER_MODE } from "./cluster-mode";
import { ClusterModule } from "./cluster.module";
import { PG_LISTENER, PgListener } from "./pg-listener.provider";
import { ReplicaCensusService } from "./replica-census.service";

/**
 * Stands in for `TypeOrmModule.forRoot`, which is global in the application:
 * the census is constructed with the `DataSource` and never queries it here.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { transaction: jest.fn() } }],
  exports: [DataSource],
})
class FakeDataSourceModule {}

/**
 * The module's whole job is a branch, so the spec is that branch both ways.
 *
 * The assertion that matters for a `single` deployment is not "the value is
 * null" but "nothing was built": a deployment that never opted into clustering
 * must not acquire a second database connection, a reconnect timer or a
 * shutdown step because the code that could is present.
 */
describe("ClusterModule", () => {
  const originalMode = process.env.CLUSTER_MODE;

  const build = async (mode: string | undefined): Promise<TestingModule> => {
    if (mode === undefined) delete process.env.CLUSTER_MODE;
    else process.env.CLUSTER_MODE = mode;
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        FakeDataSourceModule,
        ClusterModule,
      ],
    }).compile();
  };

  afterEach(() => {
    if (originalMode === undefined) delete process.env.CLUSTER_MODE;
    else process.env.CLUSTER_MODE = originalMode;
  });

  describe("CLUSTER_MODE=single (and unset)", () => {
    it.each([undefined, "single"])("binds no listener (%s)", async (mode) => {
      const module = await build(mode);

      expect(module.get(CLUSTER_MODE)).toBe("single");
      expect(module.get(PG_LISTENER)).toBeNull();

      await module.close();
    });

    it("shuts down without anything to close", async () => {
      const module = await build("single");
      await expect(module.close()).resolves.toBeUndefined();
    });
  });

  describe("CLUSTER_MODE=multi", () => {
    it("binds a listener, without opening it", async () => {
      const module = await build("multi");

      const listener = module.get<PgListener>(PG_LISTENER);
      expect(listener).toBeInstanceOf(PgListener);
      // The factory opens no socket: connecting is main.ts's, before
      // app.listen, so a database host that cannot hold a LISTEN is one line in
      // the log rather than a bootstrap rejection.
      expect(listener.isConnected()).toBe(false);

      await module.close();
    });

    it("closes the listener on shutdown", async () => {
      const module = await build("multi");
      const listener = module.get<PgListener>(PG_LISTENER);
      const close = jest.spyOn(listener, "close");

      await module.close();

      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["single", "multi"])(
    "exports the replica census in %s",
    async (mode) => {
      const module = await build(mode);

      expect(module.get(ReplicaCensusService)).toBeInstanceOf(
        ReplicaCensusService,
      );

      await module.close();
    },
  );

  it("refuses to build on an unreadable mode", async () => {
    // Same refusal as the boot matrix: a typo must not silently pick a mode.
    await expect(build("cluster")).rejects.toThrow(/Invalid CLUSTER_MODE/);
  });
});
