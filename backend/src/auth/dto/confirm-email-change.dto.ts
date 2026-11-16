import { IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ConfirmEmailChangeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  token: string;
}
