import {
  PgListener,
  resolveListenerClientConfig,
} from "@/common/cluster/pg-listener.provider";
import { PostgresEventBus } from "@/common/events/postgres-event-bus";

/**
 * The claim this bus makes is "a wake-up published on replica A reaches a
 * subscriber on replica B", and nothing short of two real connections to one
 * PostgreSQL can show it.
 *
 * A mocked listener proves the routing and the envelope -- that is the unit
 * spec beside the implementation. What it cannot prove is that `pg_notify()`
 * on one session is delivered to a `LISTEN` held on another, that the payload
 * survives the round trip intact, or that a replica hears its own publish. Each
 * instance below owns its own `pg.Client`, which is the closest one test
 * process gets to two replicas (VER-001, `docs/verification-contract.md`).
 */
describe("PostgresEventBus across two instances (real PostgreSQL)", () => {
  let listenerA: PgListener;
  let listenerB: PgListener;
  let busA: PostgresEventBus;
  let busB: PostgresEventBus;

  /**
   * Notifications arrive asynchronously on the connection, so every assertion
   * waits for one rather than assuming it has landed. The timeout is what
   * turns "never delivered" into a failed test instead of a hung suite.
   */
  const nextWakeup = (
    bus: PostgresEventBus,
    channel: string,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no wake-up on "${channel}" within ${timeoutMs}ms`));
      }, timeoutMs);
      const off = bus.subscribe(channel, (payload) => {
        clearTimeout(timer);
        off();
        resolve(payload);
      });
    });

  beforeAll(async () => {
    // The production connection settings, plus an application_name so the
    // reconnect case below can find exactly these two sessions in
    // pg_stat_activity. It changes nothing the spec asserts -- LISTEN, NOTIFY
    // and the reconnect are indifferent to it -- and without it a kill would
    // have to match on `query`, which holds whatever statement ran last.
    const config = {
      ...resolveListenerClientConfig((name) => process.env[name]),
      application_name: SPEC_APPLICATION_NAME,
    };
    listenerA = new PgListener(config);
    listenerB = new PgListener(config);
    await listenerA.connect();
    await listenerB.connect();

    busA = new PostgresEventBus(listenerA);
    busB = new PostgresEventBus(listenerB);
    await busA.start();
    await busB.start();
  });

  afterAll(async () => {
    await listenerA?.close();
    await listenerB?.close();
  });

  it("delivers a publish on one instance to a subscriber on the other", async () => {
    const heard = nextWakeup(busB, "relay:user-cross");

    await busA.publish("relay:user-cross", { promptId: "p-cross" });

    // The whole point of `multi`: the browser's SSE stream is on one pod and
    // the agent's answer arrives on another.
    await expect(heard).resolves.toEqual({ promptId: "p-cross" });
  });

  it("delivers a publish back to the instance that made it", async () => {
    // A replica must hear its own wake-ups too, or a conversation whose two
    // halves happen to land on one pod would be the case that breaks.
    const heard = nextWakeup(busA, "relay:user-self");

    await busA.publish("relay:user-self", { promptId: "p-self" });

    await expect(heard).resolves.toEqual({ promptId: "p-self" });
  });

  it("does not deliver a channel the other instance is not subscribed to", async () => {
    const wrongChannel: unknown[] = [];
    const off = busB.subscribe("relay:user-elsewhere", (p) =>
      wrongChannel.push(p),
    );
    const heard = nextWakeup(busB, "relay:user-right");

    await busA.publish("relay:user-right", { promptId: "p-right" });
    await heard;

    // Every replica hears every notification; routing is what keeps one user's
    // wake-up out of another's stream.
    expect(wrongChannel).toEqual([]);
    off();
  });

  it("carries the payload's structure through the round trip", async () => {
    const heard = nextWakeup(busB, "relay:user-shape");

    await busA.publish("relay:user-shape", {
      promptId: "p-shape",
      userId: "11111111-1111-4111-8111-111111111111",
      attempt: 2,
      late: false,
    });

    // JSON through a text channel: a number that came back as a string, or a
    // boolean as "false", would be a live defect for any consumer that branches
    // on one.
    await expect(heard).resolves.toEqual({
      promptId: "p-shape",
      userId: "11111111-1111-4111-8111-111111111111",
      attempt: 2,
      late: false,
    });
  });

  it("refuses a payload over the limit before it reaches the server", async () => {
    // PostgreSQL's own cap is 8000 bytes and raises 22023; the bus refuses at
    // 4096 so the message names the rule rather than the driver's error code.
    await expect(
      busA.publish("relay:user-big", { blob: "x".repeat(5000) }),
    ).rejects.toThrow(/never carries the row/);
  });

  it("keeps hearing wake-ups after both connections are dropped", async () => {
    // The failure this guards against is a replica that is connected and deaf:
    // a reconnect that did not replay its LISTEN would pass every other test
    // here and lose every wake-up in production. Both sessions go, which is
    // what a database restart or a failover looks like from here.
    const killed = await terminateListenerSessions();
    expect(killed).toBeGreaterThanOrEqual(2);

    await waitFor(
      () => listenerA.isConnected() && listenerB.isConnected(),
      20_000,
    );

    const heard = nextWakeup(busB, "relay:user-reconnect");
    await busA.publish("relay:user-reconnect", { promptId: "p-again" });

    await expect(heard).resolves.toEqual({ promptId: "p-again" });
  });
});

/** Identifies this spec's two listener sessions in `pg_stat_activity`. */
const SPEC_APPLICATION_NAME = "monize-event-bus-spec";

/**
 * Drop this spec's listener sessions server-side, the way a database restart or
 * a network drop would.
 *
 * Matched on `application_name`, which the two clients set at connect: the
 * alternative is `query`, which holds whichever statement ran last on that
 * session and is therefore `SELECT pg_notify(...)` as often as it is `LISTEN`.
 * Every other connection in the test database -- the pools the rest of the
 * suite holds, and this helper's own -- is left alone.
 *
 * The connection returns as a new `pg.Client`; the assertion that matters is
 * not that it came back but that its `LISTEN` came back with it.
 */
async function terminateListenerSessions(): Promise<number> {
  const { Client } = await import("pg");
  const admin = new Client(
    resolveListenerClientConfig((name) => process.env[name]),
  );
  await admin.connect();
  try {
    const result = (await admin.query(
      `SELECT pg_terminate_backend(pid) AS terminated, pid
         FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND application_name = $1`,
      [SPEC_APPLICATION_NAME],
    )) as { rows: { pid: number }[] };
    return result.rows.length;
  } finally {
    await admin.end();
  }
}

/** Poll a predicate until it holds, so a reconnect's timing is not assumed. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition did not hold within ${timeoutMs}ms`);
}
