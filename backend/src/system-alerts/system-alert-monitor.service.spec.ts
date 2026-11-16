import { Logger } from "@nestjs/common";
import type { ClusterMode } from "../common/cluster/cluster-mode";
import type { ReplicaCensusService } from "../common/cluster/replica-census.service";
import {
  isoWeekBucket,
  REPEATED_SEND_FAILURES,
  SMTP_FAILURE_LOOKBACK_MS,
  SystemAlertMonitorService,
} from "./system-alert-monitor.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type {
  EmailFailureSnapshot,
  EmailService,
} from "../notifications/email.service";

describe("SystemAlertMonitorService", () => {
  let systemAlerts: { raiseAdminAlert: jest.Mock };
  let emailService: jest.Mocked<
    Pick<EmailService, "getStatus" | "getFailureSnapshot" | "verifyConnection">
  >;
  /**
   * The replica's snapshot as the real `EmailService` holds it: one mutable
   * record that `getFailureSnapshot` copies out and `verifyConnection` writes
   * to, so a probe's outcome is visible to the re-read that follows it.
   */
  let current: EmailFailureSnapshot;
  let env: Record<string, string | undefined>;
  let census: { countActiveProcesses: jest.Mock };
  let service: SystemAlertMonitorService;

  const build = (mode: ClusterMode): SystemAlertMonitorService =>
    new SystemAlertMonitorService(
      { get: jest.fn((name: string) => env[name]) } as never,
      systemAlerts as never,
      emailService as unknown as EmailService,
      mode,
      census as unknown as ReplicaCensusService,
    );

  function snapshot(
    overrides: Partial<EmailFailureSnapshot> = {},
  ): EmailFailureSnapshot {
    return {
      lastFailureAt: null,
      lastFailureMessage: null,
      lastSuccessAt: null,
      failuresSinceSuccess: 0,
      recipientRejections: 0,
      lastProbeAt: null,
      lastProbeError: null,
      ...overrides,
    };
  }

  /** The probe instant: just after the sweep's `now` below. */
  const PROBED_AT = new Date("2026-08-30T12:00:01Z");

  /**
   * What `verifyConnection` does when `transporter.verify()` succeeds: the
   * probe's own fields, never the send record.
   */
  function probeSucceeds(): Promise<boolean> {
    current = { ...current, lastProbeAt: PROBED_AT, lastProbeError: null };
    return Promise.resolve(true);
  }

  /** What `verifyConnection` does when `transporter.verify()` rejects. */
  function probeFails(message: string): () => Promise<boolean> {
    return () => {
      current = { ...current, lastProbeAt: PROBED_AT, lastProbeError: message };
      return Promise.resolve(false);
    };
  }

  beforeEach(() => {
    env = {};
    current = snapshot();
    systemAlerts = {
      raiseAdminAlert: jest.fn().mockResolvedValue({ created: 1, emailed: 1 }),
    };
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      getFailureSnapshot: jest.fn(() => ({ ...current })),
      // Default: the relay is still unreachable when the sweep probes it.
      verifyConnection: jest
        .fn()
        .mockImplementation(probeFails("ECONNREFUSED 10.0.0.1:587")),
    };
    // One process on the database: what a correctly deployed single sees.
    census = { countActiveProcesses: jest.fn().mockResolvedValue(1) };
    service = build("single");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("weak JWT_SECRET check", () => {
    const RETIRED_PLACEHOLDER =
      "your-super-secret-jwt-key-change-in-production";
    const STRONG = "FkVtZprB4sKbrwNIl6YiZarB8gB9RrKoO0rt7sFg4YM=";

    it("raises a weekly-bucketed admin alert carrying only the reason code", async () => {
      env.JWT_SECRET = RETIRED_PLACEHOLDER;
      await service.checkJwtSecret(new Date("2026-08-30T12:00:00Z"));
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.JWT_SECRET_WEAK,
          severity: NotificationSeverity.WARNING,
          dedupeKey: "JWT_SECRET_WEAK:2026-W35",
          data: { system: true, reason: "placeholder" },
        }),
      );
      // Never the secret, nor any part of it, in anything the row stores.
      const [input] = systemAlerts.raiseAdminAlert.mock.calls[0];
      expect(JSON.stringify(input)).not.toContain("your-super-secret");
    });

    it("tells the admin how to fix it and what fixing it costs", async () => {
      env.JWT_SECRET = "x".repeat(40);
      await service.checkJwtSecret();
      const [input] = systemAlerts.raiseAdminAlert.mock.calls[0];
      expect(input.data).toEqual({ system: true, reason: "predictable" });
      expect(input.message).toContain("openssl rand -base64 32");
      expect(input.message).toMatch(/stops authenticator codes from working/);
      expect(input.message).toMatch(/backup code/);
      expect(input.message).toMatch(/reset 2FA in User Management/);
      expect(input.message).toContain("docs/backend/modules-and-runtime.md");
    });

    it("stays silent for a strong secret", async () => {
      env.JWT_SECRET = STRONG;
      await service.checkJwtSecret();
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("stays silent for a fatal secret, which never boots to be swept", async () => {
      env.JWT_SECRET = "short";
      await service.checkJwtSecret();
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("runs on the sweep, not on bootstrap", async () => {
      // Boot-only never fires on a fresh install (no administrator exists yet
      // when the server first starts, so the fan-out stands down), never
      // re-raises on the weekly bucket it is keyed on, and would make Nest
      // await a per-administrator SMTP fan-out inside `app.listen()`.
      expect(
        (service as unknown as Record<string, unknown>).onApplicationBootstrap,
      ).toBeUndefined();

      env.JWT_SECRET = RETIRED_PLACEHOLDER;
      await service.sweepSystemHealth(new Date("2026-08-30T12:00:00Z"));
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.JWT_SECRET_WEAK }),
      );
    });

    it("keeps re-raising on later sweeps, so a fresh install is told once an admin exists", async () => {
      // The weekly dedupe key -- not the number of sweeps -- is what bounds
      // the noise, and a raise that found no administrator has written
      // nothing to dedupe against.
      env.JWT_SECRET = RETIRED_PLACEHOLDER;
      systemAlerts.raiseAdminAlert.mockResolvedValue({
        created: 0,
        emailed: 0,
      });
      await service.sweepSystemHealth(new Date("2026-08-30T12:00:00Z"));
      await service.sweepSystemHealth(new Date("2026-08-30T12:15:00Z"));
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(2);
    });

    it("no longer raises ENCRYPTION_KEY_MISSING: a keyless server does not boot", async () => {
      await service.sweepSystemHealth(new Date("2026-08-30T12:00:00Z"));
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.ENCRYPTION_KEY_MISSING,
        }),
      );
    });
  });

  describe("SMTP health sweep", () => {
    const now = new Date("2026-08-30T12:00:00Z");

    it("is not stopped by the JWT_SECRET check beside it", async () => {
      // One handler, two independent facts: a sound secret must not mean
      // the SMTP check is skipped, and vice versa.
      env.JWT_SECRET = "FkVtZprB4sKbrwNIl6YiZarB8gB9RrKoO0rt7sFg4YM=";
      current = snapshot({ lastFailureAt: new Date("2026-08-30T11:50:00Z") });
      await service.sweepSystemHealth(now);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.SMTP_FAILURE }),
      );
    });

    it("raises a daily-bucketed, never-emailed alert when the last send failed and the probe fails", async () => {
      current = snapshot({
        lastFailureAt: new Date("2026-08-30T11:50:00Z"),
        lastFailureMessage: "ECONNREFUSED 10.0.0.1:587",
        failuresSinceSuccess: 3,
      });
      emailService.verifyConnection.mockImplementation(
        probeFails("connect ETIMEDOUT 10.0.0.1:587"),
      );
      await service.sweepEmailHealth(now);
      expect(emailService.verifyConnection).toHaveBeenCalledTimes(1);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.SMTP_FAILURE,
          severity: NotificationSeverity.WARNING,
          // Unchanged by the probe: one alert per UTC day across replicas.
          dedupeKey: "SMTP_FAILURE:2026-08-30",
          email: false,
          data: expect.objectContaining({
            system: true,
            probe: "failed",
            // The probe's own error, read back after it ran -- what is wrong
            // now, not what went wrong on the send ten minutes ago.
            lastError: "connect ETIMEDOUT 10.0.0.1:587",
            // The send record, untouched by the probe.
            failuresSinceSuccess: 3,
            lastFailureAt: "2026-08-30T11:50:00.000Z",
          }),
        }),
      );
      const [input] = systemAlerts.raiseAdminAlert.mock.calls[0];
      expect(input.message).toMatch(/could not send email/);
      expect(input.message).toContain("connect ETIMEDOUT 10.0.0.1:587");
    });

    it("stays silent when the probe reaches the relay -- one failed send is a memory, not an outage", async () => {
      // The multi-replica defect: this replica saw one failed send, SMTP has
      // since recovered and every other replica is sending fine, and nothing
      // has been sent from here since. Without the probe the stale failure
      // raised "Email delivery is failing" for the whole deployment for up
      // to 24 hours, and again after UTC midnight.
      current = snapshot({
        lastFailureAt: new Date("2026-08-30T11:50:00Z"),
        lastFailureMessage: "ECONNREFUSED 10.0.0.1:587",
        failuresSinceSuccess: 1,
      });
      emailService.verifyConnection.mockImplementation(probeSucceeds);
      await service.sweepEmailHealth(now);
      expect(emailService.verifyConnection).toHaveBeenCalledTimes(1);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
      // The probe is not a delivery, so the send record still holds the one
      // failure: the next sweep probes again, and stays silent again.
      expect(current.failuresSinceSuccess).toBe(1);
      await service.sweepEmailHealth(new Date("2026-08-30T12:15:00Z"));
      expect(emailService.verifyConnection).toHaveBeenCalledTimes(2);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("raises when sends keep failing even though the probe reaches the relay", async () => {
      // A relay that accepts the greeting, TLS and login but fails every
      // message during DATA: the probe passes and nothing is delivered. When
      // the probe's pass was recorded as a send success it erased these
      // failures and the alert never fired.
      current = snapshot({
        lastFailureAt: new Date("2026-08-30T11:50:00Z"),
        lastFailureMessage: "Connection closed unexpectedly during DATA",
        failuresSinceSuccess: REPEATED_SEND_FAILURES,
      });
      emailService.verifyConnection.mockImplementation(probeSucceeds);

      await service.sweepEmailHealth(now);

      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.SMTP_FAILURE,
          data: expect.objectContaining({
            probe: "passed",
            // The send's error: the connection is fine, the messages are not.
            lastError: "Connection closed unexpectedly during DATA",
            failuresSinceSuccess: REPEATED_SEND_FAILURES,
          }),
        }),
      );
    });

    it("stays silent when a send succeeded while the probe was failing", async () => {
      // `verify()` failed, but a concurrent `sendMail` delivered after the
      // probe recorded its failure: the fresh snapshot, not the probe's
      // boolean alone, decides.
      current = snapshot({ lastFailureAt: new Date("2026-08-30T11:50:00Z") });
      emailService.verifyConnection.mockImplementation(async () => {
        const failed = await probeFails("ETIMEDOUT")();
        current = {
          ...current,
          lastSuccessAt: new Date("2026-08-30T12:00:02Z"),
          failuresSinceSuccess: 0,
        };
        return failed;
      });
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("stays silent when a success postdates the failure -- delivery recovered", async () => {
      current = snapshot({
        lastFailureAt: new Date("2026-08-30T11:00:00Z"),
        lastSuccessAt: new Date("2026-08-30T11:30:00Z"),
      });
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
      expect(emailService.verifyConnection).not.toHaveBeenCalled();
    });

    it("stays silent and sends no probe traffic when nothing has failed", async () => {
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
      // A healthy replica never connects to the relay on the sweep's behalf.
      expect(emailService.verifyConnection).not.toHaveBeenCalled();
    });

    it("ignores a failure older than the lookback -- yesterday's alert already exists", async () => {
      current = snapshot({
        lastFailureAt: new Date(
          now.getTime() - SMTP_FAILURE_LOOKBACK_MS - 60_000,
        ),
      });
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
      expect(emailService.verifyConnection).not.toHaveBeenCalled();
    });

    it("stays silent when SMTP is not configured -- a setup state, not a failure", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      current = snapshot({ lastFailureAt: new Date("2026-08-30T11:50:00Z") });
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
      expect(emailService.verifyConnection).not.toHaveBeenCalled();
    });
  });

  describe("replica census", () => {
    let warn: jest.SpyInstance;
    const now = new Date("2026-08-30T12:00:00Z");

    beforeEach(() => {
      warn = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
    });

    const replicaWarnings = (): string[] =>
      warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("CLUSTER_MODE"));

    it("warns, naming CLUSTER_MODE=multi, when single sees a second process", async () => {
      census.countActiveProcesses.mockResolvedValue(2);

      await service.sweepSystemHealth(now);

      const [message, ...rest] = replicaWarnings();
      expect(rest).toEqual([]);
      expect(message).toMatch(/^CLUSTER_MODE=single but 2 backend processes/);
      expect(message).toContain("rate limits and cache invalidation");
      expect(message).toMatch(/set CLUSTER_MODE=multi$/);
      // A log line, not a notification: no new alert type exists for it.
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("warns again on the next sweep -- no in-process memory suppresses it", async () => {
      census.countActiveProcesses.mockResolvedValue(3);

      await service.sweepSystemHealth(now);
      await service.sweepSystemHealth(new Date("2026-08-30T12:15:00Z"));

      expect(replicaWarnings()).toHaveLength(2);
    });

    it("stays silent when single is alone", async () => {
      await service.sweepSystemHealth(now);

      expect(census.countActiveProcesses).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("never takes the census in multi, where peers are expected", async () => {
      service = build("multi");
      census.countActiveProcesses.mockResolvedValue(4);

      await service.sweepSystemHealth(now);

      expect(census.countActiveProcesses).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("warns once about a failed census and still runs the other two checks", async () => {
      census.countActiveProcesses.mockRejectedValue(
        new Error("connection terminated"),
      );
      env.JWT_SECRET = "your-super-secret-jwt-key-change-in-production";
      current = snapshot({ lastFailureAt: new Date("2026-08-30T11:50:00Z") });

      await expect(service.sweepSystemHealth(now)).resolves.toBeUndefined();

      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.JWT_SECRET_WEAK }),
      );
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.SMTP_FAILURE }),
      );
      // One warning, from the sweep's isolation: the census no longer has a
      // catch of its own saying the same thing twice.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toBe(
        "The replica check failed this sweep: connection terminated",
      );
    });

    it("is not stopped by a check before it", async () => {
      // An alert that fails to raise must not skip the census after it.
      systemAlerts.raiseAdminAlert.mockRejectedValue(new Error("db down"));
      env.JWT_SECRET = "your-super-secret-jwt-key-change-in-production";
      census.countActiveProcesses.mockResolvedValue(2);

      await expect(service.sweepSystemHealth(now)).resolves.toBeUndefined();

      expect(census.countActiveProcesses).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        "The JWT_SECRET check failed this sweep: db down",
        expect.stringMatching(/^CLUSTER_MODE=single but 2 backend processes/),
      ]);
    });
  });

  describe("isoWeekBucket", () => {
    it("is stable within an ISO week and fresh the week after", () => {
      // 2026-08-24 is a Monday; 2026-08-30 the Sunday of the same ISO week.
      expect(isoWeekBucket(new Date("2026-08-24T00:00:00Z"))).toBe("2026-W35");
      expect(isoWeekBucket(new Date("2026-08-30T23:59:59Z"))).toBe("2026-W35");
      expect(isoWeekBucket(new Date("2026-08-31T00:00:00Z"))).toBe("2026-W36");
    });

    it("assigns the year-boundary days to the ISO year that owns them", () => {
      // 2026-01-01 falls on a Thursday, so week 1 of 2026 starts 2025-12-29.
      expect(isoWeekBucket(new Date("2025-12-29T12:00:00Z"))).toBe("2026-W01");
      expect(isoWeekBucket(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
      // 2027-01-01 is a Friday in the same ISO week as 2026-12-28 (Monday).
      expect(isoWeekBucket(new Date("2026-12-28T12:00:00Z"))).toBe("2026-W53");
      expect(isoWeekBucket(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    });
  });
});
