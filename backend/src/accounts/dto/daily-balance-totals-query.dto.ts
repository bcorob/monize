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

/**
 * The window a calendar's Balances layer asks for: one month's grid, which is
 * at most six weeks, plus whatever slack the cap allows.
 *
 * Both dates are required and both bounds are real. `startDate` shape-checked
 * only would let `2100-02-29` reach Postgres as a date literal (a 500 for a
 * client error), and an unbounded range would ask `BalanceForecastService` to
 * expand every schedule across an arbitrary horizon and then sum a per-day
 * series over every account in scope.
 */
export class DailyBalanceTotalsQueryDto {
  @ApiProperty({
    example: "2026-06-01",
    description: "Inclusive first day of the range",
  })
  @IsCalendarDate({
    message: "startDate must be a real YYYY-MM-DD calendar date",
  })
  startDate: string;

  @ApiProperty({
    example: "2026-06-30",
    description: `Inclusive last day of the range, at most ${CALENDAR_RANGE_MAX_DAYS} days from startDate`,
  })
  @IsCalendarDate({
    message: "endDate must be a real YYYY-MM-DD calendar date",
  })
  @IsCalendarRangeEnd("startDate", CALENDAR_RANGE_MAX_DAYS, {
    message: `endDate must be on or after startDate and no more than ${CALENDAR_RANGE_MAX_DAYS} days from it`,
  })
  endDate: string;

  @ApiPropertyOptional({
    description:
      "Account ids to total (comma-separated). Every open account when omitted.",
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
      "Currency to report the totals in. Defaults to the user's preferred currency.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsString()
  @Length(3, 3)
  displayCurrency?: string;
}
