import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import {
  resolveRestoreExpandedLimitBytes,
  restorePeakBytes,
  restoreProcessBaselineBytes,
} from "./backup-limits";
import {
  DEFAULT_RESTORE_QUEUE_CONFIG,
  RESTORE_RETRY_AFTER_SECONDS,
  type RestoreQueueConfig,
} from "./restore-queue-config";

/**
 * 499, nginx's code for a client that hung up before it was served.
 *
 * There is no standard status for it, and the alternatives are worse: a 5xx makes
 * the global filter log an error for something that is not a fault, and a 200
 * claims a restore ran. Nothing reads the response either way -- the socket is
 * gone -- so this exists to be unambiguous in the access log.
 */
export const CLIENT_CLOSED_REQUEST = 499;

/**
 * The queued caller went away, so its restore was never started.
 *
 * Deliberately not localized: by construction there is no reader. The socket
 * closed, which is what produced this, and Node discards a write to a destroyed
 * response. The string is for the operator's log.
 */
export class RestoreWaitAbandonedException extends HttpException {
  constructor() {
    super(
      "Client closed the connection while waiting for a restore slot.",
      CLIENT_CLOSED_REQUEST,
    );
  }
}

/**
 * A transient refusal: processing capacity exists, this request cannot have it now.
 *
 * Distinct from the zero-capacity 503 in `noCapacityError` on exactly the axis the
 * caller cares about -- this one is worth retrying, and carries `Retry-After` to
 * say so (the controller reads `retryAfterSeconds` and sets the header, since a
 * Nest exception cannot). Zero capacity is a deployment to fix, and retrying it
 * unchanged cannot help, so it carries no header.
 */
export class RestoreQueueBusyException extends ServiceUnavailableException {
  readonly retryAfterSeconds = RESTORE_RETRY_AFTER_SECONDS;
}

/** Per-restore wait options. */
export interface RestoreWaitOptions {
  /**
   * Aborts the **wait**, and only the wait.
   *
   * A queued restore has done nothing yet, so dropping it when its client
   * disconnects is free and correct. A restore that holds a slot is part-way
   * through deleting and re-inserting the user's data, and cancelling *that* on a
   * socket event would be the worst bug in this file -- so the signal is
   * unsubscribed the instant the slot is granted, and `run` never consults it
   * again. Same shape as the upload reservation's receiving/processing split in
   * `restore-upload-admission.ts`, and for the same reason.
   */
  signal?: AbortSignal;
}

/**
 * One queued restore. A waiter in the queue is always unsettled: every path that
 * settles one removes it from the queue in the same tick, which is what lets
 * `drain` hand a slot to the head of the queue and know it will be taken.
 */
interface Waiter {
  /** Take the slot `drain` has already counted. */
  grant: () => void;
  /** Refuse this waiter. It never held a slot, so nothing is given back. */
  fail: (error: Error) => void;
}

/**
 * How many restores may be *processing* -- decrypting, decompressing, parsing,
 * staging -- at the same time.
 *
 * The upload admission gate (`restore-upload-admission.ts`) bounds concurrent
 * compressed bodies. It cannot bound what those bodies cost once they decompress,
 * because a small gzip expands to a large payload: expansion is capped by
 * `BACKUP_RESTORE_EXPANDED_LIMIT`, not by the compressed length. So a handful of
 * 1 MiB uploads, each expanding to the whole expanded ceiling, pass upload
 * admission on their small claims and then hold a multiple of that ceiling in
 * decompressed data between them. The wire budget never saw it.
 *
 * A restore's processing peak is dominated by the *expanded* payload and the
 * strings and object graph derived from it -- roughly `PEAK_MULTIPLE` times the
 * expanded limit -- and that figure is independent of how compressible the upload
 * was. This gate caps how many of those can be in flight at once, so the sum stays
 * inside the container. On the default pod the arithmetic yields one: restore
 * processing is serialised, and a second concurrent restore waits for the first to
 * finish rather than being admitted beside it. A restore is a rare, deliberate,
 * destructive operation, so serialising it costs a wait, not a feature.
 *
 * **This gate bounds concurrency, and only concurrency.** What makes one restore
 * fit is the ceiling it is admitted with, and that used to be circular: an earlier
 * version of this comment called the cap insensitive to `PEAK_MULTIPLE`'s true
 * value on the grounds that one restore fitting was already guaranteed by the
 * upload and expanded limits -- while `safeDerivedUploadLimit` *was*
 * `container * share / PEAK_MULTIPLE`. Every ceiling in the chain was derived by
 * dividing by the same unmeasured constant, so none of them could vouch for it.
 *
 * That is now measured and the derivation inverted (issue #1073). The multiple is
 * about 8, not 3 -- the old model handed out a 100 MiB expanded ceiling on the
 * chart's default pod, and four of five 96 MiB artifacts could not be decoded
 * inside the 304 MiB it left free. So `deriveRestoreExpandedLimitBytes` solves the
 * ceiling out of the capacity instead (`(container - baseline) * share /
 * PEAK_MULTIPLE`), which makes one slot the answer by construction on any pod with
 * headroom, and makes `0` the answer where there is none. A bigger pod buys a
 * bigger artifact rather than a second concurrent restore; an operator who wants
 * concurrency lowers `BACKUP_RESTORE_EXPANDED_LIMIT` deliberately.
 *
 * What is still not established: the measurement covers the decode phases only, so
 * the multiple is a lower bound, and no run has been cgroup-constrained -- "refused
 * rather than OOM-killed" rests on the model, not on a demonstration. The margin is
 * `RESTORE_HEADROOM_SHARE`, and `backup-limits.spec.ts` holds the derivation to it.
 *
 * ## The wait is bounded, and a caller who left does not run (DR-F3RB-002)
 *
 * The queue behind the slots used to be a plain array of resolve callbacks: no
 * limit, no deadline, and no removal when the request disconnected -- so a client
 * could hang up while queued and its **destructive** restore still ran when a slot
 * freed, against data the operator may have since changed their mind about. Now:
 *
 * - the queue has a bound (`BACKUP_RESTORE_QUEUE_LIMIT`), and a request arriving
 *   at a full queue is refused with a retryable 503 rather than joining it;
 * - a wait has a deadline (`BACKUP_RESTORE_QUEUE_WAIT_MS`), so nobody waits for a
 *   slot indefinitely holding a socket and an upload reservation;
 * - a waiter whose `AbortSignal` fires leaves the queue and never runs.
 *
 * The asymmetry in `RestoreWaitOptions.signal` is the whole design: cancellation
 * governs the wait and stops at the slot boundary.
 *
 * A module singleton rather than an injectable so the service can reach it without
 * threading it through a constructor that a hundred specs build. `configure(...)`
 * is called once at bootstrap with the real capacity; unconfigured it defaults to
 * one, which is also the safe default a test inherits.
 */
