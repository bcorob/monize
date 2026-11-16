import { randomUUID, timingSafeEqual } from "node:crypto";

import { Logger } from "@nestjs/common";
import { Client, ClientConfig, Notification } from "pg";

import { parseRlsMode, resolveRlsDatabaseAuth } from "../db/rls-config";

/**
 * The one PostgreSQL connection a replica holds outside the pool, for
 * `LISTEN`/`NOTIFY`.
 *
 * `CLUSTER_MODE=multi` needs a way to tell another replica "go and re-read that
 * row" -- the browser's SSE stream lives on one pod and the agent's answer
 * arrives on another. PostgreSQL has that channel built in, so there is no
 * second store to run; what it costs is a connection that cannot be pooled in
 * transaction mode, because `LISTEN` is session state and a pooler hands the
 * next statement to a different server session. `db-init` and `db-migrate`
 * already require a direct endpoint for the lifecycle advisory lock
 * (`common/db/advisory-locks.ts`), so `multi` adds a second reason for a
 * requirement the deployment already has rather than a new one.
 *
 * **This connection touches no table.** `LISTEN` and `pg_notify()` read and
 * write nothing, so there is no tenant to establish and no policy to apply:
 * routing it through `withScopedDb` would emit identity GUCs for a statement
 * that cannot reach a row, and would put a transaction around a session-scoped
 * command that must outlive it. It is the second sanctioned direct-connection
 * path in `docs/row-level-security-contract.md`, section 4, which says what the
 * boundary is and what it does not authorize.
 *
 * The credentials are the runtime role's, resolved exactly as
 * `app.module.ts` resolves the pool's: `LISTEN` and `pg_notify()` need no
 * privilege the runtime role lacks, and a long-lived connection in the serving
 * process is the last place the owner's credentials belong.
 *
 * A wake-up may be lost -- a notification sent while this connection is
 * reconnecting reaches nobody, and PostgreSQL acknowledges no delivery -- so
 * every waiter also polls on a slow timer and a notification only shortens the
 * wait. `common/events/event-bus.interface.ts` states that rule for the bus
 * built on top of this (task R6).
 */

/** DI token for the process's listener, or `null` in `CLUSTER_MODE=single`. */
export const PG_LISTENER = Symbol("PG_LISTENER");

/**
 * The one channel this deployment notifies on.
 *
 * One `LISTEN` for the life of the process, with the recipient named inside
 * each payload, rather than one channel per subscriber: a subscribe happens on
 * every SSE open and every agent long-poll, and `LISTEN`/`UNLISTEN` churn on a
 * single session would put that traffic on the hot path. `PostgresEventBus`
 * issues this `LISTEN` on construction and parses every payload delivered on
 * it as a wake-up envelope -- which is why the boot probe below uses
 * `PG_WAKEUP_PROBE_CHANNEL` instead of this one.
 */
export const PG_WAKEUP_CHANNEL = "monize_wakeups";

/**
 * The channel the boot probe self-tests delivery on.
 *
 * Deliberately not `PG_WAKEUP_CHANNEL`: `PostgresEventBus` is already
 * constructed and subscribed by the time `main.ts` runs its boot checks, so a
 * probe token published on `PG_WAKEUP_CHANNEL` would reach it and fail its
 * `JSON.parse`, logging a spurious "Unparsable wake-up dropped" warning on
 * every boot. `LISTEN`/`NOTIFY` delivery does not depend on the channel's
 * name, so a dedicated channel proves the same thing without that side effect.
 */
export const PG_WAKEUP_PROBE_CHANNEL = "monize_wakeups_probe";

/** How long the first connect and its `LISTEN` may take before the boot fails. */
export const PG_LISTENER_CONNECT_TIMEOUT_MS = 5_000;

/** First reconnect delay; doubles per failure up to the ceiling below. */
export const PG_LISTENER_RECONNECT_MIN_MS = 1_000;

/** Longest a replica waits between reconnect attempts. */
export const PG_LISTENER_RECONNECT_MAX_MS = 30_000;

