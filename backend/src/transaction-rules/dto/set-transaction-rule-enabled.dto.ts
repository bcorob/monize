import { IsBoolean } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SetTransactionRuleEnabledDto {
  @ApiProperty({ description: "Whether the rule runs" })
  @IsBoolean()
  enabled: boolean;
}
