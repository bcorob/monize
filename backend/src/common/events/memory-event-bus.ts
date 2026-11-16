import { Injectable, Logger } from "@nestjs/common";

import { EventBus } from "./event-bus.interface";

/**
 * The `CLUSTER_MODE=single` event bus: every subscriber is in this process, so
 * a wake-up is a function call.
 *
 * The `Map` here is process-local **by design**, which is the one place in this
 * codebase that is the right answer rather than the defect. In `single` there
 * is no second process to reach, and in `multi` this class is not the bound
 * implementation -- `PostgresEventBus` is. When the whole-tree
 * process-local-state guard lands (task G1), this file is allowlisted with that
 * reason rather than rewritten.
 */
@Injectable()
export class MemoryEventBus implements EventBus {
  readonly name = "memory" as const;

  private readonly logger = new Logger(MemoryEventBus.name);

  private readonly handlers = new Map<
    string,
    Set<(payload: Record<string, unknown>) => void>
  >();

  /**
   * Deliver on the next microtask rather than synchronously.
   *
   * A synchronous call would run every handler inside the publisher's stack,
   * where a handler that publishes re-enters the publisher and a handler that
   * blocks holds up the caller that was only announcing. Deferring also makes
   * this bus behave like the PostgreSQL one, whose delivery always arrives on a
   * later tick as a connection event: a caller that happens to work only
   * because delivery was synchronous fails in `multi` and passes every test
   * here.
   */
  async publish(
    channel: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const subscribers = this.handlers.get(channel);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    // Copied before the await: a handler may unsubscribe (or subscribe) while
    // this is delivering, and mutating the live Set mid-iteration would skip a
    // handler that is still listening.
    const snapshot = [...subscribers];
    await Promise.resolve();
    for (const handler of snapshot) {
      try {
        handler(payload);
      } catch (error) {
        // One handler's failure is not the others'. A wake-up is a hint, so a
        // handler that throws has lost nothing that its own poll will not
        // recover; swallowing the other deliveries would.
        this.logger.warn(
          `Event handler for "${channel}" threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
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
      // Idempotent: a caller that unsubscribes on both the disconnect and the
      // timeout path must not remove a handler a later subscribe re-added.
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      const current = this.handlers.get(channel);
      if (!current) {
        return;
      }
      current.delete(handler);
      // Channels are per user, so an empty Set left behind is a slow leak in a
      // process that serves many of them.
      if (current.size === 0) {
        this.handlers.delete(channel);
      }
    };
  }

  /** Channels with at least one subscriber. For assertions; not part of `EventBus`. */
  activeChannels(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
