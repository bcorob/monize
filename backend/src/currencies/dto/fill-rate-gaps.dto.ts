import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Length, Matches } from "class-validator";

/**
 * The currency whose rate history against the caller's reporting currency is
 * to have its gaps filled.
 *
 * Only the code: the other side of the pair is the caller's own default
 * currency, read on the server, so a request cannot name a pair that is nobody's
 * to fetch.
 */
export class FillRateGapsDto {
  @ApiProperty({ example: "EUR", description: "ISO 4217 currency code" })
  @Transform(({ value }) =>
    typeof value === "string" ? value.toUpperCase() : value,
  )
  @IsString()
  @Length(3, 3, { message: "Currency code must be exactly 3 characters" })
  @Matches(/^[A-Z]{3}$/, {
    message: "Currency code must be exactly 3 letters (e.g., USD, CAD)",
  })
  code: string;
}
