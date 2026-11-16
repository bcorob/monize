import { IsString, Matches, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * Body for POST /auth/2fa/reset: the self-service replacement of an exposed or
 * unusable authenticator. It takes both proofs -- the account password and a
 * second factor -- so a stolen session alone cannot strip 2FA off an account.
 *
 * The second factor is a 6-digit authenticator code or one backup code
 * (consumed). When the TOTP secret can no longer be decrypted (the
 * `JWT_SECRET` it is encrypted under changed), only a backup code can answer;
 * there is deliberately no password-only path.
 */
export class Reset2faDto {
  @ApiProperty({ description: "Current account password" })
  @IsString()
  @MaxLength(128)
  currentPassword: string;

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
