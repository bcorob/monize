import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { splitCsv } from "../../common/helpers/split-csv";
import { ReportQueryDto } from "./report-query.dto";

/** Surrounding whitespace is a paste artifact, never part of a tag key. */
const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/**
 * Cash Flow answers through the same `IncomeReportsService.getIncomeVsExpenses`
 * query as Income vs Expenses (`built-in-reports.controller.ts`), so it takes
 * the same optional tag-key breakdown (`docs/specs/report-tag-key-breakdown.md`).
 * It also takes the same optional account scope, which the page sends to its
 * two sibling reads (`income-by-source`, `spending-by-category`) as well so the
 * whole page describes one set of accounts. The other Income vs Expenses knobs
 * (`bucket`, `weekStartsOn`) are out of scope for this route.
 */
export class CashFlowQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    description: "Account ids to restrict the report to (comma-separated)",
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

  /** The tagged-transfer boundary when `accountIds` is absent; see `IncomeVsExpensesQueryDto`. */
  @ApiPropertyOptional({
    description:
      "Account ids (comma-separated) that bound the tagged transfer flows when accountIds is absent. Income and expenses are not filtered by it.",
    type: [String],
  })
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  transferScopeAccountIds?: string[];

  @ApiPropertyOptional({
    description:
      "Bare KEY of a KEY:VALUE tag to break the report down by (e.g. 'scope'). Absent renders today's response unchanged.",
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  tagKey?: string;
}
