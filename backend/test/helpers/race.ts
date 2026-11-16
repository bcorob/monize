import { DataSource } from "typeorm";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext } from "@/common/db/with-context";

/**
 * Two-connection race primitives for the integration suites.
 *
 * `docs/verification-contract.md` VER-002: a lock, a compare-and-set, a
 * predicate or a lease is proved only by two real connections interleaved, never
 * by two sequential calls on one. Every suite that needed that used to write its
 * own barrier (or a throwaway probe); these are the shared ones.
 *
 * Two ways to force an interleaving, because production code offers no hook to
 * pause in:
 *
 *   - a **gate**: a test-held lock (`SELECT ... FOR UPDATE` on a row both racers
 *     write, or any other lock statement) on a third connection. Both racers run
 *     until they park on it -- or on the mechanism under test, when it serializes
 *     them earlier -- and `raceTwo` releases it only once the expected number of
 *     backends is lock-blocked. This is the pattern
 *     `holding-concurrent-trades.integration.spec.ts` established;
 *   - a **barrier**: an in-process rendezvous a racer awaits from a hook (a
 *     `pauseBefore` spy on a collaborator called between a read and a write).
 *     Place it before the lock under test: a racer that holds the lock and waits
 *     at the barrier for a peer blocked on that same lock never meets it, and the
 *     barrier's timeout turns that into a named failure rather than a hang.
 *
 * Either way each racer must run on its own connection: a separate
 * `withScopedDb` transaction (the pool hands each its own), or a second
 * `DataSource` from `openPeerDataSource` when the claim is about two instances.
 */

export interface Barrier {
  /** Resolves once every party has arrived; rejects after the timeout. */
  arrive(): Promise<void>;
  /** How many parties have arrived so far. */
  readonly arrived: number;
}

export function createBarrier(parties = 2, timeoutMs = 10_000): Barrier {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    get arrived() {
      return arrived;
    },
    arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) open();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `barrier timed out: ${arrived} of ${parties} parties arrived in ${timeoutMs} ms. ` +
                  "A racer that waits here while holding a lock its peer needs never meets " +
                  "that peer; move the barrier before the lock.",
              ),
            ),
          timeoutMs,
        );
      });
      return Promise.race([opened, timedOut]).finally(() =>
        clearTimeout(timer),
      );
    },
  };
}

/**
 * Polls until at least `expected` backends of this database are waiting on a
 * lock. Condition-driven: the cap is a safety net against a wiring mistake,
 * never the timing source. `stop` ends the wait early (both racers settled
 * before parking), so a racer that failed fast is reported as its own error
 * rather than as a timeout here.
 */
export async function waitForLockWaiters(
  dataSource: DataSource,
  expected: number,
  {
    attempts = 250,
    intervalMs = 20,
    stop = () => false,
  }: { attempts?: number; intervalMs?: number; stop?: () => boolean } = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (stop()) return;
    const [{ c }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'`,
    );
    if (c >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${expected} lock-blocked backend(s); the race was ` +
      "never set up, so the test would prove nothing.",
  );
}

export interface HeldLock {
  /** Commits the holding transaction, releasing the lock. Idempotent. */
  release(): Promise<void>;
}

/**
 * Takes a lock on its own connection and holds it until `release`. System
 * context, so the statement sees every tenant's rows on the owner connection
 * and the lock is the same one a racer's scoped transaction contends on.
 */
export async function holdLock(
  dataSource: DataSource,
  sql: string,
  params: unknown[] = [],
): Promise<HeldLock> {
  let signalHeld!: () => void;
  let failHeld!: (err: unknown) => void;
  const held = new Promise<void>((resolve, reject) => {
    signalHeld = resolve;
    failHeld = reject;
  });
  let letGo!: () => void;
  const canRelease = new Promise<void>((resolve) => {
    letGo = resolve;
  });

  const done = withSystemContext(() =>
    withScopedDb(dataSource, async (m) => {
      await m.query(sql, params);
      signalHeld();
      await canRelease;
    }),
  ).catch((err: unknown) => {
    failHeld(err);
    throw err;
  });
  // Surfaced through `held` (before the lock) or `release` (after it).
  done.catch(() => undefined);

  await held;
  return {
    release: async () => {
      letGo();
      await done;
    },
  };
}

export interface RaceOutcome<A, B> {
  a: PromiseSettledResult<A>;
  b: PromiseSettledResult<B>;
  /** How many of the two fulfilled. */
  fulfilled: number;
  /** The rejection reasons, in racer order. */
  reasons: unknown[];
}

export interface RaceOptions {
  /**
   * A lock to hold while both racers start, released once `parked` backends
   * (default 2) are lock-blocked.
   */
  gate?: { sql: string; params?: unknown[]; parked?: number };
  /** The barrier each racer is handed; two parties by default. */
  barrier?: Barrier;
}

/**
 * Runs `a` and `b` concurrently, each expected to open its own transaction,
 * and settles both. Never throws on a racer's rejection: the outcome is the
 * evidence, so the caller asserts on it (one winner, one refusal, no deadlock).
 */
export async function raceTwo<A, B>(
  dataSource: DataSource,
  a: (barrier: Barrier) => Promise<A>,
  b: (barrier: Barrier) => Promise<B>,
  { gate, barrier = createBarrier(2) }: RaceOptions = {},
): Promise<RaceOutcome<A, B>> {
  const lock = gate
    ? await holdLock(dataSource, gate.sql, gate.params ?? [])
    : null;
  try {
    let settled = 0;
    const track = <T>(p: Promise<T>): Promise<T> =>
      p.finally(() => {
        settled += 1;
      });
    // `Promise.resolve().then` turns a synchronous throw into a rejection, so
    // one racer failing early still lets the other start.
    const pa = track(Promise.resolve().then(() => a(barrier)));
    const pb = track(Promise.resolve().then(() => b(barrier)));
    // Neither rejection may go unhandled while the gate is still held.
    pa.catch(() => undefined);
    pb.catch(() => undefined);

    if (lock) {
      await waitForLockWaiters(dataSource, gate?.parked ?? 2, {
        stop: () => settled >= 2,
      });
      await lock.release();
    }

    const [ra, rb] = await Promise.allSettled([pa, pb]);
    const reasons = [ra, rb]
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason as unknown);
    return { a: ra, b: rb, fulfilled: 2 - reasons.length, reasons };
  } finally {
    await lock?.release();
  }
}

/**
 * A second `DataSource` on the same database, for a claim about two instances
 * (two replicas each with its own pool) rather than two connections of one.
 * Never synchronizes or drops: the suite's own connection built the schema.
 */
export async function openPeerDataSource(
  dataSource: DataSource,
): Promise<DataSource> {
  const peer = new DataSource({
    ...dataSource.options,
    synchronize: false,
    dropSchema: false,
  } as never);
  await peer.initialize();
  return peer;
}

/**
 * Makes the next `times` calls of `object[method]` wait at `barrier` before
 * calling through. For a collaborator a racer reaches between its read and its
 * write, so both racers hold their snapshot before either writes.
 */
export function pauseBefore<T extends object>(
  object: T,
  method: keyof T & string,
  barrier: Barrier,
  times = 2,
): jest.SpyInstance {
  const original = (object[method] as (...args: unknown[]) => unknown).bind(
    object,
  );
  let remaining = times;
  return jest.spyOn(object, method as never).mockImplementation((async (
    ...args: unknown[]
  ) => {
    if (remaining > 0) {
      remaining -= 1;
      await barrier.arrive();
    }
    return original(...args);
  }) as never);
}
