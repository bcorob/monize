import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  PROFILE_FIELDS,
  SELF_ONLY_PROFILE_FIELDS,
  toDelegatedUserProfile,
  toUserProfile,
} from "./user-profile";
import {
  excludedUserFields,
  fullyPopulatedUser,
  nonProfileUserFields,
} from "./user-profile.test-util";

describe("user profile serialization", () => {
  describe("toUserProfile", () => {
    it("emits exactly the allowlist plus hasPassword", () => {
      const profile = toUserProfile(fullyPopulatedUser());

      expect(Object.keys(profile).sort()).toEqual(
        [...PROFILE_FIELDS, "hasPassword"].sort(),
      );
    });

    it("drops every @Exclude() column on the entity", () => {
      const profile = toUserProfile(fullyPopulatedUser()) as Record<
        string,
        unknown
      >;
      const excluded = excludedUserFields();

      // Guards the guard: an entity that lost its decorators would make the
      // loop below vacuous and this suite would pass while leaking everything.
      expect(excluded.length).toBeGreaterThanOrEqual(11);
      for (const field of excluded) {
        expect(profile).not.toHaveProperty(field);
      }
    });

    it("drops every column the allowlist does not name", () => {
      const profile = toUserProfile(fullyPopulatedUser()) as Record<
        string,
        unknown
      >;
      for (const field of nonProfileUserFields()) {
        expect(profile).not.toHaveProperty(field);
      }
    });

    it("serializes no value that came from a secret column", () => {
      // The fixture marks every secret with a LEAK- prefix, so this catches a
      // secret copied into a differently named field as well as one passed
      // through -- neither of which a key-name assertion sees.
      const serialized = JSON.stringify(toUserProfile(fullyPopulatedUser()));
      expect(serialized).not.toContain("LEAK-");
    });

    it("reports hasPassword without the hash", () => {
      expect(toUserProfile(fullyPopulatedUser())).toMatchObject({
        hasPassword: true,
      });
      expect(
        toUserProfile(fullyPopulatedUser({ passwordHash: null })),
      ).toMatchObject({ hasPassword: false });
    });

    // An unselected column is *unknown*, not false: the three cases below pin
    // the contract "property absent -> absent, null -> false, hash -> true".
    it("omits hasPassword when passwordHash was not selected", () => {
      const profile = toUserProfile({ id: "u1", email: "a@b.c" });

      expect(profile).toEqual({ id: "u1", email: "a@b.c" });
      expect(profile).not.toHaveProperty("hasPassword");
      expect(profile).not.toHaveProperty("role");
    });

    it("reports false when a selected passwordHash is null", () => {
      expect(toUserProfile({ id: "u1", passwordHash: null })).toMatchObject({
        hasPassword: false,
      });
    });

    it("reports true when a selected passwordHash is present", () => {
      expect(
        toUserProfile({ id: "u1", passwordHash: "$2b$10$example" }),
      ).toMatchObject({ hasPassword: true });
    });
  });

  describe("toDelegatedUserProfile", () => {
    it("keeps identification and drops the owner's credential state", () => {
      const delegated = toDelegatedUserProfile(fullyPopulatedUser()) as Record<
        string,
        unknown
      >;

      expect(delegated).toMatchObject({
        id: "owner-1",
        email: "owner@example.com",
        firstName: "Olivia",
      });
      for (const field of SELF_ONLY_PROFILE_FIELDS) {
        expect(delegated).not.toHaveProperty(field);
      }
    });

    it("drops every @Exclude() column as well", () => {
      const delegated = toDelegatedUserProfile(fullyPopulatedUser()) as Record<
        string,
        unknown
      >;
      for (const field of nonProfileUserFields()) {
        expect(delegated).not.toHaveProperty(field);
      }
      expect(JSON.stringify(delegated)).not.toContain("LEAK-");
    });

    it("does not invent credential state for a narrowed delegated row", () => {
      const profile = toDelegatedUserProfile({
        id: "owner-1",
        email: "owner@example.com",
      });

      expect(profile).not.toHaveProperty("hasPassword");
      expect(profile).not.toHaveProperty("mustChangePassword");
      expect(profile).not.toHaveProperty("backupEncryptionEnabled");
    });
  });
});

/**
 * The mechanical half of P2-003. The defect was not that one list was short --
 * it was that five call sites each wrote their own list, so the shortest one
 * decided what leaked. A test that only checks `toUserProfile` cannot see the
 * sixth site somebody adds next month, so scan the source instead.
 *
 * What these guards prove is bounded and their names say so: they reject the
 * known removal-list sanitizer *families* -- object-rest destructuring,
 * `delete obj.secret`, and `omit(user, [...])` -- when one discards a known
 * `User` secret field. They cannot prove that every conceivable sanitizer is
 * absent (a helper with a novel name or a computed key is invisible to a
 * regex); the allowlist tests above are the positive half of the contract.
 */
