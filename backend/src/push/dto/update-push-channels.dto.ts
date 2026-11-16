import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

/**
 * The instance-level Web Push kill-switch. Administrator-only, and the only
 * push setting that is not the individual account's to make.
 */
export class UpdatePushChannelsDto {
  @ApiProperty()
  @IsBoolean()
  webPushEnabled: boolean;
}