export class RestoreProcessingGate {
  private capacity: number;
  private queue: RestoreQueueConfig;
  private active = 0;
  /** Replaced rather than spliced, so no other holder of it observes a mutation. */
  private waiters: Waiter[] = [];

  constructor(
    capacity = 1,
    queue: RestoreQueueConfig = DEFAULT_RESTORE_QUEUE_CONFIG,
  ) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.queue = { ...queue };
  }

  /**
   * Set the concurrent-processing capacity and wake any waiters it frees.
   *
   * Zero is kept as zero (F3RB-005). It used to be floored to one, so a
   * container in which one modeled restore does not fit still admitted one --
   * a warning, then an OOM kill mid-restore during a disaster recovery, which
   * is the worst moment to lose the process. An admission control that runs
   * work its own model says cannot fit is not an admission control; `acquire`
   * now refuses instead, and the operator gets an actionable 503 rather than a
   * restarted pod.
   *
   * The queue bounds arrive here too, from `resolveRestoreQueueConfig`, because
   * bootstrap is the one place that has read the environment.
   */
  configure(capacity: number, queue?: Partial<RestoreQueueConfig>): void {
    this.capacity = Math.max(0, Math.floor(capacity));
    if (queue) this.queue = { ...this.queue, ...queue };
    if (this.capacity < 1) {
      // Work that has not acquired a slot is governed by the new configuration
      // too. Leaving old waiters queued would make zero honest only for callers
      // that arrived later and strand the existing requests forever.
      const error = this.noCapacityError();
      const queued = this.waiters;
      this.waiters = [];
      for (const waiter of queued) waiter.fail(error);
      return;
    }
    this.drain();
  }

  /**
   * Runs `fn` while holding a processing slot; releases it however `fn` settles.
   *
   * `options.signal` bounds the wait for the slot. Once `fn` is running it is not
   * consulted again -- see `RestoreWaitOptions`.
   */
  async run<T>(
    fn: () => Promise<T>,
    options: RestoreWaitOptions = {},
  ): Promise<T> {
    await this.acquire(options);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** In-flight count, for diagnostics and tests. */
  get activeCount(): number {
    return this.active;
  }

  /** Number waiting for a slot, for diagnostics and tests. */
  get waitingCount(): number {
    return this.waiters.length;
  }

  private noCapacityError(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      tr(
        "errors.backup.restoreNoMemoryHeadroom",
        "This deployment has no memory headroom for a restore: one restore's " +
          "modeled peak does not fit the container. Raise the container memory " +
          "limit or lower BACKUP_RESTORE_EXPANDED_LIMIT.",
      ),
    );
  }

  private queueFullError(): RestoreQueueBusyException {
    return new RestoreQueueBusyException(
      tr(
        "errors.backup.restoreQueueFull",
        "Too many restores are already waiting for this deployment's restore " +
          "capacity. Retry in a moment.",
      ),
    );
  }

  private waitTimeoutError(): RestoreQueueBusyException {
    return new RestoreQueueBusyException(
      tr(
        "errors.backup.restoreQueueWaitTimeout",
        "Timed out waiting for restore capacity: another restore is still " +
          "running. Retry in a moment.",
      ),
    );
  }

  private acquire(options: RestoreWaitOptions): Promise<void> {
    if (this.capacity < 1) {
      // Nothing will ever free a slot, so waiting would be a hang, not a queue.
      // 503 rather than 500: the deployment is misconfigured, a retry without
      // changing it cannot help, and the message says which knob to turn.
      throw this.noCapacityError();
    }
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }

    const signal = options.signal;
    // A caller who has already gone never joins the queue. Queueing it would
    // reserve a turn for a response nobody reads, and -- before DR-F3RB-002 --
    // eventually run its destructive restore.
    if (signal?.aborted) throw new RestoreWaitAbandonedException();
    if (this.waiters.length >= this.queue.queueLimit) {
      throw this.queueFullError();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Every exit removes this waiter from the queue before settling, which is
      // the invariant `drain` relies on: it counts a slot and then grants it, so
      // a settled waiter left in the queue would swallow that slot forever.
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter((queued) => queued !== waiter);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(deadline);
        finish();
      };
      const onAbort = () =>
        settle(() => reject(new RestoreWaitAbandonedException()));
      const deadline = setTimeout(
        () => settle(() => reject(this.waitTimeoutError())),
        this.queue.waitTimeoutMs,
      );
      // A pending wait must not be what keeps the process alive.
      deadline.unref?.();
      const waiter: Waiter = {
        grant: () => settle(resolve),
        fail: (error) => settle(() => reject(error)),
      };
      this.waiters = [...this.waiters, waiter];
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.capacity && this.waiters.length > 0) {
      const [next, ...rest] = this.waiters;
      this.waiters = rest;
      // The waiter's `acquire` promise resolves; it did not increment `active`
      // when it queued, so this increment is its slot.
      this.active += 1;
      next.grant();
    }
  }
}

