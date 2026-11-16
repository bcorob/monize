import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsUUID,
  Matches,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { InvestmentGroupBy } from "../entities/investment-report.entity";

export class ExecuteInvestmentReportDto {
  @ApiPropertyOptional({
    description: "Override the as-of date (YYYY-MM-DD)",
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "asOfDate must be in YYYY-MM-DD format",
  })
  asOfDate?: string;

  @ApiPropertyOptional({
    description:
      "Override the accounts to include for this run (empty means all). " +
      "Defaults to the report's saved accounts when omitted.",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  accountIds?: string[];
}

/** A single computed value cell. Null means the value is not available. */
export type InvestmentCellValue = string | number | null;

/** One report row: a holding (one security in one account) with its values. */
export interface InvestmentReportRow {
  /** Stable row id (`${accountId}:${securityId}`). */
  id: string;
  /** The holding's own (security) currency, for formatting native values. */
  currency: string;
  /** Rate to multiply this row's native monetary values by to get base currency. */
  /**
   * Rate used to convert this row's native values into the base currency, or
   * `null` when no rate exists for the pair -- never 1 as a stand-in for one.
   */
  baseExchangeRate: number | null;
  /** Column key -> computed value (native currency). */
  values: Record<string, InvestmentCellValue>;
}

/** A group of rows when groupBy is set (one group when groupBy is NONE). */
export interface InvestmentReportGroup {
  /** Stable group key. */
  key: string;
  /** Human-readable group heading. */
  label: string;
  rows: InvestmentReportRow[];
}

export interface InvestmentReportResult {
  reportId: string;
  name: string;
  /** The resolved as-of date the report was valued at (YYYY-MM-DD). */
  asOfDate: string;
  /** The user's base currency, used for % of portfolio and exchange rate. */
  baseCurrency: string;
  groupBy: InvestmentGroupBy;
  /** Ordered column keys included in the report. */
  columns: string[];
  groups: InvestmentReportGroup[];
  rowCount: number;
  /**
   * False when a currency pair the rows needed had no admissible rate. The
   * base-currency figures and every row's `portfolioPercent` are then partial,
   * and the surface says so rather than leaving a total's caption over them.
   */
  fxComplete?: boolean;
  /** `"SEK->USD"` for each pair that could not be resolved. */
  missingPairs?: string[];
  /**
   * False when a held position had no price on or before the as-of date. The
   * same figures are partial, and the repair is a price refresh rather than a
   * rate: a surface reads both flags as `=== false` and names the cause it has.
   */
  pricesComplete?: boolean;
  /** The symbol of each unpriced position. */
  unpricedSymbols?: string[];
}
