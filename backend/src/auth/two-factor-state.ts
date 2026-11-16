import type { User } from "../users/entities/user.entity";
import type { UserPreference } from "../users/entities/user-preference.entity";

/**
 * Whether two-factor authentication is in force for a user: the preference flag
 * is on AND a confirmed TOTP secret is stored.
 *
 * The two live in different tables and have drifted apart before -- a secret
 * cleared by hand in the database, or a disable that cleared the secret and then
 * failed to write the flag -- leaving a flag that says "enabled" over an account
 * sign-in no longer challenges. Every surface that reports or enforces 2FA asks
 * this one question, so sign-in, step-up, delegation and the Settings page
 * cannot disagree about the same account.
 */
export function isTwoFactorActive(
  preferences: Pick<UserPreference, "twoFactorEnabled"> | null | undefined,
  user: Pick<User, "twoFactorSecret"> | null | undefined,
): boolean {
  return preferences?.twoFactorEnabled === true && !!user?.twoFactorSecret;
}
