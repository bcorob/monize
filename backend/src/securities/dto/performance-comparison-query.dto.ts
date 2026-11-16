import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  Matches,
  IsUUID,
  ValidateIf,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { MARKET_INDEX_CODES } from "../market-indexes";
import { splitCsv } from "../../common/helpers/split-csv";

export class PerformanceComparisonQueryDto {
  @ApiPropertyOptional({
    description: "Security ids to plot (comma-separated)",
    type: [String],
  })
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  // An unbounded array turns the per-instrument price load into a
  // denial-of-service lever, and `common/array-bound-dto.spec.ts` fails on a new
  // one. Twenty lines is already more than a chart can be read at.
  @ArrayMaxSize(20)
  @IsUUID("4", { each: true })
  securityIds?: string[];

  @ApiPropertyOptional({
    description: "Market index codes to overlay (comma-separated)",
    type: [String],
  })
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(MARKET_INDEX_CODES, { each: true })
  indexCodes?: string[];

  /**
   * `@ValidateIf` rather than `@IsOptional` alone: a range control the user
   * left on a preset sends `startDate=""`, and `@IsOptional` waives validation
   * for `undefined` and `null` only -- so the format check would run on the
   * empty string and reject the whole request (`docs/backend/entities-and-dtos.md`, DTO
   * conventions).
   */
  @ApiPropertyOptional({ description: "Window start (YYYY-MM-DD)" })
  @ValidateIf(
    (_o, value) => value !== null && value !== undefined && value !== "",
  )
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "startDate must be in YYYY-MM-DD format",
  })
  // The regex checks the shape only: `2025-13-45` and `2100-02-29` both match
  // it and are not dates. Strict ISO-8601 validation is what rejects them,
  // before `new Date(...)` downstream turns one into `Invalid Date` and the
  // whole window silently becomes NaN.
  @IsISO8601({ strict: true }, { message: "startDate must be a real date" })
  startDate?: string;

  @ApiPropertyOptional({ description: "Window end (YYYY-MM-DD)" })
  @ValidateIf(
    (_o, value) => value !== null && value !== undefined && value !== "",
  )
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "endDate must be in YYYY-MM-DD format",
  })
  @IsISO8601({ strict: true }, { message: "endDate must be a real date" })
  endDate?: string;

  /**
   * A chart of nothing is not a chart.
   *
   * This is not a class-validator constraint because both fields it depends on
   * are `@IsOptional`, and class-validator waives every other validator on an
   * absent property -- so a constraint hung on either one would be skipped in
   * exactly the case it exists to catch. A sentinel property would work but
   * would also become part of the accepted request surface under
   * `forbidNonWhitelisted`. The controller calls this before it calls the
   * service, which is early enough: nothing here writes.
   */
  hasSelection(): boolean {
    return (this.securityIds?.length ?? 0) + (this.indexCodes?.length ?? 0) > 0;
  }
}
