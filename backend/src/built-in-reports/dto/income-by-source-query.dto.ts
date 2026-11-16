import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from "class-validator";
import { splitCsv } from "../../common/helpers/split-csv";
import { ReportQueryDto } from "./report-query.dto";

/**
 * Income by Source takes the account scope the Cash Flow page applies to all
 * three of its reads (`docs/specs/report-tag-key-breakdown.md` section 10.7);
 * absent means every account, as it always was.
 */
export class IncomeBySourceQueryDto extends ReportQueryDto {
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
}