/**
 * How long the socket may be idle before the kernel probes it.
 *
 * `keepAlive: true` on its own means `setKeepAlive(true, 0)`, which is the OS
 * default -- 7200 seconds on Linux. This connection is idle between wake-ups by
 * construction, and every NAT table and managed-endpoint idle timeout is far
 * shorter than two hours, so without an explicit delay a middlebox can drop the
 * flow without an RST and the replica holds a socket it believes is live,
 * hears nothing, and reports itself ready the whole time. Ten seconds makes
 * the kernel notice in tens of seconds instead of hours.
 */
export const PG_LISTENER_KEEPALIVE_DELAY_MS = 10_000;

/** How long the boot probe waits for its own notification to come back. */
export const PG_LISTENER_PROBE_TIMEOUT_MS = 5_000;

/**
 * A channel name is an identifier, and `LISTEN` takes no bind parameter, so the
 * name is interpolated into SQL. Rather than quote arbitrary input, the grammar
 * is narrowed to what an identifier can be unquoted: nothing that reaches this
 * function from outside the codebase, and nothing that could carry a quote.
 * `pg_notify()` takes text and is parameterized, but it is validated with the
 * same rule so a name that can be notified is always a name that can be heard.
 */
const CHANNEL_NAME = /^[a-z_][a-z0-9_]*$/;

/** PostgreSQL's identifier limit; a longer `LISTEN` name is silently truncated. */
const MAX_CHANNEL_LENGTH = 63;

export type PgNotificationHandler = (channel: string, payload: string) => void;

export function assertValidChannel(channel: string): void {
  if (!CHANNEL_NAME.test(channel) || channel.length > MAX_CHANNEL_LENGTH) {
    throw new Error(
      `Invalid notification channel "${channel}". A channel is a lowercase ` +
        `identifier of at most ${MAX_CHANNEL_LENGTH} characters ` +
        "([a-z_][a-z0-9_]*), because LISTEN cannot take a bind parameter and " +
        "a truncated name is a channel nobody hears.",
    );
  }
}

/**
 * Whether a delivered payload is the probe token `verifyDelivery` published.
 *
 * Compared in constant time. The token this guards is not a secret today -- it
 * is minted, published and consumed inside one boot, and it is on the wire in
 * plaintext either way -- so nothing is currently exploitable by timing this.
 * It is written this way because the property should not depend on that
 * remaining true: a later caller handing `verifyDelivery` a value that *is*
 * sensitive gets a safe comparison rather than a defect nobody re-derives. The
 * cost at one comparison per boot is nothing.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is checked
 * first. That leaks the length, which is public: every probe token is the same
 * shape.
 */
function isProbeToken(payload: string, token: string): boolean {
  const delivered = Buffer.from(payload, "utf8");
  const expected = Buffer.from(token, "utf8");
  return (
    delivered.length === expected.length && timingSafeEqual(delivered, expected)
  );
}

/**
 * Build the listener's connection settings from the environment.
 *
 * Deliberately the same resolution `AppModule` gives TypeORM, including the RLS
 * role selection: two connections to one database that disagree about which
 * role they are is a difference nobody would look for. `read` is passed in
 * rather than `process.env` being read here so the module can hand over
 * `ConfigService` and a spec can hand over a literal.
 */
export function resolveListenerClientConfig(
  read: (name: string) => string | undefined,
): ClientConfig {
  const { username, password } = resolveRlsDatabaseAuth({
    mode: parseRlsMode(read("RLS_MODE")),
    databaseUser: read("DATABASE_USER"),
    databasePassword: read("DATABASE_PASSWORD"),
    appUser: read("DATABASE_APP_USER"),
    appPassword: read("DATABASE_APP_PASSWORD"),
  });
  return {
    host: read("DATABASE_HOST") || "localhost",
    // Deliberately `parseInt` and not `resolvePositiveInt`, which is the rule
    // for a numeric knob this application owns. This is not one: the pool takes
    // the same variable raw and `db-init` parses it exactly this way, so a
    // malformed port has to fail here the way it fails there. `resolvePositiveInt`
    // would silently fall back to 5432 and connect this listener somewhere the
    // pool is not -- two connections to different databases, which is the one
    // outcome this function exists to prevent.
    port: Number.parseInt(read("DATABASE_PORT") || "5432", 10),
    user: username,
    password,
    database: read("DATABASE_NAME"),
    ssl:
      read("DATABASE_SSL") === "true"
        ? {
            rejectUnauthorized:
              read("DATABASE_SSL_REJECT_UNAUTHORIZED") !== "false",
          }
        : false,
    // The connection is idle between wake-ups, which is exactly the traffic a
    // NAT table or an idle-timeout on a managed endpoint drops silently. Without
    // this the replica keeps a socket it believes is live and hears nothing.
    keepAlive: true,
    keepAliveInitialDelayMillis: PG_LISTENER_KEEPALIVE_DELAY_MS,
    connectionTimeoutMillis: PG_LISTENER_CONNECT_TIMEOUT_MS,
  };
}

