import { ConflictException } from "@nestjs/common";
import { ensureYMD } from "../common/recurrence";
import { tr } from "../i18n/translate";

/**
 * The occurrence a person was looking at when they pressed Post or Skip
 * (INV-OCCURRENCE-001; audit A26-S08-01).
 *
 * `occurrenceDate` is the date the client shows for the due occurrence: the
 * override's date when an override moved it, else the cursor. `overrideId` is the
 * id of that override, so an override created, edited into another identity or
 * deleted since the client read is a mismatch too. The client builds both with
 * `occurrencePin` (`frontend/src/lib/scheduled-effective-amount.ts`).
 */
export interface OccurrencePin {
  occurrenceDate: string;
  overrideId: string | null;
}

/**
 * Refuse with 409 unless the occurrence the server would act on now is the one
 * in `pin`. `cursorYmd` is the schedule's `next_due_date`; `override` is the
 * override row whose `original_date` equals it, or null. Pure: the caller reads
 * both under the schedule lock, so the refusal comes before any write.
 */
export function assertOccurrencePin(
  cursorYmd: string,
  override: { id: string; overrideDate: string | Date } | null,
  pin: OccurrencePin,
): void {
  const occurrenceDate = override
    ? ensureYMD(override.overrideDate)
    : cursorYmd;
  const overrideId = override?.id ?? null;
  if (
    occurrenceDate !== ensureYMD(pin.occurrenceDate) ||
    overrideId !== pin.overrideId
  ) {
    throw new ConflictException(
      tr(
        "errors.scheduled.changedConcurrently",
        "The scheduled transaction changed during the operation. Reload it and retry.",
      ),
    );
  }
}

/**
 * Refuse with 409 when the schedule has nothing left to post or skip: its
 * remaining count is zero, or the cursor is past `end_date`. The cron stops at
 * both; a manual action on the consumed slot would be an extra payment.
 */
export function assertScheduleHasOccurrence(schedule: {
  nextDueDate: string | Date;
  occurrencesRemaining: number | null;
  endDate: string | Date | null;
}): void {
  const exhausted =
    schedule.occurrencesRemaining === 0 ||
    (!!schedule.endDate &&
      ensureYMD(schedule.nextDueDate) > ensureYMD(schedule.endDate));
  if (exhausted) {
    throw new ConflictException(
      tr(
        "errors.scheduled.noOccurrencesLeft",
        "This schedule has no occurrences left to post or skip.",
      ),
    );
  }
}
