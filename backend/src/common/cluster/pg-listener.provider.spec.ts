import { EventEmitter } from "events";
import type { Client, ClientConfig } from "pg";

import {
  PG_LISTENER_CONNECT_TIMEOUT_MS,
  PG_LISTENER_KEEPALIVE_DELAY_MS,
  PG_LISTENER_RECONNECT_MAX_MS,
  PG_LISTENER_RECONNECT_MIN_MS,
  PG_WAKEUP_CHANNEL,
  PG_WAKEUP_PROBE_CHANNEL,
  PgListener,
  assertValidChannel,
  resolveListenerClientConfig,
} from "./pg-listener.provider";

/**
 * A `pg.Client` double that is an `EventEmitter`, because the reconnect path is
 * driven entirely by the `error` and `end` events a real client emits and a
 * plain object could not deliver them.
 */
class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  readonly params: unknown[][] = [];
  connectCalls = 0;
  endCalls = 0;
  connectResult: Promise<void> | null = null;
  queryError: Error | null = null;

  connect(): Promise<void> {
    this.connectCalls += 1;
    return this.connectResult ?? Promise.resolve();
  }

  query(sql: string, params?: unknown[]): Promise<unknown> {
    this.queries.push(sql);
    if (params) this.params.push(params);
    return this.queryError
      ? Promise.reject(this.queryError)
      : Promise.resolve({ rows: [] });
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return Promise.resolve();
  }
}

/**
 * A client whose statements stay in flight until the spec settles them, and
 * which counts how many it was handed at once. A real `pg.Client` queues a
 * statement issued while it is busy, and that queue is deprecated (pg@9 drops
 * it), so the listener must never have two outstanding on one session.
 */