describe("ad-hoc user sanitizers", () => {
  const SRC = join(__dirname, "..");

  const SECRET_FIELD =
    String.raw`(?:passwordHash|resetToken|resetTokenExpiry|twoFactorSecret|` +
    String.raw`pendingTwoFactorSecret|backupCodes|oidcLinkToken|` +
    String.raw`emailVerificationToken|emailChangeToken|backupPasswordEnc)`;

  /**
   * The shape of the removed sanitizers: destructure secrets away, spread the
   * rest. The lookahead lets the secret sit anywhere in the binding list (the
   * originals ordered theirs differently), and an alias
   * (`passwordHash: ignored`) still matches because the property name stays in
   * the pattern's window.
   */
  const OBJECT_REST_SECRET_REMOVAL = new RegExp(
    String.raw`\{` +
      String.raw`(?=[\s\S]{0,1600}\b${SECRET_FIELD}\b)` +
      String.raw`[\s\S]{0,1600}\.\.\.\s*\w+\s*\}\s*=`,
  );

  /** `delete copy.passwordHash` -- mutate-a-copy sanitizers. */
  const DELETE_SECRET_PROPERTY = new RegExp(
    String.raw`\bdelete\s+\w+(?:\?\.|\.)(?:${SECRET_FIELD})\b`,
  );

  /** `omit(user, ["passwordHash", ...])` -- utility-based removal lists. */
  const OMIT_SECRET_PROPERTY = new RegExp(
    String.raw`\bomit\s*\([\s\S]{0,800}\b(?:${SECRET_FIELD})\b`,
  );

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === "node_modules" ? [] : walk(full);
      }
      return full.endsWith(".ts") && !full.endsWith(".spec.ts") ? [full] : [];
    });

  // Walk once: three pattern scans over one file list, not three walks.
  const SOURCE_FILES = walk(SRC);

  it("scans the expected production source tree", () => {
    // Guards the guard: a wrong SRC (or a walk that filters everything out)
    // would make every scan below pass vacuously.
    expect(SOURCE_FILES.length).toBeGreaterThan(500);
    expect(SOURCE_FILES).toEqual(
      expect.arrayContaining([
        join(SRC, "auth", "auth.service.ts"),
        join(SRC, "auth", "two-factor.service.ts"),
        join(SRC, "users", "users.service.ts"),
        join(SRC, "admin", "admin.service.ts"),
      ]),
    );
  });

  it("exist nowhere outside user-profile.ts", () => {
    const offenders = SOURCE_FILES.filter((file) => {
      if (file.endsWith(join("users", "user-profile.ts"))) return false;
      const source = readFileSync(file, "utf8");
      return (
        OBJECT_REST_SECRET_REMOVAL.test(source) ||
        DELETE_SECRET_PROPERTY.test(source) ||
        OMIT_SECRET_PROPERTY.test(source)
      );
    });

    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  describe("OBJECT_REST_SECRET_REMOVAL", () => {
    it.each([
      `const { passwordHash, ...rest } = user;`,
      `const { resetToken, passwordHash, ...rest } = user;`,
      `const { passwordHash: ignored, ...publicUser } = user;`,
      `const {
         resetToken,
         resetTokenExpiry,
         twoFactorSecret,
         pendingTwoFactorSecret,
         backupCodes,
         oidcLinkToken,
         emailVerificationToken,
         backupPasswordEnc,
         passwordHash,
         ...rest
       } = user;`,
    ])("detects object-rest secret removal: %s", (source) => {
      expect(OBJECT_REST_SECRET_REMOVAL.test(source)).toBe(true);
    });

    it.each([
      `return toUserProfile(user);`,
      `const { firstName, lastName } = user;`,
      `const profile = { id: user.id, email: user.email };`,
    ])("does not flag allowlist code: %s", (source) => {
      expect(OBJECT_REST_SECRET_REMOVAL.test(source)).toBe(false);
    });
  });

  describe("DELETE_SECRET_PROPERTY", () => {
    it.each([
      `delete copy.passwordHash;`,
      `delete sanitized?.twoFactorSecret;`,
    ])("detects property deletion: %s", (source) => {
      expect(DELETE_SECRET_PROPERTY.test(source)).toBe(true);
    });

    it("does not flag deleting a non-secret property", () => {
      expect(DELETE_SECRET_PROPERTY.test(`delete row.updatedAt;`)).toBe(false);
    });
  });

  describe("OMIT_SECRET_PROPERTY", () => {
    it("detects omit-based removal lists", () => {
      expect(
        OMIT_SECRET_PROPERTY.test(
          `return omit(user, ["passwordHash", "resetToken"]);`,
        ),
      ).toBe(true);
    });

    it("does not flag omitting a non-secret property", () => {
      expect(OMIT_SECRET_PROPERTY.test(`omit(user, ["updatedAt"])`)).toBe(
        false,
      );
    });
  });
});
