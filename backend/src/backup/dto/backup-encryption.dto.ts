import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength, MaxLength } from "class-validator";

export class SetBackupPasswordDto {
  @ApiProperty({ description: "Backup password (used to encrypt backups)" })
  @IsString()
  @MinLength(12)
  @MaxLength(1024)
  backupPassword: string;
}

/**
 * The login password a local account confirms in Settings to turn on encrypted
 * backups. No `MinLength` beyond the DTO floor: it is checked against the
 * account's own hash, not against a policy -- an existing password shorter than
 * today's registration rule is still the password that opens their backups, and
 * refusing it here would refuse the very users who most need the capture.
 */
export class ConfirmLoginPasswordDto {
  @ApiProperty({
    description: "The account's current login password, for confirmation",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  loginPassword: string;
}
