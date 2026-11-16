import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from "class-validator";
import { ReportQueryDto } from "./report-query.dto";
import { splitCsv } from "../../common/helpers/split-csv";

/** Surrounding whitespace is a paste artifact, never part of a tag key or value. */
const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/**
 * Spending by Category is the one answer the full report and the dashboard
 * widget both draw, so the two settings the widget carried on the client --
 * which accounts, and whether subcategories roll up -- are asked of the server
 * instead of re-derived beside it.
 */
export class SpendingByCategoryQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    description: "Account ids to restrict the report to (comma-separated)",
    type: [String],
  })
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  // Bounded because an unbounded array is a lever on the query planner, and
  // `common/array-bound-dto.spec.ts` fails a new one without a cap. No user has
  // more accounts than this to pick from in one filter.
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({
    description:
      "Count a subcategory's spend against its top-level ancestor. Defaults to true.",
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true" || value === true)
  rollupToParent?: boolean;

  /**
   * Restrict the report to rows carrying `tagKey:tagValue`
   * (`docs/specs/report-tag-key-breakdown.md` section 11.4). The two travel
   * together: validation runs on either as soon as one is present, so a
   * half-specified filter is a 400 and never a silently unfiltered report.
   */
  @ApiPropertyOptional({
    description:
      "Bare KEY of a KEY:VALUE tag to filter by (e.g. 'scope'). Requires tagValue.",
  })
  @ValidateIf(
    (o: SpendingByCategoryQueryDto) =>
      o.tagKey !== undefined || o.tagValue !== undefined,
  )
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tagKey?: string;

  @ApiPropertyOptional({
    description:
      "Value of the tag key to filter by (e.g. 'household'). Requires tagKey.",
  })
  @ValidateIf(
    (o: SpendingByCategoryQueryDto) =>
      o.tagKey !== undefined || o.tagValue !== undefined,
  )
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tagValue?: string;
}
