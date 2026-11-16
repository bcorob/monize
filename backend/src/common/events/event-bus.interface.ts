/**
 * The cross-replica wake-up channel.
 *
 * **A message on this bus is a hint, never data.** A subscriber's only correct
 * response to one is to go and look at the database; it must never act on the
 * payload itself. Two reasons, and both have teeth:
 *
 * - **The bus can lose a message.** `NOTIFY` is fire-and-forget, a replica
 *   whose `LISTEN` connection is reconnecting misses everything sent while it
 *   was away, and PostgreSQL acknowledges no delivery. A reader that treats a
 *   wake-up as the notification waits forever for one that was dropped, so
 *   every waiter also polls on a slow timer and the wake-up only shortens the
 *   wait.
 * - **The bus carries no transaction and no identity.** A publish is not
 *   rolled back by the transaction that triggered it, so it is issued **after**
 *   commit -- publishing inside one wakes a reader to a row that may never
 *   exist. And the payload crosses replicas outside RLS entirely: it never
 *   reaches `withScopedDb`, so nothing decides who may read it. Row ids and
 *   user ids, which the recipient then reads back under its own scope, are the
 *   whole of what belongs here.
 *
 * `MemoryEventBus` is the implementation in `CLUSTER_MODE=single`, where the
 * only subscriber is in the publishing process. `PostgresEventBus` replaces it
 * in `multi`, over the one `LISTEN` connection each replica holds.
 *
 * `docs/specs/horizontal-scaling.md` has the work this supports.
 */
export interface EventBus {
  /** Which implementation this is. Logged at boot and asserted in specs. */
  readonly name: "memory" | "postgres";

  /**
   * Wake every subscriber of `channel`.
   *
   * Resolves once the bus has accepted the message, which is not a promise that
   * anybody received it. Call after the transaction commits, never inside it.
   */
  publish(channel: string, payload: Record<string, unknown>): Promise<void>;

  /**
   * Listen on `channel` until the returned function is called.
   *
   * The returned unsubscribe is the only way off the channel, and calling it
   * twice is a no-op: a handler left subscribed after its request ended is a
   * leak that outlives the socket it was serving.
   */
  subscribe(
    channel: string,
    handler: (payload: Record<string, unknown>) => void,
  ): () => void;
}

/** DI token for the active `EventBus`. */
export const EVENT_BUS = Symbol("EVENT_BUS");
