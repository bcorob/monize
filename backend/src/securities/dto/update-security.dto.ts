import { ApiProperty, OmitType, PartialType } from "@nestjs/swagger";
import { IsBoolean, ValidateIf } from "class-validator";
import { CreateSecurityDto } from "./create-security.dto";

export class UpdateSecurityDto extends PartialType(
  OmitType(CreateSecurityDto, [
    "priceChartEnabled",
    "skipPriceUpdates",
    "bondAutoFetch",
  ] as const),
) {
  // PartialType normally treats null as absent; this NOT NULL opt-in must reject it.
  @ApiProperty({ required: false })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  priceChartEnabled?: boolean;

  // Same NOT NULL rule as priceChartEnabled: null is refused, not ignored.
  @ApiProperty({ required: false })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  skipPriceUpdates?: boolean;

  // Same: the column is NOT NULL, so null is refused rather than reaching it.
  @ApiProperty({ required: false })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  bondAutoFetch?: boolean;
}
