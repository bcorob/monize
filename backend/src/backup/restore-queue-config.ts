import { resolvePositiveInt } from "../common/env-number.util";

/**
 * The two knobs that bound the restore *wait*, declared as data.
 *
 * `computeRestoreProcessingSlots` decides how many restores may process at once;
 * on the chart's default pod that is one. Everything else that arrives while the
 * slot is taken has to go somewhere, and there are only three answers: refuse it,
 * queue it, or let it queue without limit. The last one is what
 * `restoreProcessingGate` used to do -- an array of resolve callbacks with no
 * bound, no deadline and no way to drop a waiter whose client had gone
 * (DR-F3RB-002, issue #1073).
 *
 * Queueing rather than refusing outright is deliberate: the caller has already
 * uploaded up to `BACKUP_RESTORE_LIMIT` of compressed artifact through a gate that
 * budgeted memory for it, and answering the second operator 503 immediately makes
 * them upload it again. But a queue that is not bounded and deadlined is a way to
 * hold sockets and upload reservations open, so both bounds exist and both are the
 * operator's to set.
 *
 * Declared as one table of `{ envVar, default, description }` and resolved in a
 * loop, per the numeric-knob rule in `backend/CLAUDE.md`: a new knob cannot arrive
 * without a name, a default and a sentence, and `restore-queue-config.spec.ts`
 * checks `.env.example` in both directions.
 */
export interface RestoreQueueKnobSpec {
  readonly envVar: string;
  readonly default: number;
  readonly description: string;
}

export const RESTORE_QUEUE_KNOBS = {
  /**
   * How many restores may wait for a slot before the deployment refuses.
   *
   * Small on purpose. A restore is a rare, deliberate, destructive operation, so
   * more than a handful queued at once is a stampede or an abuse pattern rather
   * than ordinary use -- and each waiter is holding a socket and an upload
   * reservation while it waits. Four is one in flight plus a short line behind it.
   *
   * Note what this does *not* bound: the upload admission budget is one request's
   * worth of peak, and a claim is `PEAK_MULTIPLE` times the declared length, so
   * dozens of small compressed artifacts can pass it -- and each of them can
   * expand to the whole expanded ceiling. "Upload admission already limits the
   * queue" is exactly the reasoning that made the processing gate necessary.
   */
  queueLimit: {
    envVar: "BACKUP_RESTORE_QUEUE_LIMIT",
    default: 4,
    description: "restores that may wait for a processing slot before a 503",
  },
  /**
   * How long one restore may wait for a slot before its request is refused.
   *
   * The same order as the upload receive deadline (`DEFAULT_RECEIVE_TIMEOUT_MS`),
   * for the same reason: a bounded wait the caller can retry beats an open-ended
   * one they cannot tell from a hang. Long enough to absorb a small restore ahead
   * in the queue; a caller behind a large one gets a 503 with `Retry-After`, which
   * is a fact they can act on.
   */
  waitTimeoutMs: {
    envVar: "BACKUP_RESTORE_QUEUE_WAIT_MS",
    default: 120_000,
    description: "milliseconds a restore may wait for a processing slot",
  },
} as const satisfies Record<string, RestoreQueueKnobSpec>;

export type RestoreQueueKnob = keyof typeof RESTORE_QUEUE_KNOBS;

/** The resolved values, in the units the gate uses. */
export type RestoreQueueConfig = Record<RestoreQueueKnob, number>;

/**
 * Seconds a refused restore is told to wait before retrying.
 *
 * One constant for every *transient* restore refusal -- the upload budget being
 * occupied, the queue being full, a wait that timed out. They are the same fact
 * ("capacity exists, not for you right now"), so they carry the same number.
 * The zero-capacity 503 deliberately carries no `Retry-After`: retrying without
 * changing the deployment cannot help.
 */
export const RESTORE_RETRY_AFTER_SECONDS = 30;

/** The defaults, as a resolved config, for a gate nobody configured. */
export const DEFAULT_RESTORE_QUEUE_CONFIG: RestoreQueueConfig = {
  queueLimit: RESTORE_QUEUE_KNOBS.queueLimit.default,
  waitTimeoutMs: RESTORE_QUEUE_KNOBS.waitTimeoutMs.default,
};

const knobEntries = (): Array<[RestoreQueueKnob, RestoreQueueKnobSpec]> =>
  Object.entries(RESTORE_QUEUE_KNOBS) as Array<
    [RestoreQueueKnob, RestoreQueueKnobSpec]
  >;

/**
 * Read both knobs from the environment.
 *
 * `resolvePositiveInt` rather than `Number(...)` so an unset variable and a typo
 * are different events: the first is the default, the second is the default plus
 * a warning the operator can act on.
 */
export function resolveRestoreQueueConfig(
  env: Record<string, string | undefined> = process.env,
  onInvalid?: (message: string) => void,
): RestoreQueueConfig {
  return knobEntries().reduce<RestoreQueueConfig>(
    (config, [key, spec]) => {
      const { value, invalid } = resolvePositiveInt(
        env[spec.envVar],
        spec.default,
      );
      if (invalid) {
        onInvalid?.(
          `Could not read ${spec.envVar}="${env[spec.envVar]}" as a positive ` +
            `integer (${spec.description}); using ${spec.default}.`,
        );
      }
      return { ...config, [key]: value };
    },
    { ...DEFAULT_RESTORE_QUEUE_CONFIG },
  );
}
