import { BadRequestException } from "@nestjs/common";

import { CALENDAR_DAY_NOTE_MAX_SPAN_DAYS } from "../common/calendar-day-note";
import { tr } from "../i18n/translate";
import { calendarRangeDays } from "../common/validators/calendar-range.validator";
import type { DayNoteSpan } from "./calendar-day-notes.service";

/** What a save asks for, before the day it was asked from is taken into account. */
export interface RequestedDayNoteSpan {
  body: string;
  startDate?: string;
  endDate?: string;
}

/**
 * The span a save actually writes, given the day the reader had it open on.
 *
 * Both dates are optional on the wire because most notes are one day: a save
 * that names neither writes the anchor day alone, and one that names only a
 * start runs to that same day. The class-validator decorators have already
 * established that whatever IS present is a real calendar date; what they
 * cannot see is the route parameter, which is why the three rules that involve
 * it are here rather than on the DTO.
 *
 * The anchor must fall inside the span. The panel that sent the save is showing
 * that day, and a span that skips it would store a note the reader is told they
 * just wrote and cannot see -- the save would succeed and the surface would go
 * back to "Add a note".
 */
export function resolveDayNoteSpan(
  anchorDate: string,
  requested: RequestedDayNoteSpan,
): DayNoteSpan {
  const startDate = requested.startDate ?? anchorDate;
  const endDate = requested.endDate ?? startDate;

  if (endDate < startDate) {
    throw new BadRequestException(
      tr(
        "errors.params.onOrBefore",
        'The value of "endDate" must be on or before "startDate"',
        { param: "endDate", other: "startDate" },
      ),
    );
  }

  // `calendarRangeDays` counts inclusively, so a one-day note is 1 and the
  // constant counts the days BEYOND the first.
  if (
    calendarRangeDays(startDate, endDate) >
    CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1
  ) {
    throw new BadRequestException(
      tr(
        "errors.calendar.noteSpanTooLong",
        `A note may cover at most ${CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1} days`,
        { days: CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1 },
      ),
    );
  }

  if (anchorDate < startDate || anchorDate > endDate) {
    throw new BadRequestException(
      tr(
        "errors.calendar.noteSpanMissesDay",
        "The span must cover the day the note is being written from",
      ),
    );
  }

  return { startDate, endDate, body: requested.body };
}
