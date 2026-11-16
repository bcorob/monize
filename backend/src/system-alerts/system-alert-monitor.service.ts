import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import {
  JwtSecretWeakness,
  jwtSecretWeakness,
} from "../common/jwt-secret-policy";
import {
  EmailFailureSnapshot,
  EmailService,
} from "../notifications/email.service";
import { NOTIFICATION_EMAIL_MESSAGES } from "../notifications/notification-email-messages";
import { SystemAlertService } from "./system-alert.service";
import { CLUSTER_MODE, ClusterMode } from "../common/cluster/cluster-mode";
import { ReplicaCensusService } from "../common/cluster/replica-census.service";

/**
 * A failure older than this cannot raise a fresh SMTP alert: with a quiet
 * outbox nothing has failed *lately*, and the last alert about the broken
 * spell already exists (one per day via the dedupe key).
 */
export const SMTP_FAILURE_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Consecutive failed sends that raise the alert even when a probe of the relay
 * passes. One failure the probe contradicts is a memory; two in a row with no
 * success between them is the relay accepting a login and refusing messages,
 * which a connection check cannot see.
 */
export const REPEATED_SEND_FAILURES = 2;

/** The admin-only deployment status: configuration an administrator must fix. */
export interface DeploymentStatus {
  /** Why `JWT_SECRET` is weak, or `null` when it is not. */
  jwtSecretWeakness: JwtSecretWeakness | null;
}

/**
 * Watches for deployment states nobody currently reports and raises them as
 * admin system alerts:
 *
 * - **Weak `JWT_SECRET`** (a published placeholder or a typed pattern that
 *   is long enough to boot), re-raised once per ISO week while it stays. The
 *   startup log warning in `main.ts` stays; this is the in-app copy an
 *   operator who never reads container logs actually sees, and the admin
 *   banner (`GET /admin/deployment-status`) is the third.
 *
 *   The missing-`ENCRYPTION_KEY` alert this sweep used to raise is gone: the
 *   server now refuses to start without a key (`checkClusterBoot`), so the
 *   state cannot be observed from a running process. The
 *   `ENCRYPTION_KEY_MISSING` type stays for the rows already raised.
 *
 *   Deliberately on the sweep rather than on `onApplicationBootstrap`, for
 *   three reasons that all bit the boot-time version: a fresh install has no
 *   administrator yet when it boots, so the fan-out stood down and the alert
 *   was never raised until somebody restarted the server; a deployment that
 *   simply keeps running never re-raised it, contradicting the weekly bucket
 *   it is keyed on; and Nest awaits bootstrap hooks inside `app.listen()`, so
 *   an unreachable relay delayed the port opening by one SMTP timeout per
 *   administrator and could hold a readiness probe into a restart loop. A
 *   condition that has been true since installation can wait fifteen minutes.
 * - **SMTP delivery failing**: a 15-minute sweep over this replica's own
 *   `EmailService` failure snapshot, confirmed by a live probe. The sweep is
 *   per replica by construction -- the snapshot is in-process memory with no
 *   durable home -- so a recorded failure is only a reason to look: before
 *   raising, the sweep calls `EmailService.verifyConnection()` (a connect,
 *   TLS and login without a message; production code never called it before
 *   this sweep) and raises only when that probe fails too. "Failing" then
 *   means "this replica cannot reach the relay now", which is true and
 *   actionable under any number of replicas; a stale memory of one failed
 *   send on one replica, after SMTP recovered and the others kept sending,
 *   no longer raises it for the whole deployment. A replica with no failure
 *   recorded is never probed. In-app only by definition -- the email channel
 *   cannot report itself. Skipped entirely when SMTP is not configured:
 *   unconfigured is a setup state announced at boot, not a failure.
 * - **More than one backend process under `CLUSTER_MODE=single`**: the mode is
 *   an operator's assertion, and a second replica started without the flag (a
 *   compose file scaled up, a bare Kubernetes Deployment) runs with rate limits
 *   and cache invalidation that are per process, silently. The sweep asks
 *   `ReplicaCensusService` how many backend processes, each running for over
 *   ten minutes, hold a session on this database, and logs a warning naming
 *   `CLUSTER_MODE=multi` when it is more than one. A log line and the
 *   `replicas` field of `/health`, not an admin alert: it is an operator's
 *   configuration, and no new notification type exists for it. Nothing in
 *   `multi`, which already handles peers.
 *
 * No database access of its own -- `SystemAlertService` and
 * `ReplicaCensusService` seed their own RLS context -- so this file does not
 * need the with-context lint allowlist.
 */
