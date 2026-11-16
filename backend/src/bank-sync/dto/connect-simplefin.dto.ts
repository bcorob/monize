import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from "class-validator";

export class ConnectSimplefinDto {
  @ApiProperty({
    description: "One-time SimpleFIN Bridge setup token. Never returned.",
    maxLength: 16384,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16384)
  setupToken: string;

  @ApiPropertyOptional({
    description:
      "Explicitly confirm replacing the existing SimpleFIN credential.",
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  replaceExisting?: boolean;
}
