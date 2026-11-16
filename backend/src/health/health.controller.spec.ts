import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CLUSTER_MODE, ClusterMode } from "../common/cluster/cluster-mode";
import {
  PG_LISTENER,
  PgListener,
} from "../common/cluster/pg-listener.provider";
import { ReplicaCensusService } from "../common/cluster/replica-census.service";
import { PostgresThrottlerStorage } from "../common/throttler/postgres-throttler-storage";
import {
  EVENT_BUS_READINESS_GRACE_MS,
  HealthController,
} from "./health.controller";

describe("HealthController", () => {
  let controller: HealthController;
  let mockDataSource: Partial<DataSource>;
  let listener: { isConnected: jest.Mock; downForMs: jest.Mock } | null;

  /**
   * `downForMs` defaults to just-dropped, which is the state readiness must
   * tolerate: a database restart takes every replica's session at the same
   * instant, so failing on the state alone would empty the endpoint list.
   */
  let throttlerStorage: { degradedReason: jest.Mock };
  /** One process on the database by default: a correctly deployed single. */
  let census: { countActiveProcesses: jest.Mock; lastKnownCount: jest.Mock };

  const build = async (
    mode: ClusterMode,
    connected: boolean | null,
    downForMs = 0,
  ): Promise<void> => {
    mockDataSource = { query: jest.fn() };
    throttlerStorage = { degradedReason: jest.fn(() => null) };
    census = {
      countActiveProcesses: jest.fn().mockResolvedValue(1),
      lastKnownCount: jest.fn().mockReturnValue(1),
    };
    listener =
      connected === null
        ? null
        : {
            isConnected: jest.fn(() => connected),
            downForMs: jest.fn(() => downForMs),
          };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DataSource, useValue: mockDataSource },
        { provide: CLUSTER_MODE, useValue: mode },
        {
          provide: PG_LISTENER,
          useValue: listener as unknown as PgListener | null,
        },
        {
          provide: PostgresThrottlerStorage,
          useValue: throttlerStorage as unknown as PostgresThrottlerStorage,
        },
        {
          provide: ReplicaCensusService,
          useValue: census as unknown as ReplicaCensusService,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  };

  const databaseUp = () =>
    (mockDataSource.query as jest.Mock).mockResolvedValue([{ "?column?": 1 }]);
  const databaseDown = () =>
    (mockDataSource.query as jest.Mock).mockRejectedValue(
      new Error("connection failed"),
    );

  describe("in CLUSTER_MODE=single", () => {
    beforeEach(async () => {
      await build("single", null);
    });

    describe("check()", () => {
      it("returns ok status when database is healthy", async () => {
        databaseUp();

        const result = await controller.check();

        expect(result.status).toBe("ok");
        expect(result.checks.database).toBe("healthy");
        expect(result.timestamp).toBeDefined();
      });

      it("returns degraded status when database is unhealthy", async () => {
        databaseDown();

        const result = await controller.check();

        expect(result.status).toBe("degraded");
        expect(result.checks.database).toBe("unhealthy");
      });

      it("says nothing about rate limiting while it is working", async () => {
        databaseUp();

        const result = await controller.check();

        // A key that is always present would be another constant to watch.
        expect(result.checks).not.toHaveProperty("rateLimiting");
      });

      it("reports a rate limiter that has silently stopped working", async () => {
        // The storage fails open by design, so a missing table or a missing
        // grant leaves every HTTP limit off while every other signal stays
        // green. This probe is the only place it surfaces.
        databaseUp();
        throttlerStorage.degradedReason.mockReturnValue(
          '42P01: relation "http_throttle_counters" does not exist',
        );

        const result = await controller.check();

        expect(result.status).toBe("degraded");
        expect(result.checks.database).toBe("healthy");
        expect(result.checks.rateLimiting).toBe("disabled");
      });

      it("omits the event bus, which does not exist here", async () => {
        databaseUp();

        const result = await controller.check();

        // A key that is always "healthy" invites a dashboard to watch a
        // constant, and a key that said "unhealthy" would report the absence of
        // a cross-replica channel as a fault.
        expect(result.checks).not.toHaveProperty("eventBus");
      });

      it("reports one backend process as ok", async () => {
        databaseUp();

        const result = await controller.check();

        expect(result.status).toBe("ok");
        expect(result.checks.replicas).toBe(1);
      });

      it("degrades when a second process shares the database", async () => {
        // single asserted there is one process; with two, every rate limit and
        // every cache invalidation is per process, silently.
        databaseUp();
        census.lastKnownCount.mockReturnValue(2);

        const result = await controller.check();

        expect(result.status).toBe("degraded");
        expect(result.checks.database).toBe("healthy");
        expect(result.checks.replicas).toBe(2);
      });

      it("omits the count, and does not degrade, when no recent census exists", async () => {
        // Before the first sweep, or after the census has failed for two
        // sweeps: nothing current to report, which is not a problem.
        databaseUp();
        census.lastKnownCount.mockReturnValue(null);

        const result = await controller.check();

        expect(result.status).toBe("ok");
        expect(result.checks).not.toHaveProperty("replicas");
      });

      it("never queries the census, whatever the database state", async () => {
        // The endpoint is unauthenticated and unthrottled; a pg_stat_activity
        // scan per request would let anyone load the database. It reads the
        // count the fifteen-minute sweep left behind.
        databaseUp();
        await controller.check();
        databaseDown();
        await controller.check();

        expect(census.countActiveProcesses).not.toHaveBeenCalled();
        expect(census.lastKnownCount).toHaveBeenCalledTimes(2);
      });

      it("leaves the census out of the probes", async () => {
        databaseUp();
        census.lastKnownCount.mockReturnValue(2);

        // A second replica is an operator's configuration to fix, not a reason
        // to restart this one or to take it out of the load balancer.
        await expect(controller.ready()).resolves.toEqual({ status: "ok" });
        expect(controller.live()).toEqual({ status: "ok" });
        expect(census.countActiveProcesses).not.toHaveBeenCalled();
        expect(census.lastKnownCount).not.toHaveBeenCalled();
      });
    });

    describe("live()", () => {
      it("always returns ok", () => {
        const result = controller.live();
        expect(result).toEqual({ status: "ok" });
      });
    });

    describe("ready()", () => {
      it("returns ok when database is healthy", async () => {
        databaseUp();

        const result = await controller.ready();
        expect(result).toEqual({ status: "ok" });
      });

      it("throws ServiceUnavailableException when database is unhealthy", async () => {
        databaseDown();

        await expect(controller.ready()).rejects.toThrow("Service not ready");
      });
    });
  });

  describe("in CLUSTER_MODE=multi", () => {
    describe("with the notification channel live", () => {
      beforeEach(async () => {
        await build("multi", true);
      });

      it("is ready", async () => {
        databaseUp();

        await expect(controller.ready()).resolves.toEqual({ status: "ok" });
      });

      it("reports the event bus as healthy", async () => {
        databaseUp();

        const result = await controller.check();

        expect(result.status).toBe("ok");
        expect(result.checks.eventBus).toBe("healthy");
      });

      it("reports no replica count, and never takes the census", async () => {
        // Peers are expected in multi, and a count there is a figure to watch
        // with nothing wrong at any value.
        databaseUp();
        census.lastKnownCount.mockReturnValue(3);

        const result = await controller.check();

        expect(result.status).toBe("ok");
        expect(result.checks).not.toHaveProperty("replicas");
        expect(census.countActiveProcesses).not.toHaveBeenCalled();
        expect(census.lastKnownCount).not.toHaveBeenCalled();
      });
    });

    describe("with the notification channel just dropped", () => {
      beforeEach(async () => {
        await build("multi", false, 0);
      });

      it("keeps serving, because the loss is correlated across the fleet", async () => {
        databaseUp();

        // Every replica loses its session at the same instant when the database
        // restarts. Failing readiness here would take every pod out of the
        // Service at once -- a total outage of every feature -- to avoid one
        // poll interval of extra latency on relay turns, which is all a missing
        // wake-up costs.
        await expect(controller.ready()).resolves.toEqual({ status: "ok" });
      });

      it("still reports the outage for alerting, with no grace period", async () => {
        databaseUp();

        const result = await controller.check();

        // The monitor should see it the moment it starts; only the decision to
        // stop serving waits.
        expect(result.status).toBe("degraded");
        expect(result.checks.database).toBe("healthy");
        expect(result.checks.eventBus).toBe("unhealthy");
      });
    });

    describe("with the notification channel down past the grace period", () => {
      beforeEach(async () => {
        await build("multi", false, EVENT_BUS_READINESS_GRACE_MS + 1);
      });

      it("leaves the load balancer", async () => {
        databaseUp();

        // The reconnect ladder has had several full attempts by now, so this
        // replica is probably not coming back on its own.
        await expect(controller.ready()).rejects.toThrow("Service not ready");
      });

      it("recovers when the connection returns", async () => {
        databaseUp();
        await expect(controller.ready()).rejects.toThrow("Service not ready");

        listener!.isConnected.mockReturnValue(true);
        listener!.downForMs.mockReturnValue(0);

        await expect(controller.ready()).resolves.toEqual({ status: "ok" });
      });

      it("is exactly a threshold, not a rounding", async () => {
        databaseUp();
        listener!.downForMs.mockReturnValue(EVENT_BUS_READINESS_GRACE_MS);

        // At the boundary the replica is still given the benefit of the doubt.
        await expect(controller.ready()).resolves.toEqual({ status: "ok" });
      });
    });

    it("treats a missing listener as down with no grace at all", async () => {
      // multi with no listener bound is a wiring defect rather than an outage:
      // there is nothing to wait for, so there is no grace to give.
      await build("multi", null);
      databaseUp();

      await expect(controller.ready()).rejects.toThrow("Service not ready");
      expect((await controller.check()).checks.eventBus).toBe("unhealthy");
    });

    it("does not consult the listener before the database", async () => {
      await build("multi", true);
      databaseDown();

      await expect(controller.ready()).rejects.toThrow("Service not ready");
      // The database is the more fundamental failure and the cheaper check to
      // report; asking the listener after it is refused costs nothing, but the
      // refusal must not depend on the listener's answer.
      expect(listener!.isConnected).not.toHaveBeenCalled();
    });
  });
});
