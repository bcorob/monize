import { Injectable } from "@nestjs/common";

import { RelayServerEvent } from "./ai-relay.types";

/** One open browser stream: the socket's writer plus the owner it belongs to. */
interface RegisteredStream {
  userId: string;
  emit: (event: RelayServerEvent) => void;
}

/**
 * The browser SSE streams **this process** is currently holding, by prompt id.
 *
 * Deliberately process-local, and the one part of the relay that is allowed to
 * be. An `emit` closure writes to a socket this process owns, so it can no more
 * be moved to a row or handed to another replica than the controller's
 * heartbeat `setInterval` can. Everything a second replica has to see -- the
 * queue, the claim, the answer, a confirmation card whose stream is gone -- is a
 * row in `ai_relay_prompts` / `ai_relay_actions`; this map only decides whether
 * an interim event reaches a browser parked *here* or is buffered for pickup
 * instead.
 *
 * Keyed by prompt id rather than by user: a user may have more than one chat
 * open, and an event belongs to the turn it names.
 */
@Injectable()
export class RelayStreamRegistry {
  private readonly streams = new Map<string, RegisteredStream>();

  /**
   * Hold `emit` for `promptId` until the returned function is called.
   *
   * The release is idempotent and only removes the stream it registered: a
   * waiter releases on both the disconnect and the deadline path, and a later
   * turn that reused the id must not lose its socket to a stale release.
   */
  register(
    promptId: string,
    userId: string,
    emit: (event: RelayServerEvent) => void,
  ): () => void {
    const stream: RegisteredStream = { userId, emit };
    this.streams.set(promptId, stream);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.streams.get(promptId) === stream) {
        this.streams.delete(promptId);
      }
    };
  }

  /**
   * Push an interim event to the stream parked on `promptId` here, if any.
   * Returns false when no stream for that turn is held by this process -- the
   * browser gave up, never had one, or is parked on another replica.
   */
  emit(userId: string, promptId: string, event: RelayServerEvent): boolean {
    const stream = this.streams.get(promptId);
    if (!stream || stream.userId !== userId) {
      return false;
    }
    stream.emit(event);
    return true;
  }

  /**
   * How many streams this process is holding. Not part of the relay's logic:
   * a registry that kept an entry after its request ended is a leak that
   * outlives the socket, and this is how a spec sees it.
   */
  activeCount(): number {
    return this.streams.size;
  }
}
