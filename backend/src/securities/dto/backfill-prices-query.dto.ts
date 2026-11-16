import { IsIn, ValidateIf } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Provider history ranges a backfill may ask for.
 *
 * An allowlist rather than a free string: the value is interpolated into the
 * provider's URL, and the set is small and fixed by the providers themselves.
 * Anything outside it is a typo that would otherwise come back as an opaque
 * "no historical data available".
 */
export const BACKFILL_RANGES = ["1y", "2y", "5y", "10y", "ytd", "max"] as const;

export type BackfillRange = (typeof BACKFILL_RANGES)[number];

export class BackfillPricesQueryDto {
  /**
   * How much history to fetch, and -- because the two go together -- whether
   * the holding-period clip applies.
   *
   * **Omitted** keeps the default: fetch a year (plus `max` where the security
   * was held longer) and store from the first transaction date onward, which is
   * what a position valuation needs and nothing more.
   *
   * **Supplied** means "store everything the provider returns for this range",
   * with no clip. Backtests, the GEM report and the performance comparison all
   * want prices from before the user bought, and the clip is exactly what
   * denies them: a security first transacted in May 2025 had ten years of
   * available history reduced to fifteen months, with no way to ask for more.
   *
   * `@ValidateIf` rather than `@IsOptional` alone, so `?range=` behaves as
   * absent instead of failing the whole request (`docs/backend/entities-and-dtos.md`).
   */
  @ApiPropertyOptional({
    enum: BACKFILL_RANGES,
    description:
      "History range to fetch. Supplying it also disables the holding-period clip, storing everything the provider returns.",
  })
  @ValidateIf(
    (_o, value) => value !== undefined && value !== null && value !== "",
  )
  @IsIn(BACKFILL_RANGES)
  range?: BackfillRange;
}
