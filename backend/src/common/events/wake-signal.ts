/**
 * A re-armable latch for a request parked on the `EventBus`.
 *
 * A bus message is a hint, never data: it can be lost entirely (a replica whose
 * `LISTEN` connection reconnects missed everything sent while it was away), so
 * nothing may block on one forever. Every `wait` therefore carries its
 * own ceiling, and the caller re-reads the database when it returns -- whichever
 * of the two woke it.
 *
 * What this adds over a bare `setTimeout` is that a signal arriving *between*
 * two waits is remembered rather than dropped. That gap -- the caller has just
 * re-read its row and is about to park again -- is exactly when the answer it is
 * waiting for tends to land, and losing the wake-up there costs a full poll
 * interval of latency for no reason.
 */
export class WakeSignal {
  /** A signal that arrived with nobody parked, owed to the next `wait`. */
  private pending = false;

  /** Resolver of the parked `wait`, if there is one. */
  private wake?: () => void;

  /** Wake the parked waiter, or make the next `wait` return immediately. */
  signal(): void {
    const wake = this.wake;
    if (wake) {
      this.wake = undefined;
      wake();
      return;
    }
    this.pending = true;
  }

  /**
   * Park for at most `ms`, returning early on a signal. One waiter at a time:
   * a second concurrent `wait` would orphan the first, and every caller here
   * parks from a single loop.
   */
  wait(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
