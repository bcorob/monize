import { IsString, Matches, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * Switching 2FA off takes the same two proofs signing in does: a code from
 * the authenticator app, or one backup code (consumed). The backup code is
 * what lets a user whose TOTP secret can no longer be decrypted -- the
 * `JWT_SECRET` it is encrypted under changed -- turn 2FA off and enroll again
 * without an administrator.
 */
export class Disable2faDto {
  @ApiProperty({
    description:
      "6-digit TOTP code from authenticator app or XXXX-XXXX backup code",
  })
  @IsString()
  @MaxLength(9)
  @Matches(/^(\d{6}|[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4})$/, {
    message: "Code must be a 6-digit TOTP code or a backup code (XXXX-XXXX)",
  })
  code: string;
}
