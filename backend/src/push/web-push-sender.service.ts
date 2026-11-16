import {
  privatePushEndpoint,
  privatePushEndpoints,
  pinnedPushLookup,
  PrivatePushEndpoint,
} from "./unifiedpush-private-endpoints";
import { Injectable, Logger } from "@nestjs/common";
import * as webpush from "web-push";
import * as https from "node:https";
import type { Socket } from "node:net";
import {
  PushConfigService,
  VAPID_SUBJECT,
  VapidIdentity,
} from "./push-config.service";
import { PushDisabledReason } from "./entities/push-subscription.entity";
import { publicOnlyLookup } from "../ai/providers/provider-egress";
import { validateUrlIsSafeWithin } from "../ai/validators/safe-url.validator";

/**
 * How long the push service should hold a message for a device that is offline.
 * Four hours: long enough to survive a night-time phone in a drawer, short
 * enough that a reminder does not arrive after the thing it reminds about.
 */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

/**
 * Consecutive transient failures a device may accumulate before it is retired.
 *
 * "Bounded retry" needs a bound, and this is it: the counter is reset by a
 * success, so a device that works occasionally never reaches it, while one that
 * has silently gone away stops being attempted rather than being retried
 * forever.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * How long one delivery may take before it is abandoned.
 *
 * Node's https client has no default timeout and `web-push` adds none, so an
 * endpoint host that accepts the connection and then stalls holds the socket --
 * and the request that triggered the send -- for as long as it likes. The
 * endpoint is a user-supplied host, which makes "as long as it likes" a choice
 * somebody else gets to make.
 */
export const PUSH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * The whole-delivery deadline, which is a different guarantee from the one
 * above.
 *
 * `PUSH_REQUEST_TIMEOUT_MS` becomes Node's socket timeout, and that is an
 * INACTIVITY timer: a host that sends one byte every four seconds resets it
 * forever, so it bounds a peer that goes silent and nothing else. This bounds
 * the delivery itself, and expiring it destroys the socket -- abandoning the
 * promise alone would leave `web-push` reading into `responseText += chunk`,
 * which has no cap, from a host the caller chose.
 *
 * Generous against the inactivity timeout on purpose: a real push service
 * answering slowly under load must not be mistaken for a stalling one, and the
 * cheaper timer already covers silence.
 */
export const PUSH_REQUEST_DEADLINE_MS = 15_000;

/** What a delivery that ran out of time reports, so `classify` can see it. */
export const PUSH_DEADLINE_MESSAGE = "push delivery deadline exceeded";

/**
 * How long the per-send endpoint re-check may take.
 *
 * Its own number, tighter than the check's own default: this bound is spent
 * once per device inside a fan-out of up to twenty, so it is part of
 * `PUSH_TEST_WORST_CASE_MS` -- a figure an operator sizes a gateway timeout
 * against. The default (`URL_SAFETY_CHECK_TIMEOUT_MS`) is sized for a *save*,
 * where waiting is cheaper than rejecting a valid host, and inheriting it here
 * would have grown the request's worst case by half.
 */
export const PUSH_ENDPOINT_RECHECK_TIMEOUT_MS = 2_000;

/**
 * Make an agent's connections observable, so a deadline can close them.
 *
 * `createConnection` is the one place a connection becomes visible from outside
 * the agent, and Node types it as an overload set -- so the wrapper is written
 * against `unknown[]` and forwards whatever it was given, recording only the
 * result. Exported because it is the mechanism the deadline depends on, and a
 * mechanism nothing can test on its own is a mechanism nobody checks.
 */
export function collectAgentSockets(agent: https.Agent): Socket[] {
  const sockets: Socket[] = [];
  const hooked = agent as unknown as {
    createConnection: (...args: unknown[]) => Socket;
  };
  const connect = hooked.createConnection.bind(agent);
  hooked.createConnection = (...args: unknown[]): Socket => {
    const socket = connect(...args);
    // Only something destroyable is recorded. Node's agent contract permits
    // `createConnection(options, oncreate)` to deliver the socket through its
    // callback and return undefined -- `_http_agent` does `if (newSocket)
    // oncreate(...)` for exactly that -- and an `undefined` in this list would
    // make the deadline's `socket.destroy()` throw inside a setTimeout: an
    // uncaught exception, and the reject on the next line never runs, so the
    // delivery never settles either. The mechanism the deadline depends on must
    // not be the thing that kills the process.
    if (socket && typeof socket.destroy === "function") sockets.push(socket);
    return socket;
  };
  return sockets;
}

