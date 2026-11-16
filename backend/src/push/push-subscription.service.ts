import {
  PushPriceChartService,
  PriceChartRequest,
} from "./push-price-chart.service";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager, In, IsNull } from "typeorm";
import * as crypto from "crypto";
import { I18nService } from "nestjs-i18n";
import { Cron } from "@nestjs/schedule";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { affectedRowCount, returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { UserPreference } from "../users/entities/user-preference.entity";
import { PushConfigService } from "./push-config.service";
import {
  PushDisabledReason,
  PushSubscription,
  PushTransport,
} from "./entities/push-subscription.entity";
import {
  MAX_CONSECUTIVE_FAILURES,
  PUSH_ENDPOINT_RECHECK_TIMEOUT_MS,
  PUSH_REQUEST_DEADLINE_MS,
  PushPayload,
  PushSendOutcome,
  WebPushSender,
  PushBatch,
} from "./web-push-sender.service";
import { CreatePushSubscriptionDto } from "./dto/create-push-subscription.dto";

/** How many hex characters of the endpoint digest identify a device publicly. */
export const ENDPOINT_FINGERPRINT_LENGTH = 16;

/** One of the caller's own devices, as the settings page renders it. */
export interface PushDeviceDto {
  id: string;
  /**
   * A prefix of the endpoint's SHA-256, so the browser can recognise which row
   * is the device it is looking at.
   *
   * The endpoint itself is a delivery credential and never leaves the server:
   * anyone holding it plus the two keys can push to that device. A digest
   * prefix answers "is this me?" and nothing else.
   */
  endpointFingerprint: string;
  deviceName: string | null;
  userAgent: string | null;
  /**
   * The address the subscription was registered from, refreshed on each
   * re-registration. Null where it predates the column or the server could not
   * determine one -- unknown, never a placeholder. Not the device's current
   * address: nothing is delivered to a device from here, so this deployment
   * never sees one.
   */
  registeredIp: string | null;
  /** Which wire this device is on: web push, or a UnifiedPush distributor. */
  transport: PushTransport;
  createdAt: string;
  lastSeenAt: string;
  lastSuccessAt: string | null;
  disabledAt: string | null;
  disabledReason: PushDisabledReason | null;
  /**
   * When this device's account signed out of the browser it lives in. Nothing
   * is delivered to it until the same account signs in there again
   * (INV-PUSH-011). Null for a device that is signed in.
   */
  heldAt: string | null;
}

/** Per-device result of a test send, so the UI can name the device that failed. */
export interface PushTestDeviceResult {
  id: string;
  deviceName: string | null;
  status: PushSendOutcome["status"];
  /** Set only for a device this send retired, so the UI can explain the repair. */
  disabledReason?: PushDisabledReason;
}

export interface PushTestResult {
  attempted: number;
  delivered: number;
  devices: PushTestDeviceResult[];
}

export function hashEndpoint(endpoint: string): string {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

/** Longest `User-Agent` stored; matches `push_subscriptions.user_agent`. */
export const MAX_USER_AGENT_LENGTH = 255;

/**
 * Live devices one account may hold.
 *
 * `sendTest` fans out over every live row, so without a bound one account's
 * request costs whatever that account chose to make it cost -- the same reason
 * every request-supplied array in this codebase declares an upper size
 * (`docs/backend/entities-and-dtos.md`). Twenty is far past a person's real device count and
 * far short of a useful lever.
 */
export const MAX_LIVE_DEVICES_PER_USER = 20;

/**
 * How many devices one test send talks to at a time.
 *
 * The per-send bound covers ONE delivery; this bounds the request. Sending to
 * the cap serially would hold a request for the product of the two, over hosts
 * the account chose. Four at a time makes the worst case ceil(20/4) = 5 rounds,
 * and a realistic one or two devices is still a single round.
 */
export const PUSH_TEST_CONCURRENCY = 4;

/**
 * How long a retired device stays in the user's list before it is forgotten.
 *
 * The same window the notification centre keeps a read notification for: the
 * row exists so the user can see that a device needs re-enabling, and once that
 * has had a month to be noticed it is debris.
 */
export const RETIRED_DEVICE_RETENTION_DAYS = 30;

/**
 * How long a held device waits for its account to sign in on it again before
 * the daily sweep forgets it.
 *
 * Deleting it loses nothing: a later resume is a re-registration, which
 * inserts the row again. The bound exists so a browser nobody signs back in
 * on does not sit in the device list forever.
 */
export const HELD_DEVICE_RETENTION_DAYS = 15;

/**
 * The longest `POST /push/test` can take, derived rather than restated.
 *
 * A round is bounded by the endpoint re-check plus the whole-delivery deadline,
 * and it is the DEADLINE that bounds a delivery: `PUSH_REQUEST_TIMEOUT_MS`
 * becomes Node's socket timeout, an inactivity timer a host can reset forever
 * by trickling a byte. Composing the figure from the 5-second inactivity value
 * gave "about 35 seconds" and understated the real bound by a factor of nearly
 * three -- and this number is what an operator sizes a gateway timeout against,
 * so a wrong one buys a 504 over a request that was still running correctly.
 *
 * Written as the arithmetic so it cannot go stale when a part moves;
 * `push-subscription.service.spec.ts` pins the composition.
 */
export const PUSH_TEST_WORST_CASE_MS =
  Math.ceil(MAX_LIVE_DEVICES_PER_USER / PUSH_TEST_CONCURRENCY) *
  (PUSH_ENDPOINT_RECHECK_TIMEOUT_MS + PUSH_REQUEST_DEADLINE_MS);

/**
 * A user's own push devices: registering one, listing them, removing one, and
 * sending that user a test notification.
 *
 * Every method takes `userId` from the JWT at the controller and never from a
 * payload, and every ownership check runs inside the same transaction as the
 * write it guards -- a 404 cannot un-commit a row.
 */
@Injectable()
export class PushSubscriptionService {
  private readonly logger = new Logger(PushSubscriptionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushConfig: PushConfigService,
    private readonly sender: WebPushSender,
    private readonly i18n: I18nService,
    private readonly charts: PushPriceChartService,
  ) {}

  /**
   * Register (or refresh) the calling user's device.
   *
   * `pushManager.subscribe()` is scoped to a browser profile and an origin, not
   * to a Monize session, so two accounts used in one browser can be handed the
   * *same* endpoint and the same encryption keys. One row per endpoint is what
   * stops both rows living at once; the question is what happens to the second
   * subscriber, and the answer is that it is **refused**, never a takeover.
   *
   * A takeover would delete another tenant's row on the strength of a string
   * the caller supplied, which no ownership check covers -- and it would do so
   * silently, so the first account loses push with no notice. The 409 is the
   * honest answer, and it is not a dead end: the client answers it by
   * unsubscribing in the browser and subscribing again, which mints a *fresh*
   * endpoint nobody holds (`enablePushOnThisDevice` in
   * `frontend/src/lib/push.ts`). Logging out holds the row
   * (`hold`, below), and a hold the client cannot confirm releases the
   * endpoint instead, so a signed-out browser never delivers to the next
   * person either way.
   *
   * A re-registration by the same account is also how a held device resumes:
   * the `DO UPDATE` arm clears `held_at`, so the cap, the key check and the
   * ownership guard apply to a resume unchanged.
   */
  async subscribe(
    userId: string,
    dto: CreatePushSubscriptionDto,
    userAgent: string | null,
    registeredIp: string | null = null,
  ): Promise<PushDeviceDto> {
    const endpointHash = hashEndpoint(dto.endpoint);

    const row = await withScopedDb(this.dataSource, async (manager) => {
      // Both refusals are decided INSIDE the transaction that writes, from a
      // read taken in it. Read outside, an administrator's rotation (or a
      // channel switched off) committing in the window between the two left a
      // row whose 409 says it was never written: `disableStaleSubscriptions`
      // cannot see a row that does not exist yet, so the device was listed as
      // live under a superseded key and only its first delivery retired it.
      // `docs/backend/database-access-and-tenancy.md`, "Rejection happens before the write". It reads
      // through its own `withScopedDb`, which JOINS this one -- same
      // connection, same atomicity -- rather than opening a second transaction.
      const config = await this.pushConfig.getPublicConfig();
      const publicKey = config.publicKey;
      if (!config.enabled || !publicKey) {
        throw new BadRequestException(
          tr(
            "errors.push.channelUnavailable",
            "Push notifications are not available on this Monize instance.",
          ),
        );
      }

      if (dto.applicationServerKey !== publicKey) {
        // The browser subscribed under a key this instance no longer uses -- a
        // rotation between the page load and the click. Storing the row anyway
        // would record a subscription nothing can ever be delivered to, so it
        // is refused and the client is told to try again with the current key.
        throw new ConflictException(
          tr(
            "errors.push.keyRotated",
            "This instance changed its push key while you were on this page. Reload and enable push again.",
          ),
        );
      }
      const vapidPublicKey = publicKey;
      // Counted inside the transaction that writes, which is where it belongs,
      // though READ COMMITTED and no lock means two simultaneous subscribes at
      // 19 devices can both pass and land on 21. That is the deliberate trade:
      // the cap exists to bound a fan-out, not to be an exact quota, and a lock
      // over every subscribe would cost more than the overshoot. Refreshing a
      // device the caller already holds is never blocked by it -- only a new
      // row is.
      const repo = manager.getRepository(PushSubscription);
      // Scoped to LIVE rows on purpose: the upsert below clears `disabled_at`,
      // so re-enabling a retired device adds a live one and the cap has to see
      // it. Matching any row would let an account past the cap deterministically
      // rather than only through the race described below.
      const alreadyLive = await repo.findOne({
        where: { userId, endpointHash, disabledAt: IsNull() },
      });
      if (!alreadyLive) {
        const live = await repo.count({
          where: { userId, disabledAt: IsNull() },
        });
        if (live >= MAX_LIVE_DEVICES_PER_USER) {
          throw new BadRequestException(
            tr(
              "errors.push.tooManyDevices",
              "This account already has the maximum number of push devices. Remove one before adding another.",
            ),
          );
        }
      }

      const ids = await this.claimEndpointForCaller(manager, {
        userId,
        dto,
        endpointHash,
        userAgent,
        registeredIp,
        vapidPublicKey,
      });
      if (ids.length === 0) throw endpointClaimed();

      // The response is read back from the committed row rather than assembled
      // from the values we sent: on the DO UPDATE arm the stored device name may
      // be the one already there (COALESCE below), which the request never saw.
      const saved = await manager
        .getRepository(PushSubscription)
        .findOne({ where: { id: ids[0].id } });
      if (!saved) throw endpointClaimed();
      return saved;
    });

    return toDeviceDto(row);
  }

  /**
   * Insert the caller's row, or refresh the one they already hold for this
   * endpoint. Returns no id when the endpoint belongs to somebody else.
   *
   * The refusal arrives two ways and both have to become the same 409. At
   * `RLS_MODE=off` the `WHERE user_id = EXCLUDED.user_id` guard simply matches
   * nothing and the statement returns zero rows. Under enforcement the
   * conflicting row is invisible to this transaction, so PostgreSQL never gets
   * as far as that guard: it raises instead -- a unique violation, or a
   * policy violation on the update arm. Letting that surface would turn the
   * documented 409 into a 500 and silence the client's one retry, which is the
   * whole recovery path for a stale claim.
   */
  private async claimEndpointForCaller(
    manager: EntityManager,
    input: {
      userId: string;
      dto: CreatePushSubscriptionDto;
      endpointHash: string;
      userAgent: string | null;
      registeredIp: string | null;
      vapidPublicKey: string;
    },
  ): Promise<Array<{ id: string }>> {
    try {
      const inserted = await manager.query(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, endpoint_hash, p256dh, auth, device_name,
            user_agent, registered_ip, vapid_public_key, transport, created_at,
            last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'webpush'),
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (endpoint_hash) DO UPDATE
            SET p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth,
                device_name = COALESCE(EXCLUDED.device_name, push_subscriptions.device_name),
                user_agent = EXCLUDED.user_agent,
                -- Overwritten, not COALESCEd: a refresh IS a registration, from
                -- wherever the browser is now, and the column's whole claim is
                -- that it names the most recent one. Keeping an older address
                -- under a moved last_seen_at would make the pair a lie.
                registered_ip = EXCLUDED.registered_ip,
                vapid_public_key = EXCLUDED.vapid_public_key,
                transport = COALESCE(EXCLUDED.transport, push_subscriptions.transport),
                last_seen_at = CURRENT_TIMESTAMP,
                failure_count = 0,
                disabled_at = NULL,
                disabled_reason = NULL,
                -- The resume of a held device. Only the same account reaches
                -- this arm (the WHERE below), so nobody else can lift a hold.
                held_at = NULL
          WHERE push_subscriptions.user_id = EXCLUDED.user_id
       RETURNING id`,
        [
          input.userId,
          input.dto.endpoint,
          input.endpointHash,
          input.dto.p256dh,
          input.dto.auth,
          input.dto.deviceName ?? null,
          input.userAgent
            ? input.userAgent.slice(0, MAX_USER_AGENT_LENGTH)
            : null,
          input.registeredIp,
          input.vapidPublicKey,
          // NULL when the client said nothing: a first registration defaults to
          // the browser wire in SQL, and a REFRESH keeps the row's wire -- a
          // UnifiedPush client re-posting rotated keys without the tag must not
          // be moved onto the webpush gate, the way device_name is kept too.
          input.dto.transport ?? null,
        ],
      );
      return returnedRows<{ id: string }>(inserted);
    } catch (error) {
      if (isForeignEndpointConflict(error)) return [];
      throw error;
    }
  }

  /**
   * Forget devices that have been retired long enough to have been noticed.
   *
   * A retired row is not debris on the day it is retired -- it is how the user
   * learns their phone stopped receiving push and needs enabling again, which is
   * why `listForUser` returns it. But nothing ever removed one: an
   * administrator's key rotation retires EVERY subscription in the deployment,
   * so after three rotations a user who re-enabled each time was looking at
   * three dead rows plus a live one, each needing its own Remove click, forever.
   *
   * The same thirty days the notification centre keeps a read notification for,
   * and for the same reason: long enough to be acted on, short enough not to
   * accumulate. Re-enabling a device clears `disabled_at`, so nothing live is
   * ever in range.
   *
   * A held device nobody resumed goes after `HELD_DEVICE_RETENTION_DAYS`, in
   * the same transaction. A resume clears `held_at`, so a device its account
   * signed back in on is never in range either.
   */
  @Cron("30 3 * * *")
  async purgeRetiredDevices(): Promise<void> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RETIRED_DEVICE_RETENTION_DAYS);
      const heldCutoff = new Date();
      heldCutoff.setDate(heldCutoff.getDate() - HELD_DEVICE_RETENTION_DAYS);

      // A cross-user sweep with no request behind it, so it seeds its own
      // system context (task C2). Every row it can reach is one whose owner
      // stopped being able to receive on it.
      const removed = await withSystemContext(async () =>
        withScopedDb(this.dataSource, async (manager) => {
          const retired = await manager.query(
            `DELETE FROM push_subscriptions
               WHERE disabled_at IS NOT NULL AND disabled_at < $1`,
            [cutoff],
          );
          const held = await manager.query(
            `DELETE FROM push_subscriptions
               WHERE held_at IS NOT NULL AND held_at < $1`,
            [heldCutoff],
          );
          return {
            retired: affectedRowCount(retired),
            held: affectedRowCount(held),
          };
        }),
      );

      if (removed.retired > 0) {
        this.logger.log(
          `Removed ${removed.retired} long-retired push device(s)`,
        );
      }
      if (removed.held > 0) {
        this.logger.log(
          `Removed ${removed.held} push device(s) held past ${HELD_DEVICE_RETENTION_DAYS} days`,
        );
      }
    } catch (error) {
      // A cron that throws takes the scheduler's next run with it on some
      // versions, and this one is housekeeping: it is not worth a restart.
      this.logger.error(
        `Could not purge retired push devices: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listForUser(userId: string): Promise<PushDeviceDto[]> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(PushSubscription).find({
        where: { userId },
        order: { lastSeenAt: "DESC" },
      }),
    );
    return rows.map(toDeviceDto);
  }

  async remove(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const result = await manager.query(
        "DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2",
        [id, userId],
      );
      if (affectedRowCount(result) === 0) {
        throw new NotFoundException(
          tr("errors.push.deviceNotFound", "Push device not found."),
        );
      }
    });
  }

  /**
   * Hold one of the caller's devices: its account is signing out of the
   * browser it lives in, so nothing is delivered to it until the same account
   * registers it again (INV-PUSH-011).
   *
   * One guarded statement, so the ownership check and the write are the same
   * row lock. A retired row cannot be held: the client then falls back to
   * releasing the subscription, which is what a 404 here tells it to do.
   * Holding a row that is already held only moves `held_at`.
   */
  async hold(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const result = await manager.query(
        `UPDATE push_subscriptions
            SET held_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL`,
        [id, userId],
      );
      if (affectedRowCount(result) === 0) {
        throw new NotFoundException(
          tr("errors.push.deviceNotFound", "Push device not found."),
        );
      }
    });
  }

  /**
   * Send the calling user a test notification on every one of their live
   * devices, and record what each attempt did.
   *
   * The sends happen outside any transaction and the bookkeeping follows them:
   * a push is an external side effect PostgreSQL cannot roll back, so the order
   * that survives is "do the thing, then write down what happened"
   * (`docs/external-side-effects.md`).
   */
  async sendTest(userId: string): Promise<PushTestResult> {
    const config = await this.pushConfig.getPublicConfig();
    if (!config.enabled) {
      throw new BadRequestException(
        tr(
          "errors.push.channelUnavailable",
          "Push notifications are not available on this Monize instance.",
        ),
      );
    }

    const targets = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(PushSubscription).find({
        // A held device is signed out: no device this account is signed in on
        // can receive, so `noDevices` below is the accurate answer.
        where: { userId, disabledAt: IsNull(), heldAt: IsNull() },
        order: { lastSeenAt: "DESC" },
      }),
    );
    if (targets.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.push.noDevices",
          "No push devices are registered for this account. Enable push notifications in this browser first.",
        ),
      );
    }

    // Composed on the server, so the recipient's stored language is the only
    // locale available -- exactly the reason emails resolve theirs this way.
    const lang = await withScopedDb(this.dataSource, (manager) =>
      resolveUserEmailLocale(manager.getRepository(UserPreference), userId),
    );
    const t = emailTranslator(this.i18n, lang);
    const payload: PushPayload = {
      type: "TEST",
      title: t("push.test.title", "Monize test notification"),
      body: t(
        "push.test.body",
        "Push notifications are working on this device.",
      ),
      target: "/settings",
      // One subject: "push works here". Two taps of the button should leave one
      // notification, not two.
      collapseKey: null,
    };

    const devices = await this.fanOut(
      userId,
      payload,
      targets,
      await this.sender.openBatch(),
    );
    const delivered = devices.filter((d) => d.status === "sent").length;
    return { attempted: targets.length, delivered, devices };
  }

  /**
   * Deliver one payload to a user on every live device, without throwing.
   *
   * The notification-layer fan-out primitive (spec section 14.2): the Phase 5
   * dispatch calls it after `NotificationService.create` wrote a row and the
   * matrix says push is on. Unlike `sendTest`, it does NOT throw when the channel
   * is off or the user has no device -- a push is an external side effect that
   * must never roll back the notification it is about, so "nothing to send" is
   * `{ attempted: 0, delivered: 0 }`, not a 400. It seeds no context of its own;
   * the caller's ambient context (a cron's `withUserContext`, a request) carries
   * through the reads.
   *
   * `transports` restricts the fan-out to devices on those wires. The two push
   * channels are gated independently (`push` -> `'webpush'` devices, `unifiedpush`
   * -> `'unifiedpush'` devices), so the dispatch passes exactly the set the
   * matrix turned on; an empty set is "nothing to send" without a query. Omitted
   * means every wire, which is what `sendTest` wants ("does any device work").
   */
  async sendToUser(
    userId: string,
    payload: PushPayload,
    transports?: PushTransport[],
    chartRequest?: PriceChartRequest,
  ): Promise<{ attempted: number; delivered: number }> {
    if (transports && transports.length === 0) {
      return { attempted: 0, delivered: 0 };
    }
    // The one push_instance_config read of this fan-out: the batch's identity
    // is the same fact `getPublicConfig().enabled` reports (configured, switched
    // on, key readable), so asking both would read the row twice.
    const batch = await this.sender.openBatch();
    if (!batch.ready) return { attempted: 0, delivered: 0 };

    const targets = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(PushSubscription).find({
        where: {
          userId,
          disabledAt: IsNull(),
          // Skipped, not queued: the notification centre already has the row,
          // and the bell shows it when the account signs back in.
          heldAt: IsNull(),
          ...(transports ? { transport: In(transports) } : {}),
        },
        order: { lastSeenAt: "DESC" },
      }),
    );
    if (targets.length === 0) return { attempted: 0, delivered: 0 };

    const chart =
      chartRequest && targets.some((t) => t.transport === "webpush")
        ? await this.charts.render(userId, chartRequest)
        : null;
    const devices = await this.fanOut(userId, payload, targets, batch, chart);
    return {
      attempted: targets.length,
      delivered: devices.filter((d) => d.status === "sent").length,
    };
  }

  /**
   * The concurrency-bounded send loop shared by `sendTest` and `sendToUser`: the
   * per-send deadline covers one delivery, and this bounds how many run at once
   * (`PUSH_TEST_CONCURRENCY`), so one account's fan-out cannot hold a request or
   * a cron for the product of the two. Each attempt's outcome is recorded
   * (`recordOutcome`), retiring a device that has failed enough. The batch is
   * the caller's one identity read; the sender keeps the key (push-secret.guard).
   */
  private async fanOut(
    userId: string,
    payload: PushPayload,
    targets: PushSubscription[],
    sender: PushBatch,
    chart: Buffer | null = null,
  ): Promise<PushTestDeviceResult[]> {
    const devices: PushTestDeviceResult[] = [];
    for (let i = 0; i < targets.length; i += PUSH_TEST_CONCURRENCY) {
      const batch = targets.slice(i, i + PUSH_TEST_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (target) => {
          const image =
            chart && target.transport === "webpush"
              ? await this.charts.issue(chart)
              : null;
          const outcome = await sender.send(
            {
              endpoint: target.endpoint,
              transport: target.transport,
              p256dh: target.p256dh,
              auth: target.auth,
              vapidPublicKey: target.vapidPublicKey,
            },
            image ? { ...payload, image } : payload,
          );
          const disabledReason = await this.recordOutcome(
            userId,
            target.id,
            outcome,
          );
          return {
            id: target.id,
            deviceName: target.deviceName,
            status: outcome.status,
            ...(disabledReason ? { disabledReason } : {}),
          };
        }),
      );
      devices.push(...results);
    }
    return devices;
  }

  /**
   * Write down what one delivery attempt did, and return the reason the device
   * was retired if this attempt retired it.
   *
   * Ownership is in the `WHERE` of every statement rather than checked first:
   * the caller already loaded the row under its own tenant transaction, and
   * re-deriving it here keeps the write unable to touch another account's device
   * even if a future caller passes the wrong id.
   */
  private async recordOutcome(
    userId: string,
    subscriptionId: string,
    outcome: PushSendOutcome,
  ): Promise<PushDisabledReason | undefined> {
    if (outcome.status === "unconfigured") return undefined;

    if (outcome.status === "sent") {
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE push_subscriptions
              SET last_success_at = CURRENT_TIMESTAMP,
                  last_seen_at = CURRENT_TIMESTAMP,
                  failure_count = 0
            WHERE id = $1 AND user_id = $2`,
          [subscriptionId, userId],
        ),
      );
      return undefined;
    }

    if (outcome.status === "expired") {
      // The transition, not the outcome: the guard means a device a concurrent
      // send already retired keeps ITS reason, and reporting this attempt's
      // reason anyway would show the user a repair that does not match the row.
      const retired = await withScopedDb(this.dataSource, async (manager) =>
        affectedRowCount(
          await manager.query(
            `UPDATE push_subscriptions
                SET disabled_at = CURRENT_TIMESTAMP,
                    disabled_reason = $3,
                    failure_count = failure_count + 1
              WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL`,
            [subscriptionId, userId, outcome.reason],
          ),
        ),
      );
      return retired > 0 ? outcome.reason : undefined;
    }

    // A throttle is not this device's failure. `MAX_CONSECUTIVE_FAILURES` exists
    // so a dead endpoint stops being attempted; a 429 is the push service
    // rate-limiting the whole INSTANCE (one deployment, one VAPID key pair), so
    // counting it would retire every device in the deployment over one outage.
    // Nothing is written at all: not even `last_seen_at`, which would claim we
    // heard something about this device.
    if (outcome.status === "transient" && outcome.throttled) return undefined;

    // Transient: count it, and retire the device once the bound is reached so a
    // dead endpoint is not attempted forever.
    const retired = await withScopedDb(this.dataSource, async (manager) => {
      // `disabled_at IS NULL` for the same reason the expired arm has it: two
      // concurrent test sends can both hold this row, and a device already
      // retired as GONE must not be relabelled FAILING -- the two ask the user
      // for different repairs.
      const result = await manager.query(
        `UPDATE push_subscriptions
            SET failure_count = failure_count + 1,
                disabled_at = CASE
                  WHEN failure_count + 1 >= $3 THEN CURRENT_TIMESTAMP
                  ELSE disabled_at END,
                disabled_reason = CASE
                  WHEN failure_count + 1 >= $3 THEN $4
                  ELSE disabled_reason END
          WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL
      RETURNING disabled_at, disabled_reason`,
        [
          subscriptionId,
          userId,
          MAX_CONSECUTIVE_FAILURES,
          PushDisabledReason.FAILING,
        ],
      );
      // The transition, not the resulting value: this attempt retired the
      // device only if the row it just wrote is the one that went from live to
      // disabled, which the guarded WHERE is what makes true.
      const rows = returnedRows<{
        disabled_at: Date | string | null;
        disabled_reason: string | null;
      }>(result);
      return (
        rows.length > 0 &&
        rows[0].disabled_at !== null &&
        rows[0].disabled_reason === PushDisabledReason.FAILING
      );
    });
    return retired ? PushDisabledReason.FAILING : undefined;
  }
}

/** The table the classifier below looks for in a policy-violation message. */
const PUSH_SUBSCRIPTIONS_TABLE = "push_subscriptions";

/**
 * The machine-readable half of the endpoint refusal.
 *
 * The client answers this one by unsubscribing and subscribing again for a
 * fresh endpoint, and it must not answer any *other* 409 that way -- the key
 * rotation refusal is also a 409, and recovering from it by unsubscribing
 * destroys a working registration and then retries with the same stale key.
 * Branching on the status alone is exactly that bug, so the code travels.
 */
export const ENDPOINT_CLAIMED_CODE = "pushEndpointClaimed";

/** The one refusal this path can give, so its two arms cannot drift apart. */
function endpointClaimed(): ConflictException {
  return new ConflictException({
    message: tr(
      "errors.push.endpointClaimed",
      "This browser is already registered to a different Monize account. Sign out of that account in this browser and try again.",
    ),
    errorCode: ENDPOINT_CLAIMED_CODE,
  });
}

/** The arbiter index; named so the classifier below cannot answer for another. */
export const ENDPOINT_UNIQUE_INDEX = "idx_push_subscriptions_endpoint";

/**
 * PostgreSQL's two ways of saying "that endpoint is somebody else's", and only
 * those.
 *
 * 23505 is the unique violation raised when the conflicting row is invisible to
 * this transaction, so `ON CONFLICT` cannot resolve against it; 42501 is the
 * policy violation on the update arm. Both are the *documented* outcome of this
 * statement, so both become the 409 the client knows how to recover from.
 *
 * Both are also **scoped**, and that matters more than it looks: a bare code
 * match turns a missing INSERT grant -- an ordinary 42501, and a deployment
 * fault -- into "already registered to a different Monize account", and the
 * client's automatic recovery then unsubscribes and destroys a working browser
 * registration before failing again. A conflict is a conflict only when the
 * database names this endpoint index or this table.
 */
function isForeignEndpointConflict(error: unknown): boolean {
  const wrapped = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
    driverError?: { code?: unknown; constraint?: unknown; message?: unknown };
  };
  const code = wrapped?.code ?? wrapped?.driverError?.code;
  const constraint = wrapped?.constraint ?? wrapped?.driverError?.constraint;
  const message = `${wrapped?.message ?? ""} ${wrapped?.driverError?.message ?? ""}`;

  if (code === "23505") {
    return (
      constraint === ENDPOINT_UNIQUE_INDEX ||
      message.includes(ENDPOINT_UNIQUE_INDEX)
    );
  }
  if (code === "42501") {
    // The RLS message names the table; a grant failure on some other object
    // does not, and must not be dressed up as a conflict.
    return (
      message.includes("row-level security") &&
      message.includes(PUSH_SUBSCRIPTIONS_TABLE)
    );
  }
  return false;
}

function toDeviceDto(row: PushSubscription): PushDeviceDto {
  return {
    id: row.id,
    endpointFingerprint: row.endpointHash.slice(0, ENDPOINT_FINGERPRINT_LENGTH),
    deviceName: row.deviceName,
    userAgent: row.userAgent,
    registeredIp: row.registeredIp ?? null,
    transport: row.transport,
    createdAt: new Date(row.createdAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    lastSuccessAt: row.lastSuccessAt
      ? new Date(row.lastSuccessAt).toISOString()
      : null,
    disabledAt: row.disabledAt ? new Date(row.disabledAt).toISOString() : null,
    disabledReason: row.disabledReason,
    heldAt: row.heldAt ? new Date(row.heldAt).toISOString() : null,
  };
}
