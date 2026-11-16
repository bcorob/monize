import { Injectable, Logger } from "@nestjs/common";

import { PG_WAKEUP_CHANNEL, PgListener } from "../cluster/pg-listener.provider";
import { EventBus } from "./event-bus.interface";

/**
 * Largest wake-up this bus will send.
 *
 * PostgreSQL's own limit is 8000 bytes for a notification payload, and a
 * wake-up is a couple of identifiers. The margin is deliberate: a caller that
 * approaches this is carrying data rather than a hint, and the refusal should
 * reach them in development rather than as a `22023` from the server in
 * production.
 */
export const MAX_WAKEUP_BYTES = 4096;

/** What travels in a notification: which logical channel, and its hint. */
interface WakeupEnvelope {
  channel: string;
  payload: Record<string, unknown>;
}

/**
 * The `CLUSTER_MODE=multi` event bus: `LISTEN`/`NOTIFY` over one connection.
 *
 * Every replica holds one `LISTEN monize_wakeups` for the life of its process
 * (`PgListener`, task F2) and routes each notification to local subscribers by
 * the logical channel named inside the payload. One server-side channel rather
 * than one per subscriber, because a subscribe happens on every SSE open and
 * every agent long-poll: `LISTEN`/`UNLISTEN` churn on a single session would
 * put that traffic on the hot path, and `UNLISTEN` is global to the session
 * anyway, so one request ending would deafen every other request sharing it.
 *
 * `subscribe` and its unsubscribe therefore touch only this process's map. The
 * cost is that a replica receives notifications for channels nobody here is
 * listening on and drops them, which is a string comparison per replica per
 * wake-up, against a volume of wake-ups bounded by how often a person sends a
 * chat message.
 *
 * Losing a message is expected, not exceptional: a notification sent while this
 * replica's listener is reconnecting reaches nobody, and PostgreSQL
 * acknowledges no delivery. That is why the interface says a message is a hint
 * and every waiter also polls -- `event-bus.interface.ts` states the rule, and
 * `WakeSignal` is what the relay parks on.
 */
@Injectable()
export class PostgresEventBus implements EventBus {
  readonly name = "postgres" as const;

  private readonly logger = new Logger(PostgresEventBus.name);

  /**
   * Local subscribers by logical channel.
   *
   * Process-local by design, exactly as `MemoryEventBus`'s map is: it describes
   * the requests this replica is currently serving, and there is nothing for a
   * second replica to share. Allowlisted with that reason when the whole-tree
   * guard lands (task G1).
   */
  private readonly handlers = new Map<
    string,
    Set<(payload: Record<string, unknown>) => void>
  >();

  constructor(private readonly listener: PgListener) {
    this.listener.onNotification((channel, payload) => {
      // Every channel the listener carries arrives here; only ours is ours.
      // A future second channel family on the same connection must not be
      // parsed as a wake-up envelope.
      if (channel === PG_WAKEUP_CHANNEL) {
        this.deliver(payload);
      }
    });
  }

  /**
   * Issue the `LISTEN` this bus depends on.
   *
   * Idempotent and safe before the connection is open: `PgListener` records the
   * channel and replays it on every connect. `main.ts` already issues the same
   * `LISTEN` as its boot check, so in the running server this is a no-op --
   * it is here so a bus constructed in a spec or a script is not silently deaf.
   */
  async start(): Promise<void> {
    await this.listener.listen(PG_WAKEUP_CHANNEL);
  }

  /**
   * Wake every subscriber of `channel`, on this replica and the others.
   *
   * Sent on the listener's own connection, which is in no transaction: that is
   * what makes "publish after the commit" mean what it says. Issued through the
   * pool inside a caller's transaction, a notification would be rolled back
   * with it -- or, worse, delivered to a reader before the row it announces was
   * visible.
   *
   * Rejects when the connection is down rather than swallowing it. The caller's
   * poll is what makes that survivable, and a silent success would teach the
   * next reader that a sent notification is a delivered one.
   */
  async publish(
    channel: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope: WakeupEnvelope = { channel, payload };
    const message = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > MAX_WAKEUP_BYTES) {
      throw new Error(
        `Wake-up for "${channel}" is ${bytes} bytes, over the ${MAX_WAKEUP_BYTES}-byte ` +
          "limit. A bus message names a row to re-read; it never carries the " +
          "row. Send identifiers and let the recipient read under its own scope.",
      );
    }
    await this.listener.notify(PG_WAKEUP_CHANNEL, message);
  }

  subscribe(
    channel: string,
    handler: (payload: Record<string, unknown>) => void,
  ): () => void {
    let subscribers = this.handlers.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      this.handlers.set(channel, subscribers);
    }
    subscribers.add(handler);

    let unsubscribed = false;
    return () => {
      // Idempotent, for the reason MemoryEventBus's is: a caller that
      // unsubscribes on both the disconnect and the timeout path must not
      // remove a handler a later subscribe re-added.
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      const current = this.handlers.get(channel);
      if (!current) {
        return;
      }
      current.delete(handler);
      // Channels are per user; an empty Set left behind is a slow leak in a
      // process serving many of them.
      if (current.size === 0) {
        this.handlers.delete(channel);
      }
    };
  }

  /** Channels with at least one local subscriber. For assertions. */
  activeChannels(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** Parse one notification and hand it to this replica's subscribers. */
  private deliver(raw: string): void {
    let envelope: WakeupEnvelope;
    try {
      envelope = JSON.parse(raw) as WakeupEnvelope;
    } catch (error) {
      // Dropped rather than thrown: this runs on the connection's event
      // handler, where a throw has no caller to reach, and a malformed
      // wake-up costs a waiter its poll interval and nothing else.
      this.logger.warn(
        `Unparsable wake-up dropped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (typeof envelope?.channel !== "string") {
      this.logger.warn("Wake-up without a channel dropped.");
      return;
    }

    const subscribers = this.handlers.get(envelope.channel);
    if (!subscribers || subscribers.size === 0) {
      // Ordinary: every replica hears every wake-up, and most are not theirs.
      return;
    }
    // Snapshot before delivering, as MemoryEventBus does: a handler that
    // unsubscribes its neighbour is the ordinary SSE case, and iterating the
    // live Set would skip a handler that was subscribed when this arrived.
    for (const handler of [...subscribers]) {
      try {
        handler(envelope.payload ?? {});
      } catch (error) {
        this.logger.warn(
          `Event handler for "${envelope.channel}" threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
