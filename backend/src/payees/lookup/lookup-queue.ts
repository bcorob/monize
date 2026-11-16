import { Logger } from "@nestjs/common";

/**
 * A small in-process admission queue for background lookups: at most
 * `concurrency` provider calls in flight, at most `maxPending` waiting, and
 * anything beyond that dropped with one log line. A 25-row batch create
 * would otherwise fan out 25 concurrent model calls the moment it committed.
 *
 * Process-local by design -- it bounds what *this replica* does. The
 * cross-replica guard against doing one payee's lookup twice is the
 * enrichment UPDATE's own predicate, not this queue.
 */
export class LookupQueue {
  private readonly logger = new Logger(LookupQueue.name);
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
  ) {}

  /** Runs the task when a slot frees; resolves `undefined` when dropped. */
  async run<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxPending) {
        this.logger.warn(
          `Dropping background lookup for ${label}: ${this.waiting.length} already waiting`,
        );
        return undefined;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  /** For tests and diagnostics. */
  get pending(): number {
    return this.waiting.length;
  }

  get inFlight(): number {
    return this.active;
  }
}