@Injectable()
export class SystemAlertMonitorService {
  private readonly logger = new Logger(SystemAlertMonitorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly systemAlerts: SystemAlertService,
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
    @Inject(CLUSTER_MODE)
    private readonly clusterMode: ClusterMode,
    private readonly census: ReplicaCensusService,
  ) {}

  /**
   * The three checks, on one schedule. Each is independent: the signing secret
   * is a fact about configuration, SMTP health a fact about whether this
   * replica can reach the relay now, the replica count a fact about the
   * deployment, and none may stop another from being reported: each runs on
   * its own, and one that throws is logged and the next still runs. The census
   * runs last, so a database that is slow to answer it delays nothing else.
   */
  @Cron("*/15 * * * *")
  async sweepSystemHealth(now: Date = new Date()): Promise<void> {
    await this.isolated("JWT_SECRET", () => this.checkJwtSecret(now));
    await this.isolated("SMTP", () => this.sweepEmailHealth(now));
    await this.isolated("replica", () => this.checkReplicaCount());
  }

  /** Run one check so that its failure is reported and stops nothing else. */
  private async isolated(
    name: string,
    check: () => Promise<void>,
  ): Promise<void> {
    try {
      await check();
    } catch (error) {
      this.logger.warn(
        `The ${name} check failed this sweep: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * What the admin banner needs to know about this deployment's configuration.
   * A reason code only: never the secret, nor anything derived from it.
   * Read by `GET /admin/deployment-status`, through the same rule as the alert
   * below, so the banner and the alert cannot disagree.
   */
  getDeploymentStatus(): DeploymentStatus {
    return {
      jwtSecretWeakness:
        jwtSecretWeakness(this.configService.get<string>("JWT_SECRET"))
          ?.reason ?? null,
    };
  }

  /**
   * Raise the weak-`JWT_SECRET` alert while the secret stays weak. The rule is
   * `jwtSecretWeakness`, the one the boot warning and the admin banner read,
   * and the alert carries only its reason code: never the secret or any part
   * of it. `raiseAdminAlert` never throws, so nor does this.
   */
  async checkJwtSecret(now: Date = new Date()): Promise<void> {
    const weakness = jwtSecretWeakness(
      this.configService.get<string>("JWT_SECRET"),
    );
    if (weakness === null) return;

    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.JWT_SECRET_WEAK,
      severity: NotificationSeverity.WARNING,
      // The stored English fallback is the catalog's own English, so the row
      // and the localized copy cannot say different things.
      title: NOTIFICATION_EMAIL_MESSAGES["system.jwtSecretWeak.title"],
      message: NOTIFICATION_EMAIL_MESSAGES["system.jwtSecretWeak.message"],
      data: { system: true, reason: weakness.reason },
      dedupeKey: `JWT_SECRET_WEAK:${isoWeekBucket(now)}`,
    });
  }

  /**
   * Raise `SMTP_FAILURE` when this replica recorded a transport failure in the
   * lookback with no success since AND a probe of the relay fails now. The
   * probe runs only once the snapshot already says "failing", so a healthy
   * replica sends no traffic on the sweep's behalf.
   */
  async sweepEmailHealth(now: Date = new Date()): Promise<void> {
    if (!this.emailService.getStatus().configured) return;
    const snapshot = this.emailService.getFailureSnapshot();
    if (snapshot.lastFailureAt === null) return;
    // A success after the last failure means delivery recovered on its own.
    if (succeededSinceFailure(snapshot)) return;
    if (
      now.getTime() - snapshot.lastFailureAt.getTime() >
      SMTP_FAILURE_LOOKBACK_MS
    ) {
      return;
    }

    // The snapshot is a memory of this replica's last sends; ask the relay
    // whether it is reachable now. The probe records only into its own
    // fields, so the send record read back below is still the sends' own.
    const reachable = await this.emailService.verifyConnection();
    const fresh = this.emailService.getFailureSnapshot();
    // A send that landed while the probe ran is the best evidence there is.
    if (succeededSinceFailure(fresh)) return;
    // A reachable relay contradicts a single failed send -- a transient
    // outage this replica has not sent through since. It does not contradict
    // repeated ones: a relay that takes the login and refuses every message
    // passes the probe and delivers nothing.
    if (reachable && fresh.failuresSinceSuccess < REPEATED_SEND_FAILURES) {
      return;
    }

    const lastError = reachable
      ? fresh.lastFailureMessage
      : (fresh.lastProbeError ?? fresh.lastFailureMessage);
    const lastFailureAt = fresh.lastFailureAt ?? snapshot.lastFailureAt;
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.SMTP_FAILURE,
      severity: NotificationSeverity.WARNING,
      title: "Email delivery is failing",
      message:
        // The same sentence as the localized catalog entry
        // (`system.smtpFailure.message`), so the stored row and the rendered
        // copy cannot disagree; the probe's verdict travels in `data`.
        `Monize could not send email: ${lastError ?? "unknown error"}. ` +
        "Notifications and reminders are not being delivered.",
      data: {
        system: true,
        // "failed": the relay cannot be reached now. "passed": it can, and
        // sends keep failing anyway -- look past the connection.
        probe: reachable ? "passed" : "failed",
        lastError,
        failuresSinceSuccess: fresh.failuresSinceSuccess,
        lastFailureAt: lastFailureAt.toISOString(),
      },
      dedupeKey: `SMTP_FAILURE:${now.toISOString().slice(0, 10)}`,
      // Belt and braces: SystemAlertService forces this off for SMTP_FAILURE
      // anyway, but the intent belongs at the call site too.
      email: false,
    });
  }

  /**
   * Warn when `CLUSTER_MODE=single` is contradicted by the database: more than
   * one backend process, each running for over ten minutes, holding a session.
   * Every sweep that still sees it warns again -- a log line every fifteen
   * minutes is the reminder, and no in-process memory decides otherwise.
   *
   * A census failure propagates to `isolated()`, which logs it and lets the
   * sweep's other checks run; it says nothing about how many replicas there
   * are. This is also the call that refreshes the count `GET /health` reports.
   */
  async checkReplicaCount(): Promise<void> {
    // multi already shares its counters and its event bus through PostgreSQL,
    // so a peer is expected there, not a finding.
    if (this.clusterMode !== "single") return;

    const processes = await this.census.countActiveProcesses();
    if (processes > 1) {
      this.logger.warn(
        `CLUSTER_MODE=single but ${processes} backend processes, each ` +
          "running for over 10 minutes, are connected to this database; rate " +
          "limits and cache invalidation are per process in single mode -- " +
          "set CLUSTER_MODE=multi",
      );
    }
  }
}

/** Whether a success was recorded after the last transport failure. */
function succeededSinceFailure(snapshot: EmailFailureSnapshot): boolean {
  return (
    snapshot.lastFailureAt !== null &&
    snapshot.lastSuccessAt !== null &&
    snapshot.lastSuccessAt.getTime() > snapshot.lastFailureAt.getTime()
  );
}

/**
 * `2026-W35` -- the ISO 8601 week the date falls in, computed in UTC. The
 * dedupe bucket for a persistent condition checked on every boot: stable
 * across replicas and restarts within a week, fresh the week after.
 */
export function isoWeekBucket(date: Date): string {
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(
    ((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7,
  );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
