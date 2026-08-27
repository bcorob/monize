import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import {
  IsCalendarDate,
  IsDateWithinHorizon,
} from "../../common/validators/is-calendar-date.validator";

/**
 * The furthest ahead a client may ask for occurrences: five years, which covers
 * every projection the app draws (the longest is the AI forecast's own, and that
 * one is server-side). It is a walk bound, not a display preference.
 */
export const OCCURRENCE_HORIZON_MAX_DAYS = 1830;

/**
 * The window an occurrence-aware surface asks for.
 *
 * `maxPerSchedule` bounds the payload rather than the horizon: a daily schedule
 * over a long window is what makes the response large, and the cap is applied
 * after ordering by due date, so the occurrences that are returned are always the
 * next ones.
 *
 * Both bounds are real. `through` used to be shape-checked only, so
 * `9999-99-99` passed validation and reached Postgres as a date literal (a 500
 * for a client error), and `9999-12-31` was a cheap request that walked every
 * schedule to `OCCURRENCE_WALK_GUARD` and serialized up to `maxPerSchedule`
 * occurrences each.
 */
export class ScheduledOccurrencesQueryDto {
  @ApiProperty({
    example: "2026-11-30",
    description: "Inclusive last due date to expand occurrences through",
  })
  @IsCalendarDate({ message: "through must be a real YYYY-MM-DD date" })
  @IsDateWithinHorizon(OCCURRENCE_HORIZON_MAX_DAYS, {
    message: `through must be within ${OCCURRENCE_HORIZON_MAX_DAYS} days of today`,
  })
  through: string;

  @ApiPropertyOptional({
    example: 100,
    default: 100,
    description: "Maximum occurrences returned per schedule (by due date)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxPerSchedule?: number;
}
