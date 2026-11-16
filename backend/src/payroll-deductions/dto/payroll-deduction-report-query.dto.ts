import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

import {
  PAYROLL_REPORT_MAX_YEAR,
  PAYROLL_REPORT_MIN_YEAR,
} from "../payroll-deduction-report";

/** `GET /payroll-deductions/report` (docs/specs/payroll-deductions.md section 10). */
export class PayrollDeductionReportQueryDto {
  @ApiPropertyOptional({
    example: 2026,
    description:
      "The year whose periods are reported (each category's period starting in it); defaults to the current year",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PAYROLL_REPORT_MIN_YEAR)
  @Max(PAYROLL_REPORT_MAX_YEAR)
  year?: number;
}