/**
 * How many restores whose combined processing peak fits the container, budgeting
 * against the memory that actually costs and reserving what the process needs.
 *
 * Two things the earlier version got wrong (F3R7-002):
 *
 *  - **The peak is `PEAK_MULTIPLE` times the *resolved* expanded limit**, the one
 *    `gunzip` enforces, not the separately derived default. An operator who raised
 *    `BACKUP_RESTORE_EXPANDED_LIMIT` raised every restore's peak, and the slot
 *    count has to see that or it admits restores that cannot fit.
 *  - **The process baseline is subtracted first.** Dividing the whole container by
 *    the per-restore peak double-counts the memory the ordinary process is already
 *    using.
 *
 * Returns the **honest** count, which can be `0`: a configuration where one modeled
 * restore does not fit is a real condition the caller must surface, not paper over
 * by forcing a slot. `1` for an unknown limit -- "cannot tell how big the pod is"
 * reads as "one at a time".
 *
 * A `0` reaches the gate as zero and `acquire` refuses with a 503 (F3RB-005). This
 * comment used to say the gate raised such a zero back to one, so that a `0` here
 * meant "run one anyway and warn" -- describing the floor that F3RB-005 removed two
 * functions above, which it outlived by several commits.
 *
 * Which containers get that zero moved with the measurement (issue #1073): now it
 * is those with no headroom left after the process baseline -- at or below the
 * baseline's own 140 MiB floor, since a pod above it has *some* headroom and the
 * ceiling derived from it is never rounded up to zero. A 160 MiB pod therefore gets
 * one slot and a ceiling of about 2 MiB, which is honest rather than useful; a
 * 256 MiB pod gets one slot and ~12 MiB, where the old share-based derivation gave
 * it zero -- a smaller promise, kept, instead of a larger one that OOM-killed the
 * pod.
 */
export function computeRestoreProcessingSlots(
  memoryLimitBytes: number | null,
  expandedLimitBytes: number = resolveRestoreExpandedLimitBytes(
    undefined,
    memoryLimitBytes,
  ),
  baselineBytes: number = memoryLimitBytes === null
    ? 0
    : restoreProcessBaselineBytes(memoryLimitBytes),
): number {
  if (memoryLimitBytes === null) return 1;
  // A ceiling of zero is the derivation saying this container has no room for any
  // restore, so the honest slot count is zero too. This used to return `1` for a
  // non-positive peak -- a guard against absurd input that, once the expanded
  // ceiling could legitimately derive to zero, admitted a restore on exactly the
  // deployments that cannot run one.
  if (expandedLimitBytes <= 0) return 0;
  // `restorePeakBytes`, not a multiple: the fixed part of a restore's cost is paid
  // per restore, so two concurrent ones pay it twice. Multiplying the payload
  // alone made small artifacts look nearly free and admitted more of them than fit.
  const perRestorePeak = restorePeakBytes(expandedLimitBytes);
  const available = memoryLimitBytes - baselineBytes;
  return Math.max(0, Math.floor(available / perRestorePeak));
}

/** The process-wide gate. Configured once at bootstrap; defaults to serial. */
export const restoreProcessingGate = new RestoreProcessingGate(1);