/**
 * The minimal shape a delivery needs. Deliberately not the entity: the sender
 * must not be able to reach a field it has no business reading.
 */
export interface PushTarget {
  transport?: "webpush" | "unifiedpush";
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidPublicKey: string;
}

/**
 * What crosses the push service, and therefore what may end up on a lock
 * screen. Privacy-minimal by construction: no amount, no account name, no payee
 * -- the body is composed from the recipient's own locale on the server and the
 * detail loads once the app is open (discussion #1291, "privacy by default").
 */
/**
 * A button on the notification. The id is a closed set the service worker
 * recognises (`sw.js` drops anything else), the title is rendered on the server
 * in the recipient's locale because the worker has no translator of its own.
 */
export interface PushAction {
  action: "stop-reminder";
  title: string;
}

export interface PushPayload {
  /** Strict same-origin chart route; a separate one-use token per device. */
  image?: string;
  type: string;
  title: string;
  body: string;
  /** Same-origin path the click should open. Validated again in the worker. */
  target?: string;
  /**
   * What this notification is ABOUT, for the worker's collapse decision -- or
   * `null` to mean "collapse every notification of this type onto one".
   *
   * Required rather than optional, so a producer states which it means. The
   * browser replaces a shown notification whose `tag` matches, so the tag is a
   * subject identity: two bills due on the same day are both `BILL_DUE`, and
   * grouping by type alone showed the reader one of them and dropped the other.
   * A ROUTE is not a subject either -- the bill producer sends every reminder to
   * `/bills`, because no per-bill page exists -- which is why this is its own
   * field and not derived from `target`.
   *
   * `null` is the right answer where the type really does describe one subject:
   * a test send, or "email delivery is failing", where four stacked copies are
   * worse than one.
   *
   * Never a value the user would mind seeing: the payload is end-to-end
   * encrypted to the device, but a collapse key is metadata, so it carries an
   * id, not a name or an amount.
   */
  collapseKey: string | null;
  /**
   * The reminder a re-emitted nag belongs to. With it come the Stop action and
   * the id the worker's `notificationclick` needs to silence it (R4).
   */
  reminderId?: string;
  actions?: PushAction[];
}

/**
 * A sender bound to one resolved instance identity; see
 * {@link WebPushSender.openBatch}. `ready` is false when the instance has no
 * usable identity -- push disabled, never configured, or a key this instance
 * cannot decrypt -- in which case every `send` answers `unconfigured`; a caller
 * with nothing else to say reads it and skips the device query.
 */
export interface PushBatch {
  readonly ready: boolean;
  send(target: PushTarget, payload: PushPayload): Promise<PushSendOutcome>;
}

export type PushSendOutcome =
  /** Accepted by the push service. */
  | { status: "sent" }
  /** The instance has no usable key pair, or the channel is switched off. */
  | { status: "unconfigured" }
  /** Permanently unusable; `reason` says which repair the user needs. */
  | { status: "expired"; reason: PushDisabledReason; statusCode?: number }
  /**
   * Might work next time. The caller counts these -- unless `throttled`, which
   * says the failure is about US and not about this device.
   */
  | {
      status: "transient";
      message: string;
      statusCode?: number;
      throttled?: boolean;
    };

/**
 * The only file in `src/` that *sends*, enforced by `push-secret.guard.spec.ts`.
 * (`PushConfigService` also imports `web-push`, for key generation and nothing
 * else; the guard's allowlist names both files and their reasons.)
 *
 * Business features never reach a transport. They ask the notification layer to
 * deliver something and this class decides what the wire looks like -- which is
 * what will let ntfy or UnifiedPush arrive later without budgets, bills or
 * backups changing (discussion #1291, "delivery isolation").
 *
 * **Never throws.** A push is an external side effect that PostgreSQL cannot
 * roll back and that must not roll anything back either: a failed delivery
 * returns an outcome, so the financial operation that produced the notification
 * is never undone by the notification about it.
 */
