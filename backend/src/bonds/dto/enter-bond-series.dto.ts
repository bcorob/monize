import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { FetchBondSeriesDto } from "./fetch-bond-series.dto";

const DECIMAL = /^\d{1,3}(\.\d{1,6})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class BondSaleWindowDto {
  @ApiProperty({ example: "2026-10-01" })
  @IsString()
  @Matches(ISO_DATE, { message: "from must be a YYYY-MM-DD date" })
  from: string;

  @ApiProperty({ example: "2026-10-31" })
  @IsString()
  @Matches(ISO_DATE, { message: "to must be a YYYY-MM-DD date" })
  to: string;
}

export class BondLetterDto {
  @ApiProperty({ example: "12/2026", maxLength: 32 })
  @IsString()
  @MaxLength(32)
  number: string;

  @ApiProperty({ example: "2026-09-21" })
  @IsString()
  @Matches(ISO_DATE, { message: "date must be a YYYY-MM-DD date" })
  date: string;
}

/** The per-series values of the adapter's template; the bounds are the adapter's. */
export class BondSeriesValuesDto {
  @ApiProperty({ example: "0.0535", description: "A fraction" })
  @IsString()
  @Matches(DECIMAL, { message: "firstPeriodRate must be a decimal" })
  firstPeriodRate: string;

  @ApiProperty({ required: false, nullable: true, example: "0.0200" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsString()
  @Matches(DECIMAL, { message: "addend must be a decimal" })
  addend?: string | null;

  @ApiProperty({ required: false, nullable: true, example: "2.00" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsString()
  @Matches(DECIMAL, { message: "fee must be a decimal" })
  fee?: string | null;

  @ApiProperty({ type: BondSaleWindowDto })
  @ValidateNested()
  @Type(() => BondSaleWindowDto)
  saleWindow: BondSaleWindowDto;

  @ApiProperty({ type: BondLetterDto })
  @ValidateNested()
  @Type(() => BondLetterDto)
  letter: BondLetterDto;
}

export class EnterBondSeriesDto extends FetchBondSeriesDto {
  @ApiProperty({ type: BondSeriesValuesDto })
  @ValidateNested()
  @Type(() => BondSeriesValuesDto)
  values: BondSeriesValuesDto;
}
