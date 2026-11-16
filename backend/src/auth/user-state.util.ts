export interface UserAuthState {
  isActive: boolean;
  mustChangePassword: boolean;
}

export type AuthDenialReason =
  "not_found" | "inactive" | "must_change_password";

export interface CheckUserAuthStateOptions {
  enforceMustChangePassword: boolean;
}

export function checkUserAuthState(
  user: UserAuthState | null | undefined,
  options: CheckUserAuthStateOptions,
): AuthDenialReason | null {
  if (!user) return "not_found";
  if (!user.isActive) return "inactive";
  if (options.enforceMustChangePassword && user.mustChangePassword) {
    return "must_change_password";
  }
  return null;
}