@Injectable()
export class WebPushSender {
  private readonly logger = new Logger(WebPushSender.name);

  constructor(private readonly pushConfig: PushConfigService) {
    privatePushEndpoints();
  }

  /**
   * One fan-out, one identity read. `getVapidIdentity` is a database read (plus
   * a decrypt on a cache miss) and `sendToUser` delivers to every device the
   * account has, so resolving it per delivery cost a fan-out N reads for one
   * answer. The caller opens a batch and sends through it; the decrypted key
   * never leaves this file (`push-secret.guard.spec.ts`), which is why this is a
   * bound closure and not an identity handed back to the caller.
   *
   * The identity is the one current when the batch opened. A rotation that
   * lands mid-batch is caught per delivery anyway: every subscription still
   * names the public key it was minted under, and a mismatch is `expired`.
   */
  async openBatch(): Promise<PushBatch> {
    const identity = await this.pushConfig.getVapidIdentity();
    return {
      ready: identity !== null,
      send: (target, payload) => this.sendWith(identity, target, payload),
    };
  }

  private async sendWith(
    identity: VapidIdentity | null,
    target: PushTarget,
    payload: PushPayload,
  ): Promise<PushSendOutcome> {
    if (!identity) return { status: "unconfigured" };

    // A subscription minted under a superseded key pair cannot be delivered to:
    // the push service checks the VAPID signature against the key the
    // subscription was created with. Caught here as well as at rotation time so
    // an interrupted rotation cannot produce an endless stream of 403s.
    if (target.vapidPublicKey !== identity.publicKey) {
      return {
        status: "expired",
        reason: PushDisabledReason.KEY_ROTATED,
      };
    }

    // Re-checked on every send, not only at registration. `IsPushEndpoint` runs
    // once, when the row is written, and the row then names a host this server
    // POSTs to for as long as it lives -- so a name that resolved publicly then
    // and resolves to a private address now would turn each send into an
    // internal request. Reported as transient rather than as a distinct state:
    // the bounded retry retires it as FAILING, which is what actually happened.
    const pin = privatePushEndpoint(target.endpoint, target.transport);
    if (!pin && !(await this.endpointStillSafe(target.endpoint))) {
      this.logger.warn(
        "Refusing a push to an endpoint that could not be confirmed as a public host",
      );
      return {
        status: "transient",
        message: "endpoint could not be confirmed as a public host",
      };
    }

    try {
      await this.deliverWithDeadline(target, payload, identity, pin);
      return { status: "sent" };
    } catch (error) {
      return this.classify(error);
    }
  }

