import {
  IsISO8601,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * The most rows a single price-history read may return.
 *
 * Thirty-plus years of daily closes is around 7,800 rows, so this is roughly
 * three lifetimes of an instrument: a request that reaches it is a data anomaly
 * rather than an ordinary window. The bound exists so an unbounded window cannot
 * pull an arbitrary number of rows into memory, not to shape ordinary results.
 */
export const MAX_PRICE_HISTORY_ROWS = 25_000;

/** Rows returned when neither a window nor a limit is supplied. */
export const DEFAULT_PRICE_HISTORY_ROWS = 365;

export class PriceHistoryQueryDto {
  /**
   * `@ValidateIf` rather than `@IsOptional` alone: a chart on a preset range
   * sends `startDate=""`, and `@IsOptional` waives validation for `undefined`
   * and `null` only -- the format check would otherwise run on the empty string
   * and reject the request (`docs/backend/entities-and-dtos.md`, DTO conventions).
   */
  @ApiPropertyOptional({ description: "Earliest price date (YYYY-MM-DD)" })
  @ValidateIf(
    (_o, value) => value !== null && value !== undefined && value !== "",
  )
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "startDate must be in YYYY-MM-DD format",
  })
  // The regex checks the shape only: `2025-13-45` matches it and is not a date.
  @IsISO8601({ strict: true }, { message: "startDate must be a real date" })
  startDate?: string;

  @ApiPropertyOptional({ description: "Latest price date (YYYY-MM-DD)" })
  @ValidateIf(
    (_o, value) => value !== null && value !== undefined && value !== "",
  )
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "endDate must be in YYYY-MM-DD format",
  })
  @IsISO8601({ strict: true }, { message: "endDate must be a real date" })
  endDate?: string;

  @ApiPropertyOptional({
    description: `Row cap (default ${DEFAULT_PRICE_HISTORY_ROWS} with no window, ${MAX_PRICE_HISTORY_ROWS} with one)`,
  })
  @ValidateIf(
    (_o, value) => value !== null && value !== undefined && value !== "",
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_HISTORY_ROWS)
  limit?: number;
}
