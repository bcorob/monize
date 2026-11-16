import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from "class-validator";

import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import {
  CALENDAR_RANGE_MAX_DAYS,
  IsCalendarRangeEnd,
} from "../../common/validators/calendar-range.validator";
import { splitCsv } from "../../common/helpers/split-csv";

/** The scope both daily-movement endpoints take. */
class DailyMovementScopeDto {
  @ApiPropertyOptional({
    description:
      "Account ids to measure (comma-separated); linked pairs are included. Every investment account when omitted.",
    type: [String],
  })
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  // Bounded because an unbounded array is a lever on the query planner, and
  // `common/array-bound-dto.spec.ts` fails a new one without a cap.
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({
    description:
      "Currency to report the movement in. Defaults to the user's preferred currency.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsString()
  @Length(3, 3)
  displayCurrency?: string;
}

/**
 * The window the calendar's Daily change layer asks for.
 *
 * Bounded for the same reason every calendar read model is: each day in the
 * range replays the scope's holdings, reads two closes per position and folds
 * a day of external flow, so an unbounded range is a cheap request that is
 * expensive to answer.
 */
export class DailyMovementsQueryDto extends DailyMovementScopeDto {
  @ApiProperty({
    example: "2026-09-01",
    description: "Inclusive first day of the range",
  })
  @IsCalendarDate({
    message: "startDate must be a real YYYY-MM-DD calendar date",
  })
  startDate: string;

  @ApiProperty({
    example: "2026-09-30",
    description: `Inclusive last day of the range, at most ${CALENDAR_RANGE_MAX_DAYS} days from startDate`,
  })
  @IsCalendarDate({
    message: "endDate must be a real YYYY-MM-DD calendar date",
  })
  @IsCalendarRangeEnd("startDate", CALENDAR_RANGE_MAX_DAYS, {
    message: `endDate must be on or after startDate and no more than ${CALENDAR_RANGE_MAX_DAYS} days from it`,
  })
  endDate: string;
}

/** One day's gain/loss breakdown. */
export class DailyMovementDetailQueryDto extends DailyMovementScopeDto {
  @ApiProperty({
    example: "2026-09-11",
    description: "The day to break down",
  })
  @IsCalendarDate({ message: "date must be a real YYYY-MM-DD calendar date" })
  date: string;
}