  /**
   * One delivery, under a deadline this service owns.
   *
   * `web-push`'s `timeout` option becomes Node's socket timeout, which is an
   * INACTIVITY timer: an endpoint that trickles one byte every four seconds
   * never trips a five-second one, so the option is not an upper bound on
   * anything. And the endpoint is a host the CALLER registered -- `IsPushEndpoint`
   * proves it is https and public, not that it is a push service -- so a slow
   * peer is reachable on purpose: `POST /push/test` would hold its request open
   * for as long as that host cared to, while `web-push` grew `responseText +=
   * chunk` with no cap on it.
   *
   * So the deadline is a race, and losing it DESTROYS THE SOCKET rather than
   * merely abandoning the promise -- an orphaned request keeps reading, which is
   * the half that costs memory. The socket is reachable because the agent is
   * ours: `web-push` forwards `options.agent` to `https.request`, and
   * `createConnection` is where a connection becomes visible.
   *
   * The inactivity timeout stays as well. It is the cheaper answer for a host
   * that stops answering entirely, and it costs nothing to keep.
   */
  private async deliverWithDeadline(
    target: PushTarget,
    payload: PushPayload,
    identity: { publicKey: string; privateKey: string },
    pin?: PrivatePushEndpoint,
  ): Promise<void> {
    const agent = new https.Agent({
      keepAlive: false,
      // Unpinned: the connect-time lookup refuses a private answer, so a name
      // that rebinds after `endpointStillSafe` cannot reach an internal address.
      lookup: pin ? pinnedPushLookup(pin) : publicOnlyLookup,
    });
    const sockets = collectAgentSockets(agent);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        webpush.sendNotification(
          {
            endpoint: target.endpoint,
            keys: { p256dh: target.p256dh, auth: target.auth },
          },
          JSON.stringify(payload),
          {
            vapidDetails: {
              subject: VAPID_SUBJECT,
              publicKey: identity.publicKey,
              privateKey: identity.privateKey,
            },
            TTL: PUSH_TTL_SECONDS,
            timeout: PUSH_REQUEST_TIMEOUT_MS,
            agent,
          },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // The destroy is best effort and the rejection is not: a socket that
            // objects to being destroyed must not swallow the deadline, which is
            // what actually frees the caller.
            for (const socket of sockets) {
              try {
                socket.destroy();
              } catch {
                // Already gone, or a socket that refuses. Either way the
                // rejection below is the part the caller is waiting for.
              }
            }
            reject(new Error(PUSH_DEADLINE_MESSAGE));
          }, PUSH_REQUEST_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      agent.destroy();
    }
  }

  /**
   * The endpoint check, bounded. A timeout answers `false`: not knowing whether
   * a host is public is not the same as knowing it is, and only one of those
   * two is a reason to POST to it.
   */
  private async endpointStillSafe(endpoint: string): Promise<boolean> {
    try {
      return await validateUrlIsSafeWithin(
        endpoint,
        PUSH_ENDPOINT_RECHECK_TIMEOUT_MS,
      );
    } catch {
      // `validateUrlIsSafeWithin` catches its own, so this is not a second
      // guess at the same failure: this class promises never to throw, and that
      // promise cannot rest on a collaborator's internals. It is also the one
      // call outside `send`'s own try, which is deliberate -- a refused
      // endpoint is not a failed delivery.
      return false;
    }
  }

  /**
   * Which of the three a failure is.
   *
   * Only 404 and 410 retire a device. They are the push service saying the
   * subscription itself is gone -- browser data cleared, PWA removed, permission
   * revoked, subscription rotated -- and re-attempting is guaranteed to fail.
   *
   * Everything else is transient, 401 and 403 included, and that is deliberate:
   * an authorization failure usually means *our* key or clock is wrong, not that
   * the device went away, and retiring on it would empty every device list in
   * the deployment over one bad configuration. `MAX_CONSECUTIVE_FAILURES`
   * retires a device that keeps failing for any reason, so nothing is retried
   * forever either way.
   */
  private classify(error: unknown): PushSendOutcome {
    const statusCode =
      typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : undefined;
    const message =
      error instanceof Error ? error.message : "unknown push failure";

    if (statusCode === 404 || statusCode === 410) {
      return {
        status: "expired",
        reason: PushDisabledReason.GONE,
        statusCode,
      };
    }

    // 429 is the push service throttling this INSTANCE. One deployment holds one
    // VAPID key pair, so the throttle is per origin and says nothing whatever
    // about the device -- and counted toward `MAX_CONSECUTIVE_FAILURES` it would
    // retire every device in the deployment during one outage, telling every
    // user to enable push again for a fault that was neither theirs nor their
    // phone's. That is the same "empty every device list over one bad
    // configuration" the 401/403 reasoning above rejects.
    //
    // The cost, stated: a host that answers 429 forever is attempted once per
    // cycle rather than retired. Bounded by the fan-out cap and the cron
    // cadence, and a 429 is a claim that a later attempt will be accepted --
    // which is exactly what a device-specific bound must not be spent on.
    if (statusCode === 429) {
      this.logger.warn(
        "The push service is throttling this instance (429); not counting it against any device",
      );
      return {
        status: "transient",
        message,
        statusCode,
        throttled: true,
      };
    }

    this.logger.warn(
      `Web Push delivery failed${statusCode ? ` with ${statusCode}` : ""}: ${message}`,
    );
    return { status: "transient", message, statusCode };
  }
}
