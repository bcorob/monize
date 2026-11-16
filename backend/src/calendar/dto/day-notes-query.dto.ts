import { ApiProperty } from "@nestjs/swagger";

import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import {
  CALENDAR_RANGE_MAX_DAYS,
  IsCalendarRangeEnd,
} from "../../common/validators/calendar-range.validator";

/**
 * The window the calendar asks for its notes over: one month grid, bounded by
 * the same constant every other calendar read uses.
 */
export class DayNotesQueryDto {
  @ApiProperty({ example: "2026-06-01" })
  @IsCalendarDate({
    message: "startDate must be a real YYYY-MM-DD calendar date",
  })
  startDate: string;

  @ApiProperty({ example: "2026-06-30" })
  @IsCalendarDate({
    message: "endDate must be a real YYYY-MM-DD calendar date",
  })
  @IsCalendarRangeEnd("startDate", CALENDAR_RANGE_MAX_DAYS, {
    message: `endDate must be on or after startDate and no more than ${CALENDAR_RANGE_MAX_DAYS} days from it`,
  })
  endDate: string;
}
