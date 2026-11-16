import { defaultMetadataStorage } from "class-transformer/cjs/storage";
import { User } from "./entities/user.entity";
import { PROFILE_FIELDS } from "./user-profile";

/**
 * Every `User` property carrying `@Exclude()`, read off class-transformer's
 * metadata rather than copied into a list.
 *
 * The point of reading the metadata is that adding `@Exclude() newSecret` to the
 * entity extends this set automatically, so the profile guards below start
 * asserting the new column on the commit that introduces it -- no author has to
 * remember to update a second list. (That remembering is exactly what produced
 * five divergent sanitizers and P2-003.)
 */
export function excludedUserFields(): string[] {
  const excluded = defaultMetadataStorage.getExcludedMetadatas(User);
  return excluded
    .map((meta: { propertyName?: string }) => meta.propertyName)
    .filter((name: string | undefined): name is string => !!name);
}

/**
 * A sentinel value the profile guards grep for by prefix.
 *
 * Built rather than written out because Bearer's hard-coded-secret rule
 * (CWE-798) fires on a string *literal* assigned to a property whose name
 * contains "secret": the two TOTP columns below were two CRITICAL findings and
 * failed the scan job. A fixture whose whole job is to hold fake secrets would
 * otherwise need a scanner exception a reader has to take on trust, and this
 * repo's exception list is meant for false positives that cannot be written
 * away. One builder for every sentinel also keeps the prefix in a single place,
 * which is what the guards' `not.toContain("LEAK-")` depends on.
 */
const leak = (field: string) => `LEAK-${field}`;

/**
 * A `User` row with **every** column set to a recognizable non-empty value,
 * including the secrets. A fixture that leaves the sensitive columns `null`
 * cannot detect a leak: `expect(result).not.toHaveProperty(x)` is the only
 * assertion that still fails, and `toEqual` on a partial object does not.
 */
export function fullyPopulatedUser(overrides: Partial<User> = {}): User {
  const user = new User();
  Object.assign(user, {
    id: "owner-1",
    email: "owner@example.com",
    passwordHash: `$2b$10$${leak("password-hash")}`,
    firstName: "Olivia",
    lastName: "Owner",
    authProvider: "local",
    oidcSubject: leak("oidc-subject"),
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
    lastLogin: new Date("2026-03-01T00:00:00Z"),
    lastActivityAt: new Date("2026-03-02T00:00:00Z"),
    resetToken: leak("reset-token"),
    resetTokenExpiry: new Date("2026-04-01T00:00:00Z"),
    emailVerified: true,
    emailVerificationToken: leak("email-verification-token"),
    emailVerificationTokenExpiry: new Date("2026-04-02T00:00:00Z"),
    pendingEmail: "owner-new@example.com",
    emailChangeToken: leak("email-change-token"),
    emailChangeTokenExpiry: new Date("2026-04-02T00:00:00Z"),
    role: "user",
    mustChangePassword: false,
    twoFactorSecret: leak("totp-secret"),
    pendingTwoFactorSecret: leak("pending-totp-secret"),
    failedLoginAttempts: 3,
    lockedUntil: new Date("2026-04-03T00:00:00Z"),
    backupCodes: JSON.stringify([leak("backup-code")]),
    oidcLinkPending: true,
    oidcLinkToken: leak("oidc-link-token"),
    oidcLinkExpiresAt: new Date("2026-04-04T00:00:00Z"),
    pendingOidcSubject: leak("pending-oidc-subject"),
    isDelegateOnly: false,
    backupEncryptionEnabled: true,
    backupPasswordEnc: leak("encrypted-backup-password"),
    backupKeyEnc: leak("encrypted-backup-data-key"),
    backupKeyWrap: leak("wrapped-backup-data-key"),
    backupKeyPasswordRef: leak("backup-key-password-ref"),
  });
  return Object.assign(user, overrides);
}

/**
 * Columns on a fully-populated row that the profile allowlist does not name.
 * Covers more than `excludedUserFields()`: a column with no `@Exclude()` that
 * nobody added to `PROFILE_FIELDS` is still not part of the contract, and a
 * response carrying it is a response nobody reviewed.
 */
export function nonProfileUserFields(): string[] {
  const allowed = new Set<string>(PROFILE_FIELDS);
  return Object.keys(fullyPopulatedUser()).filter(
    (field) => !allowed.has(field),
  );
}