/** Fail a promise that has not settled in time, so a boot check cannot hang. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not complete within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One `pg.Client` held open for the life of the process, reconnecting on its
 * own.
 *
 * The `pg` client is not reusable after it has errored, so reconnecting means a
 * new `Client` every time, and every `LISTEN` this process held has to be
 * re-issued on the new session -- a reconnect that forgets them leaves a
 * replica connected and deaf, which is worse than disconnected because
 * readiness would call it healthy.
 */
export class PgListener {
  private readonly logger = new Logger("PgListener");

  /**
   * The channels this process wants, which is not the same as the channels the
   * current session has: on a reconnect the set is what gets replayed. Per
   * process by construction -- it describes this connection, and there is
   * nothing for a second replica to share.
   */
  private readonly channels = new Set<string>();

  private readonly handlers = new Set<PgNotificationHandler>();

  /** Non-null only while a session is live; readiness reads exactly this. */
  private client: Client | null = null;

  /**
   * The `open()` in flight, if there is one.
   *
   * Single-flight, because `client` is null for the whole of a connect: a
   * decision taken before that await -- a second `connect()`, or a `close()` --
   * would otherwise be applied after it, and the session opened during a
   * shutdown would outlive the shutdown that already returned.
   */
  private opening: Promise<void> | null = null;

  /**
   * The last statement queued on each session, so the next one waits for it.
   *
   * `pg` queues a statement issued while the client is busy, but that queue is
   * deprecated and goes away in pg@9 ("Calling client.query() when the client
   * is already executing a query"). This connection is shared by every caller in
   * the process, and the callers do not wait for each other: one price refresh
   * of several securities invalidates the portfolio memo once per security, and
   * each invalidation is a fire-and-forget `NOTIFY` here. So the statements on a
   * session are chained in issue order instead. Per client, so a statement left
   * hanging on a lost session cannot hold up the one that replaced it.
   */
  private readonly statementTails = new WeakMap<Client, Promise<unknown>>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closed = false;

  /**
   * When the current outage began, or `null` while the session is live.
   *
   * Readiness needs the duration, not the state: every replica loses its
   * session at the same instant when the database restarts, so a probe that
   * fails on the state alone empties the whole endpoint list at once.
   */
  private downSince: number | null = null;

  constructor(
    private readonly config: ClientConfig,
    private readonly createClient: (config: ClientConfig) => Client = (
      config,
    ) => new Client(config),
  ) {}

  /** Whether a session is live. False while reconnecting. */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * How long the channel has been down, in milliseconds, or `0` while it is up.
   *
   * The reconnect ladder tops out at `PG_LISTENER_RECONNECT_MAX_MS`, so a value
   * well above that means the reconnect is not merely in progress.
   */
  downForMs(now: number = Date.now()): number {
    return this.downSince === null ? 0 : Math.max(0, now - this.downSince);
  }

  /** Channels this process wants to hear, live or not. For specs and logs. */
  subscribedChannels(): readonly string[] {
    return [...this.channels];
  }

  /**
   * Open the connection for the first time.
   *
   * Throws on failure rather than retrying: this is the boot check, and a
   * deployment whose database host cannot hold a `LISTEN` should be told so in
   * one line instead of retrying behind a readiness probe that never goes
   * green. Every later loss reconnects instead.
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("This PgListener has been closed.");
    }
    if (this.client) {
      return;
    }
    await this.open();
  }

  /**
   * Hear `channel` from now on, and again after every reconnect.
   *
   * Safe to call before `connect()` and safe to call twice: the set is the
   * intent, and `LISTEN` on a channel the session already has is a no-op in
   * PostgreSQL.
   */
  async listen(channel: string): Promise<void> {
    assertValidChannel(channel);
    this.channels.add(channel);
    const client = this.client;
    if (!client) {
      // Not an error: the reconnect replays every channel in the set, so a
      // subscription taken while the connection is down is honoured when it
      // returns. The caller's slow poll covers the gap.
      return;
    }
    await this.runOnSession(client, () => client.query(`LISTEN ${channel}`));
  }