class HeldClient extends FakeClient {
  inFlight = 0;
  maxInFlight = 0;
  private readonly pending: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];

  query(sql: string, params?: unknown[]): Promise<unknown> {
    this.queries.push(sql);
    if (params) this.params.push(params);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    }).finally(() => {
      this.inFlight -= 1;
    });
  }

  /** Settle the oldest outstanding statement, then let its waiter run. */
  async settleNext(error?: Error): Promise<void> {
    const next = this.pending.shift();
    if (!next) throw new Error("no statement is in flight");
    if (error) next.reject(error);
    else next.resolve({ rows: [] });
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const asClient = (fake: FakeClient) => fake as unknown as Client;

/** A client whose connect never succeeds. */
function unreachableClient(): FakeClient {
  const client = new FakeClient();
  client.connectResult = Promise.reject(new Error("still down"));
  return client;
}

/**
 * A listener over a sequence of doubles, one per (re)connect.
 *
 * `fallback` builds every client past the end of the sequence. It defaults to a
 * healthy one, and the backoff spec passes `unreachableClient` -- without that
 * the listener reconnects successfully partway through the window under test
 * and the schedule being asserted stops existing.
 */
function buildListener(
  clients: FakeClient[],
  fallback: () => FakeClient = () => new FakeClient(),
) {
  const made: FakeClient[] = [];
  const listener = new PgListener({} as ClientConfig, () => {
    const next = clients[made.length] ?? fallback();
    made.push(next);
    return asClient(next);
  });
  return { listener, made };
}

describe("assertValidChannel", () => {
  it.each(["monize_wakeups", "a", "a_1", "z9_z"])("accepts %s", (channel) => {
    expect(() => assertValidChannel(channel)).not.toThrow();
  });

  it.each([
    ["Uppercase", "Wakeups"],
    ["a quote", 'a"; DROP TABLE users; --'],
    ["a space", "two words"],
    ["a leading digit", "1channel"],
    ["empty", ""],
  ])("rejects %s", (_name, channel) => {
    expect(() => assertValidChannel(channel)).toThrow(
      /Invalid notification channel/,
    );
  });

  it("rejects a name past the identifier limit rather than letting it truncate", () => {
    // A 64-character LISTEN name is truncated by PostgreSQL, so the notifier and
    // the listener would agree on a string and disagree on a channel.
    expect(() => assertValidChannel("a".repeat(63))).not.toThrow();
    expect(() => assertValidChannel("a".repeat(64))).toThrow(
      /at most 63 characters/,
    );
  });
});

describe("PG_WAKEUP_PROBE_CHANNEL", () => {
  it("stays distinct from the production wake-up channel", () => {
    // `PostgresEventBus` is already listening on `PG_WAKEUP_CHANNEL` by the
    // time the boot probe runs and parses everything delivered there as a
    // wake-up envelope. A probe token published on that channel fails that
    // parse and logs a spurious "Unparsable wake-up dropped" warning on every
    // boot -- this is the regression the separate channel exists to prevent.
    expect(PG_WAKEUP_PROBE_CHANNEL).not.toBe(PG_WAKEUP_CHANNEL);
    expect(() => assertValidChannel(PG_WAKEUP_PROBE_CHANNEL)).not.toThrow();
  });
});

describe("resolveListenerClientConfig", () => {
  const env = (overrides: Record<string, string>) => {
    const values: Record<string, string> = {
      DATABASE_HOST: "db",
      DATABASE_PORT: "6543",
      DATABASE_NAME: "monize",
      DATABASE_USER: "owner",
      DATABASE_PASSWORD: "owner-secret",
      ...overrides,
    };
    return (name: string) => values[name];
  };

  it("uses the owner credentials when RLS is not enforced", () => {
    const config = resolveListenerClientConfig(env({ RLS_MODE: "shadow" }));
    expect(config).toMatchObject({
      host: "db",
      port: 6543,
      database: "monize",
      user: "owner",
      password: "owner-secret",
      keepAlive: true,
      // Without an explicit delay this is the OS default -- two hours on Linux
      // -- so a NAT or endpoint idle timeout drops the flow and the replica
      // holds a dead socket, hears nothing, and reports itself ready.
      keepAliveInitialDelayMillis: PG_LISTENER_KEEPALIVE_DELAY_MS,
      connectionTimeoutMillis: PG_LISTENER_CONNECT_TIMEOUT_MS,
      ssl: false,
    });
  });

  it("uses the runtime role under RLS_MODE=enforce, as the pool does", () => {
    // Two connections to one database that disagree about which role they are
    // is a difference nobody would look for. The resolution is shared with
    // AppModule's, so this asserts they cannot drift apart.
    const config = resolveListenerClientConfig(
      env({
        RLS_MODE: "enforce",
        DATABASE_APP_USER: "monize_app",
        DATABASE_APP_PASSWORD: "app-secret",
      }),
    );
    expect(config.user).toBe("monize_app");
    expect(config.password).toBe("app-secret");
  });

  it("refuses enforce without the runtime role's password", () => {
    expect(() =>
      resolveListenerClientConfig(env({ RLS_MODE: "enforce" })),
    ).toThrow(/DATABASE_APP_PASSWORD/);
  });

  it("carries the TLS settings the pool uses", () => {
    expect(
      resolveListenerClientConfig(env({ DATABASE_SSL: "true" })).ssl,
    ).toEqual({ rejectUnauthorized: true });
    expect(
      resolveListenerClientConfig(
        env({
          DATABASE_SSL: "true",
          DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
        }),
      ).ssl,
    ).toEqual({ rejectUnauthorized: false });
  });
});

describe("PgListener", () => {
  describe("connect", () => {
    it("connects once and reports itself live", async () => {
      const { listener, made } = buildListener([new FakeClient()]);

      await listener.connect();

      expect(made[0].connectCalls).toBe(1);
      expect(listener.isConnected()).toBe(true);
      await listener.close();
    });

    it("is idempotent, so a second caller does not open a second socket", async () => {
      const { listener, made } = buildListener([new FakeClient()]);

      await listener.connect();
      await listener.connect();

      expect(made).toHaveLength(1);
      await listener.close();
    });

    it("throws and closes the socket when the connect fails", async () => {
      const client = new FakeClient();
      client.connectResult = Promise.reject(new Error("ECONNREFUSED"));
      const { listener } = buildListener([client]);

      await expect(listener.connect()).rejects.toThrow("ECONNREFUSED");
      expect(listener.isConnected()).toBe(false);
      // The half-open client must not be left behind: main.ts exits on this
      // path, but a spec run or a retry would leak a socket per attempt.
      expect(client.endCalls).toBe(1);
    });

    it("does not start a reconnect loop when the first connect fails", async () => {
      // The boot check exits on a failure here. If the failed connect had armed
      // the loss handlers, a retry loop would keep running past the refusal --
      // and a late `error` from the dead client would be acted on. Asserted by
      // the listener counts rather than by emitting: an EventEmitter with no
      // `error` listener throws on emit, which would fail this test for the
      // right reason but report it as an unhandled error rather than a claim.
      const client = new FakeClient();
      client.connectResult = Promise.reject(new Error("nope"));
      const { listener, made } = buildListener([client, new FakeClient()]);

      await expect(listener.connect()).rejects.toThrow("nope");

      expect(client.listenerCount("error")).toBe(0);
      expect(client.listenerCount("end")).toBe(0);
      expect(client.listenerCount("notification")).toBe(0);
      expect(made).toHaveLength(1);
    });

    it("arms the loss handlers before replaying LISTEN, not after", async () => {
      // The window between "connect resolved" and "handlers attached" is where
      // a failover drops every replica's session at once. An `error` emitted
      // on a client with no listener is an uncaught exception thrown from
      // inside pg's socket callback, so this used to turn a self-healing
      // reconnect into a crash loop.
      const client = new FakeClient();
      let listenersDuringReplay = -1;
      client.query = (sql: string) => {
        client.queries.push(sql);
        listenersDuringReplay = client.listenerCount("error");
        return Promise.resolve({ rows: [] });
      };
      const { listener } = buildListener([client]);
      await listener.listen(PG_WAKEUP_CHANNEL);

      await listener.connect();

      expect(listenersDuringReplay).toBeGreaterThan(0);
      await listener.close();
    });

    it("leaves a swallowing error listener on a client it gives up on", async () => {
      // end() can emit a late `error`, and an emit with no listener at all
      // throws even though nothing should act on this client any more.
      const client = new FakeClient();
      client.queryError = new Error("LISTEN refused");
      const { listener } = buildListener([client]);
      await listener.listen(PG_WAKEUP_CHANNEL);

      await expect(listener.connect()).rejects.toThrow("LISTEN refused");

      expect(() =>
        client.emit("error", new Error("late failure after end")),
      ).not.toThrow();
    });

    it("refuses to reopen after close", async () => {
      const { listener } = buildListener([new FakeClient()]);
      await listener.connect();
      await listener.close();

      await expect(listener.connect()).rejects.toThrow(/has been closed/);
    });
  });

  describe("listen", () => {
    it("issues LISTEN on the live session", async () => {
      const { listener, made } = buildListener([new FakeClient()]);
      await listener.connect();

      await listener.listen(PG_WAKEUP_CHANNEL);

      expect(made[0].queries).toContain(`LISTEN ${PG_WAKEUP_CHANNEL}`);
      await listener.close();
    });

    it("records a channel taken before the connection exists", async () => {
      const { listener, made } = buildListener([new FakeClient()]);

      await listener.listen(PG_WAKEUP_CHANNEL);
      expect(listener.subscribedChannels()).toEqual([PG_WAKEUP_CHANNEL]);

      await listener.connect();
      expect(made[0].queries).toContain(`LISTEN ${PG_WAKEUP_CHANNEL}`);
      await listener.close();
    });

    it("rejects a channel name that is not an identifier", async () => {
      const { listener } = buildListener([new FakeClient()]);
      await listener.connect();

      await expect(listener.listen('x"; DROP TABLE users; --')).rejects.toThrow(
        /Invalid notification channel/,
      );
      await listener.close();
    });
  });

  describe("notify", () => {
    it("sends through pg_notify with the payload as a bind parameter", async () => {
      const { listener, made } = buildListener([new FakeClient()]);
      await listener.connect();

      await listener.notify(PG_WAKEUP_CHANNEL, '{"channel":"relay:1"}');

      expect(made[0].queries).toContain("SELECT pg_notify($1, $2)");
      expect(made[0].params).toContainEqual([
        PG_WAKEUP_CHANNEL,
        '{"channel":"relay:1"}',
      ]);
      await listener.close();
    });

    it("issues one statement at a time on the session, in call order", async () => {
      // A price refresh of several securities invalidates the portfolio memo
      // once per security, each a fire-and-forget NOTIFY on this one session.
      // Handed to pg together, they tripped its deprecated client-side queue.
      const client = new HeldClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      const sent = ["a", "b", "c"].map((payload) =>
        listener.notify(PG_WAKEUP_CHANNEL, payload),
      );
      const heard = listener.listen("other_channel");
      await new Promise((resolve) => setImmediate(resolve));
      expect(client.inFlight).toBe(1);

      for (let i = 0; i < 4; i += 1) {
        await client.settleNext();
      }
      await Promise.all([...sent, heard]);

      expect(client.maxInFlight).toBe(1);
      expect(client.params).toEqual([
        [PG_WAKEUP_CHANNEL, "a"],
        [PG_WAKEUP_CHANNEL, "b"],
        [PG_WAKEUP_CHANNEL, "c"],
      ]);
      expect(client.queries[client.queries.length - 1]).toBe(
        "LISTEN other_channel",
      );
      await listener.close();
    });

    it("does not let one failed statement reject the next caller's", async () => {
      const client = new HeldClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      const first = expect(
        listener.notify(PG_WAKEUP_CHANNEL, "a"),
      ).rejects.toThrow("payload rejected");
      const second = listener.notify(PG_WAKEUP_CHANNEL, "b");
      await new Promise((resolve) => setImmediate(resolve));
      await client.settleNext(new Error("payload rejected"));
      await client.settleNext();

      await first;
      await expect(second).resolves.toBeUndefined();
      await listener.close();
    });

    it("rejects while the connection is down rather than dropping silently", async () => {
      const { listener } = buildListener([new FakeClient()]);

      await expect(listener.notify(PG_WAKEUP_CHANNEL, "{}")).rejects.toThrow(
        /notification connection is down/,
      );
    });
  });

  describe("onNotification", () => {
    it("delivers channel and payload to every handler", async () => {
      const { listener, made } = buildListener([new FakeClient()]);
      await listener.connect();
      const seen: string[][] = [];
      listener.onNotification((channel, payload) =>
        seen.push([channel, payload]),
      );
      listener.onNotification((channel, payload) =>
        seen.push([`2:${channel}`, payload]),
      );

      made[0].emit("notification", {
        channel: PG_WAKEUP_CHANNEL,
        payload: "{}",
      });

      expect(seen).toEqual([
        [PG_WAKEUP_CHANNEL, "{}"],
        [`2:${PG_WAKEUP_CHANNEL}`, "{}"],
      ]);
      await listener.close();
    });

    it("gives a payload-less notification an empty string, not undefined", async () => {
      const { listener, made } = buildListener([new FakeClient()]);
      await listener.connect();
      const seen: unknown[] = [];
      listener.onNotification((_channel, payload) => seen.push(payload));

      made[0].emit("notification", { channel: PG_WAKEUP_CHANNEL });

      expect(seen).toEqual([""]);
      await listener.close();
    });

    it("keeps delivering after a handler throws", async () => {
      const { listener, made } = buildListener([new FakeClient()]);
      await listener.connect();
      const seen: string[] = [];
      listener.onNotification(() => {
        throw new Error("subscriber is broken");
      });
      listener.onNotification((channel) => seen.push(channel));

      made[0].emit("notification", {
        channel: PG_WAKEUP_CHANNEL,
        payload: "{}",
      });

      expect(seen).toEqual([PG_WAKEUP_CHANNEL]);
      await listener.close();
    });

    it("unsubscribes idempotently", async () => {
      const { listener, made } = buildListener([new FakeClient()]);
      await listener.connect();
      const seen: string[] = [];
      const first = listener.onNotification(() => seen.push("first"));
      listener.onNotification(() => seen.push("second"));

      first();
      first();
      made[0].emit("notification", {
        channel: PG_WAKEUP_CHANNEL,
        payload: "{}",
      });

      expect(seen).toEqual(["second"]);
      await listener.close();
    });

    it("delivers to a handler that a earlier handler unsubscribed alongside", async () => {
      const { listener, made } = buildListener([new FakeClient()]);
      await listener.connect();
      const seen: string[] = [];
      let dropSecond = () => undefined as void;
      listener.onNotification(() => {
        seen.push("first");
        dropSecond();
      });
      dropSecond = listener.onNotification(() => seen.push("second"));

      made[0].emit("notification", {
        channel: PG_WAKEUP_CHANNEL,
        payload: "{}",
      });

      // The snapshot is taken before delivery, so a handler that was subscribed
      // when the notification arrived still receives it.
      expect(seen).toEqual(["first", "second"]);
      await listener.close();
    });
  });

  describe("reconnect", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("replaces the client and replays every LISTEN", async () => {
      const first = new FakeClient();
      const second = new FakeClient();
      const { listener, made } = buildListener([first, second]);
      await listener.connect();
      await listener.listen(PG_WAKEUP_CHANNEL);
      await listener.listen("relay_extra");

      first.emit("error", new Error("server closed the connection"));
      expect(listener.isConnected()).toBe(false);

      await jest.advanceTimersByTimeAsync(PG_LISTENER_RECONNECT_MIN_MS);

      expect(made).toHaveLength(2);
      expect(listener.isConnected()).toBe(true);
      // A reconnect that forgets the channels leaves a replica connected and
      // deaf, which readiness would call healthy.
      expect(second.queries).toEqual([
        `LISTEN ${PG_WAKEUP_CHANNEL}`,
        "LISTEN relay_extra",
      ]);
      await listener.close();
    });

    it("reconnects on a server-side end as well as an error", async () => {
      const first = new FakeClient();
      const { listener, made } = buildListener([first, new FakeClient()]);
      await listener.connect();

      first.emit("end");
      await jest.advanceTimersByTimeAsync(PG_LISTENER_RECONNECT_MIN_MS);

      expect(made).toHaveLength(2);
      expect(listener.isConnected()).toBe(true);
      await listener.close();
    });

    it("doubles the delay up to the ceiling, and never gives up", async () => {
      // The schedule the implementation owes: the first retry at the minimum,
      // each next one twice the last, and no wait longer than the ceiling --
      // so an outage that lasts hours still gets an attempt every 30 seconds
      // rather than backing off into never trying again.
      const delays = [0, 1, 2, 3, 4, 5, 6].map((n) =>
        Math.min(
          PG_LISTENER_RECONNECT_MAX_MS,
          PG_LISTENER_RECONNECT_MIN_MS * 2 ** n,
        ),
      );
      // The window under test has to reach the cap, or it asserts only doubling.
      expect(delays[delays.length - 1]).toBe(PG_LISTENER_RECONNECT_MAX_MS);
      expect(delays[delays.length - 2]).toBe(PG_LISTENER_RECONNECT_MAX_MS);

      const first = new FakeClient();
      const { listener, made } = buildListener([first], unreachableClient);
      await listener.connect();
      first.emit("error", new Error("down"));

      for (const [index, delay] of delays.entries()) {
        await jest.advanceTimersByTimeAsync(delay - 1);
        // Not due yet: a retry one millisecond early is a retry that is not
        // backing off at all.
        expect(made).toHaveLength(index + 1);
        await jest.advanceTimersByTimeAsync(1);
        expect(made).toHaveLength(index + 2);
      }

      expect(listener.isConnected()).toBe(false);
      await listener.close();
    });

    it("ignores an event from a client it has already replaced", async () => {
      const first = new FakeClient();
      const second = new FakeClient();
      const { listener, made } = buildListener([first, second]);
      await listener.connect();

      first.emit("error", new Error("down"));
      await jest.advanceTimersByTimeAsync(PG_LISTENER_RECONNECT_MIN_MS);
      expect(listener.isConnected()).toBe(true);

      // A dead client emitting late must not tear down the live session.
      first.emit("end");
      first.emit("error", new Error("still dead"));

      expect(listener.isConnected()).toBe(true);
      expect(made).toHaveLength(2);
      await listener.close();
    });

    it("does not install a session that close() has already given up on", async () => {
      // close() used to read `client` (null during a connect), end nothing and
      // resolve, after which the in-flight open installed its client anyway:
      // isConnected() went back to true, notify() worked on a closed listener,
      // and the pg socket is a ref'd handle that keeps the process alive until
      // the container's grace period kills it.
      const first = new FakeClient();
      const second = new FakeClient();
      let release!: () => void;
      second.connectResult = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { listener } = buildListener([first, second]);
      await listener.connect();

      first.emit("error", new Error("down"));
      await jest.advanceTimersByTimeAsync(PG_LISTENER_RECONNECT_MIN_MS);

      const closing = listener.close();
      release();
      await closing;

      expect(listener.isConnected()).toBe(false);
      expect(second.endCalls).toBe(1);
      await expect(listener.notify(PG_WAKEUP_CHANNEL, "{}")).rejects.toThrow(
        /connection is down/,
      );
    });

    it("resets the backoff after a successful reconnect", async () => {
      // Without the reset a flapping link degrades to a permanent 30s ladder,
      // which the "doubles the delay" case cannot see because it never lets a
      // reconnect succeed.
      const first = new FakeClient();
      const second = new FakeClient();
      const third = new FakeClient();
      const { listener, made } = buildListener([first, second, third]);
      await listener.connect();

      first.emit("error", new Error("down"));
      await jest.advanceTimersByTimeAsync(PG_LISTENER_RECONNECT_MIN_MS);
      expect(made).toHaveLength(2);

      second.emit("error", new Error("down again"));
      await jest.advanceTimersByTimeAsync(PG_LISTENER_RECONNECT_MIN_MS);

      // The minimum delay again, not double it.
      expect(made).toHaveLength(3);
      await listener.close();
    });

    it("stops reconnecting once closed", async () => {
      const first = new FakeClient();
      const { listener, made } = buildListener([first, new FakeClient()]);
      await listener.connect();

      first.emit("error", new Error("down"));
      await listener.close();
      await jest.advanceTimersByTimeAsync(PG_LISTENER_RECONNECT_MAX_MS * 2);

      expect(made).toHaveLength(1);
      expect(listener.isConnected()).toBe(false);
    });
  });

  describe("verifyDelivery", () => {
    it("resolves when a probe published elsewhere arrives here", async () => {
      const client = new FakeClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      // The publisher stands in for the pool: a different connection entirely.
      const verified = listener.verifyDelivery(
        PG_WAKEUP_CHANNEL,
        (channel, payload) => {
          client.emit("notification", { channel, payload });
          return Promise.resolve();
        },
      );

      await expect(verified).resolves.toBeUndefined();
      expect(client.queries).toContain(`LISTEN ${PG_WAKEUP_CHANNEL}`);
      await listener.close();
    });

    it("rejects when LISTEN was accepted but nothing is delivered", async () => {
      // Exactly what a transaction-mode pooler does: it takes the statement and
      // hands the server connection holding the subscription to somebody else.
      jest.useFakeTimers();
      const client = new FakeClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      const verified = listener.verifyDelivery(
        PG_WAKEUP_CHANNEL,
        () => Promise.resolve(),
        1_000,
      );
      const assertion = expect(verified).rejects.toThrow(
        /no notification arrived/,
      );
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;

      await listener.close();
      jest.useRealTimers();
    });

    it("ignores a notification that is not its own probe", async () => {
      jest.useFakeTimers();
      const client = new FakeClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      const verified = listener.verifyDelivery(
        PG_WAKEUP_CHANNEL,
        (channel) => {
          // Ordinary traffic on the same channel, not the probe token.
          client.emit("notification", { channel, payload: "{}" });
          return Promise.resolve();
        },
        1_000,
      );
      const assertion = expect(verified).rejects.toThrow(
        /no notification arrived/,
      );
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;

      await listener.close();
      jest.useRealTimers();
    });

    it("ignores a probe-shaped payload that is not the token", async () => {
      // The case the length check cannot decide: same shape, same length, one
      // character different. A second replica booting at the same instant
      // publishes exactly this, and accepting it would pass a check whose own
      // delivery had failed.
      //
      // This asserts the outcome, not the timing. A constant-time compare and
      // a short-circuiting one agree on every result, so no unit test
      // distinguishes them; what holds that property is the Bearer scan
      // (javascript_lang_observable_timing) in CI.
      jest.useFakeTimers();
      const client = new FakeClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      const verified = listener.verifyDelivery(
        PG_WAKEUP_CHANNEL,
        (channel, token) => {
          const lastIndex = token.length - 1;
          const decoy =
            token.slice(0, lastIndex) + (token[lastIndex] === "a" ? "b" : "a");
          expect(decoy).toHaveLength(token.length);
          expect(decoy).not.toBe(token);
          client.emit("notification", { channel, payload: decoy });
          return Promise.resolve();
        },
        1_000,
      );
      const assertion = expect(verified).rejects.toThrow(
        /no notification arrived/,
      );
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;

      await listener.close();
      jest.useRealTimers();
    });

    it("surfaces a publisher failure rather than waiting out the deadline", async () => {
      const client = new FakeClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      await expect(
        listener.verifyDelivery(PG_WAKEUP_CHANNEL, () =>
          Promise.reject(new Error("pool is gone")),
        ),
      ).rejects.toThrow("pool is gone");

      await listener.close();
    });
  });

  describe("close", () => {
    it("ends the socket and reports itself down", async () => {
      const client = new FakeClient();
      const { listener } = buildListener([client]);
      await listener.connect();

      await listener.close();

      expect(client.endCalls).toBe(1);
      expect(listener.isConnected()).toBe(false);
    });

    it("is safe with no connection open", async () => {
      const { listener } = buildListener([new FakeClient()]);
      await expect(listener.close()).resolves.toBeUndefined();
    });
  });
});
