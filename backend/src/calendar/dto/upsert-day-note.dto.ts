import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

import { CALENDAR_DAY_NOTE_MAX_LENGTH } from "../../common/calendar-day-note";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";

/**
 * The body of a day note, and the run of days it covers.
 *
 * The body is trimmed before validation, so whitespace cannot buy length and a
 * body of nothing but spaces is the blank it looks like. A blank body is a 400,
 * NEVER a delete: deleting is its own verb, and inferring it from an empty
 * field would make an accidentally cleared textarea destroy the note on save.
 *
 * The lower bound is also the database's: `ck_calendar_day_notes_body_length`
 * refuses an empty string, so without it the 400 would arrive as a constraint
 * violation with no field named.
 *
 * Both dates are optional because most notes are one day: omitting them writes
 * the day in the URL alone. Their relationship to that day -- which
 * class-validator cannot see -- is `resolveDayNoteSpan`'s, and the length of the
 * span is `ck_calendar_day_notes_span`'s.
 */
export class UpsertDayNoteDto {
  @ApiProperty({ maxLength: CALENDAR_DAY_NOTE_MAX_LENGTH })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: "body must not be blank" })
  @MaxLength(CALENDAR_DAY_NOTE_MAX_LENGTH)
  body: string;

  /** The first day the note covers; defaults to the day in the URL. */
  @ApiPropertyOptional({ example: "2026-06-15" })
  @IsOptional()
  @IsCalendarDate({
    message: "startDate must be a real YYYY-MM-DD calendar date",
  })
  startDate?: string;

  /** The last day it covers, inclusive; defaults to the first. */
  @ApiPropertyOptional({ example: "2026-06-22" })
  @IsOptional()
  @IsCalendarDate({
    message: "endDate must be a real YYYY-MM-DD calendar date",
  })
  endDate?: string;
}