  /**
   * Send a wake-up.
   *
   * On this connection rather than the pool, which is what makes it correct to
   * call after a transaction commits: it is in no transaction, so it cannot be
   * rolled back with one, and it carries no identity because it touches no row.
   */
  async notify(channel: string, payload: string): Promise<void> {
    assertValidChannel(channel);
    const client = this.client;
    if (!client) {
      throw new Error(
        `Cannot notify "${channel}": the notification connection is down. ` +
          "The recipient's poll is what makes this survivable; do not treat a " +
          "sent notification as a delivered one.",
      );
    }
    await this.runOnSession(client, () =>
      client.query("SELECT pg_notify($1, $2)", [channel, payload]),
    );
  }

  /**
   * Run `statement` on `client` once every statement issued on it before has
   * settled, whatever that statement's outcome: one failed `NOTIFY` must not
   * reject the next caller's.
   */
  private runOnSession<T>(
    client: Client,
    statement: () => Promise<T>,
  ): Promise<T> {
    const tail = this.statementTails.get(client) ?? Promise.resolve();
    const result = tail.then(statement);
    this.statementTails.set(
      client,
      result.catch(() => undefined),
    );
    return result;
  }

  /**
   * Prove this session actually receives notifications, not merely that it
   * accepted `LISTEN`.
   *
   * `publish` must send on a **different** connection: that is the whole point.
   * A transaction-mode pooler accepts the connection, forwards the `LISTEN`
   * statement to whichever server connection is free, returns success, and then
   * hands that server connection to somebody else -- so the subscription is on
   * a backend this listener does not own. Accepting the statement therefore
   * proves nothing, and publishing on this same connection would round-trip
   * through the pooler too. Only a notification that originated elsewhere and
   * arrived here distinguishes a session from a pooled handle.
   *
   * Rejects when no probe arrives inside the deadline, which is what turns a
   * misconfigured `DATABASE_HOST` into a refused boot rather than a deployment
   * whose replicas silently never wake each other.
   */
  async verifyDelivery(
    channel: string,
    publish: (channel: string, payload: string) => Promise<unknown>,
    timeoutMs: number = PG_LISTENER_PROBE_TIMEOUT_MS,
  ): Promise<void> {
    assertValidChannel(channel);
    await this.listen(channel);
    // Random rather than a counter because the collision to avoid is across
    // replicas, not within this process: every backend container's node
    // process is pid 1 in its own namespace, so two replicas booting together
    // would mint the same counter-based token and each could accept the
    // other's probe -- passing a check its own delivery had failed.
    const token = `probe:${randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(
          new Error(
            `no notification arrived within ${timeoutMs}ms. The connection ` +
              "accepted LISTEN but does not receive what another connection " +
              "sends, which is what a transaction-mode pooler does.",
          ),
        );
      }, timeoutMs);
      const off = this.onNotification((received, payload) => {
        if (received !== channel || !isProbeToken(payload, token)) {
          return;
        }
        clearTimeout(timer);
        off();
        resolve();
      });
      void publish(channel, token).catch((error: unknown) => {
        clearTimeout(timer);
        off();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Receive every notification on every channel. Returns an unsubscribe. */
  onNotification(handler: PgNotificationHandler): () => void {
    this.handlers.add(handler);
    let removed = false;
    return () => {
      // Idempotent: a caller that unsubscribes on both a disconnect and a
      // timeout path must not remove a handler a later subscribe re-added.
      if (removed) return;
      removed = true;
      this.handlers.delete(handler);
    };
  }

  /** Stop for good. No reconnect follows. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // An open() already in flight would otherwise install its client after this
    // returns. It ends that client itself now that `closed` is set, so all this
    // has to do is not resolve before it has: without the wait, `close()`
    // resolves, `isConnected()` goes back to true a moment later, and the pg
    // socket is a ref'd handle that keeps the process alive until the
    // container's grace period kills it.
    await this.opening?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (client) {
      await client.end().catch(() => undefined);
    }
  }

  /** Connect, arm the loss handlers, and replay every channel. Throws. */
  private async open(): Promise<void> {
    if (this.opening) {
      return this.opening;
    }
    this.opening = this.openOnce();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  private async openOnce(): Promise<void> {
    const client = this.createClient(this.config);
    // The `error` and `end` handlers go on as soon as the connect resolves and
    // *before* the LISTEN replay, not after it. Arming them before the connect
    // would make a failed connect schedule a reconnect the boot check does not
    // know about; arming them after the replay left a window -- connect
    // resolved, handlers not yet attached -- in which a dropped session emits
    // `error` on a client with no listener, which Node throws as an uncaught
    // exception from inside pg's socket callback. That window is exactly where
    // a failover puts every replica at once, so it turned a self-healing
    // reconnect into a crash loop. `handleLoss`'s identity check makes these a
    // no-op until `this.client` is set, so the replay's own error handling is
    // unchanged.
    let connected = false;
    try {
      await withDeadline(
        client.connect(),
        PG_LISTENER_CONNECT_TIMEOUT_MS,
        "Connecting the notification channel",
      );
      connected = true;
      client.on("error", (error: Error) => this.handleLoss(client, error));
      client.on("end", () => this.handleLoss(client, null));
      for (const channel of this.channels) {
        await withDeadline(
          client.query(`LISTEN ${channel}`),
          PG_LISTENER_CONNECT_TIMEOUT_MS,
          `LISTEN ${channel}`,
        );
      }
    } catch (error) {
      if (connected) {
        // Leave a swallowing listener behind: end() can emit a late `error`,
        // and this client is about to be unreferenced, so nothing should act
        // on it -- but an emit with no listener at all still throws.
        client.removeAllListeners("error");
        client.removeAllListeners("end");
        client.on("error", () => undefined);
      }
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      // close() ran while this connect was in flight and has already decided
      // there is no session. Honour that rather than installing one behind it.
      client.removeAllListeners("error");
      client.on("error", () => undefined);
      await client.end().catch(() => undefined);
      return;
    }
    client.on("notification", (message: Notification) =>
      this.dispatch(message),
    );
    this.client = client;
    this.reconnectAttempt = 0;
    this.downSince = null;
  }

  private handleLoss(client: Client, error: Error | null): void {
    // An event from a client we have already replaced says nothing about the
    // current session, and acting on it would tear down a healthy connection.
    if (this.client !== client) {
      return;
    }
    this.client = null;
    this.downSince ??= Date.now();
    this.logger.warn(
      error
        ? `Notification connection lost: ${error.message}. Reconnecting.`
        : "Notification connection closed by the server. Reconnecting.",
    );
    void client.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(
      PG_LISTENER_RECONNECT_MAX_MS,
      PG_LISTENER_RECONNECT_MIN_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    // A pending reconnect must not be the reason the process cannot exit.
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.open();
      if (!this.isConnected()) {
        // `open()` stood down because `close()` ran while it was in flight.
        // Announcing a re-established connection there would be announcing a
        // session that was deliberately discarded.
        return;
      }
      this.logger.log(
        `Notification connection re-established; listening on ` +
          `${this.subscribedChannels().join(", ") || "no channels"}.`,
      );
    } catch (error) {
      this.logger.warn(
        `Notification reconnect failed: ` +
          `${error instanceof Error ? error.message : String(error)}. Retrying.`,
      );
      this.scheduleReconnect();
    }
  }

  private dispatch(message: Notification): void {
    // Snapshot first: a handler that unsubscribes its neighbour is the ordinary
    // case here (one request ending closes a waiter it shares a channel with),
    // and iterating the live set would skip a handler that was subscribed when
    // the notification arrived.
    for (const handler of [...this.handlers]) {
      try {
        handler(message.channel, message.payload ?? "");
      } catch (error) {
        // One bad subscriber must not cost the others their wake-up.
        this.logger.error(
          `Notification handler threw for channel "${message.channel}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
