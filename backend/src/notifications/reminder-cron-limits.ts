import type { Logger } from "@nestjs/common";
import { resolvePositiveInt } from "../common/env-number.util";

/** Operator-owned limits on this replica's database claims and delivery work. */
export const REMINDER_CRON_LIMIT_SPECS = {
  claimBatch: {
    envVar: "NOTIFICATION_REMINDER_CLAIM_BATCH",
    default: 100,
    max: 10000,
    description: "due reminders claimed per minute per replica",
  },
  reemitConcurrency: {
    envVar: "NOTIFICATION_REMINDER_REEMIT_CONCURRENCY",
    default: 5,
    max: 100,
    description: "reminder re-emits in flight per replica",
  },
} as const;

type LimitKey = keyof typeof REMINDER_CRON_LIMIT_SPECS;
export type ReminderCronLimits = Readonly<Record<LimitKey, number>>;

export function resolveReminderCronLimits(
  env: Record<string, unknown>,
  logger: Pick<Logger, "warn">,
): ReminderCronLimits {
  const entries = Object.entries(REMINDER_CRON_LIMIT_SPECS).map(
    ([key, spec]) => {
      const resolved = resolvePositiveInt(env[spec.envVar], spec.default);
      if (resolved.invalid || resolved.value > spec.max) {
        logger.warn(
          `${spec.envVar} must be an integer from 1 to ${spec.max}; using ${spec.default} (${spec.description})`,
        );
        return [key, spec.default];
      }
      return [key, resolved.value];
    },
  );
  return Object.fromEntries(entries) as ReminderCronLimits;
}
