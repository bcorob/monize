/**
 * The one rule for how good a `JWT_SECRET` is, in two severities.
 *
 * `JWT_SECRET` signs every session token and is the root every purpose key is
 * derived from (CSRF, TOTP encryption, the OAuth and trusted-device cookie
 * keys, restore tickets), so a value an attacker can guess is a forged session
 * for every account.
 *
 * - **Fatal** (`jwtSecretFatalProblem`): missing, or shorter than
 *   `MIN_JWT_SECRET_LENGTH`. The server refuses to start: `checkClusterBoot`
 *   turns it into a first-line log message and `JwtStrategy` refuses the same
 *   value further in.
 * - **Weak** (`jwtSecretWeakness`): long enough, but a published placeholder,
 *   built around a placeholder phrase, or so repetitive it was typed rather
 *   than generated. The server starts -- refusing would turn an upgrade into an
 *   outage for a deployment that has run on that value for years, and changing
 *   it has consequences an operator must plan for (every session ends, and
 *   authenticator codes stop working because TOTP secrets are encrypted under
 *   a key derived from it, so users recover with a backup code or an
 *   administrator's 2FA reset). Instead it is reported three ways: a boot warning
 *   (`logJwtSecretStatus`), a weekly admin system alert
 *   (`SystemAlertMonitorService`) and an admin-only banner
 *   (`GET /admin/deployment-status`).
 *
 * Every caller goes through `assessJwtSecret`, so the boot refusal, the
 * strategy, the warning, the alert and the banner cannot disagree about which
 * value is which.
 *
 * The weak rule is deliberately conservative. Every value "openssl rand
 * -base64 32" or "openssl rand -hex 32" can produce passes it (see the spec for
 * the arithmetic); what it flags is a known placeholder, anything built around
 * a placeholder phrase, and a value whose character set or repetition shows it
 * was typed rather than generated.
 */

import { timingSafeEqual } from "crypto";

/** Shortest `JWT_SECRET` the server will start with. Below it is fatal. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Fewest distinct characters a secret may be built from. A 64-character hex
 * string draws from 16 symbols and holds fewer than 8 of them with probability
 * about 1e-19; `"x".repeat(32)` or `"abab..."` holds one or two.
 */
export const MIN_JWT_SECRET_DISTINCT_CHARS = 8;

/**
 * Placeholder values this repository's example configuration and documentation
 * have published, compared after trimming, unquoting and lower-casing. A value
 * a reader can copy from the README or `.env.example` is public. Kept after
 * `.env.example` stopped shipping one: a deployment set up from an older copy
 * may still be running with it.
 */
export const KNOWN_PLACEHOLDER_JWT_SECRETS: readonly string[] = [
  "your-super-secret-jwt-key-change-in-production",
  "your-secret-key",
];

/**
 * Phrases no generated secret contains and every "fill me in" value does. A
 * base64 or hex secret contains none of them (a hyphen is outside both
 * alphabets), so flagging a secret that contains one flags only a value a
 * person typed as a reminder to change it.
 */
const PLACEHOLDER_PHRASES: readonly string[] = [
  "change-in-production",
  "change-me",
  "changeme",
  "change_me",
  "replace-me",
  "replaceme",
  "your-super-secret",
  "your-secret",
];

function normalize(secret: string): string {
  return secret
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .toLowerCase();
}

/** True when the whole secret is one shorter unit repeated. */
function isRepeatedUnit(secret: string): boolean {
  for (let unit = 1; unit <= secret.length / 2; unit++) {
    if (secret.length % unit !== 0) continue;
    const head = secret.slice(0, unit);
    // Compared in constant time because the right-hand side is the signing
    // secret itself (CWE-208). Byte lengths can differ for multi-byte input,
    // which timingSafeEqual refuses, and which also means "not a repeat".
    const candidate = Buffer.from(head.repeat(secret.length / unit));
    const actual = Buffer.from(secret);
    if (
      candidate.length === actual.length &&
      timingSafeEqual(candidate, actual)
    ) {
      return true;
    }
  }
  return false;
}

/** Why a long-enough secret is still weak. A reason code, never the value. */
export type JwtSecretWeakness = "placeholder" | "predictable";

export type JwtSecretAssessment =
  | { severity: "fatal"; reason: "missing" | "short"; message: string }
  | { severity: "weak"; reason: JwtSecretWeakness; message: string };

/**
 * What is wrong with this `JWT_SECRET`, or `null` when nothing is.
 *
 * A value has at most one assessment: a fatal problem is reported as fatal
 * even when the value is also a placeholder, because the fix (set a real
 * secret) is the same and only the fatal one stops the boot.
 *
 * Length is measured on the value as given, untrimmed, so an existing
 * deployment whose secret carries surrounding whitespace is judged the same
 * way by every caller. The message is an operator's log line; it never
 * contains the secret or any part of it.
 */
export function assessJwtSecret(
  secret: string | undefined | null,
): JwtSecretAssessment | null {
  const value = secret ?? "";
  if (value.length === 0) {
    return {
      severity: "fatal",
      reason: "missing",
      message: "JWT_SECRET is not set.",
    };
  }
  if (value.length < MIN_JWT_SECRET_LENGTH) {
    return {
      severity: "fatal",
      reason: "short",
      message: `JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters.`,
    };
  }
  const normalized = normalize(value);
  if (
    KNOWN_PLACEHOLDER_JWT_SECRETS.includes(normalized) ||
    PLACEHOLDER_PHRASES.some((phrase) => normalized.includes(phrase))
  ) {
    return {
      severity: "weak",
      reason: "placeholder",
      message:
        "JWT_SECRET is still an example placeholder. It is published in this " +
        "repository, so anyone can sign a session token with it.",
    };
  }
  if (
    new Set(value).size < MIN_JWT_SECRET_DISTINCT_CHARS ||
    isRepeatedUnit(value)
  ) {
    return {
      severity: "weak",
      reason: "predictable",
      message:
        "JWT_SECRET is too predictable: it is built from too few distinct " +
        "characters or repeats one short pattern, so it can be guessed.",
    };
  }
  return null;
}

/**
 * Why the server must refuse to start with this `JWT_SECRET`, or `null` when
 * it may start. Only a missing or short secret; a weak one boots and is
 * reported by `jwtSecretWeakness`.
 */
export function jwtSecretFatalProblem(
  secret: string | undefined | null,
): string | null {
  const assessment = assessJwtSecret(secret);
  return assessment?.severity === "fatal" ? assessment.message : null;
}

/**
 * Why a `JWT_SECRET` the server starts with is still unsafe, or `null` when it
 * is not. `null` for a fatal value too: that one never gets as far as serving.
 */
export function jwtSecretWeakness(
  secret: string | undefined | null,
): { reason: JwtSecretWeakness; message: string } | null {
  const assessment = assessJwtSecret(secret);
  return assessment?.severity === "weak"
    ? { reason: assessment.reason, message: assessment.message }
    : null;
}

/**
 * Where the full explanation of changing `JWT_SECRET` lives. Named in the boot
 * warning, the system alert and the banner so all three send the reader to
 * the same place.
 */
export const JWT_SECRET_ROTATION_DOC =
  "docs/backend/modules-and-runtime.md (Changing JWT_SECRET)";

/**
 * The boot warning for a weak secret, one log line per entry (the Nest log
 * prefix lands only on the first line of a multi-line message, as
 * `logEncryptionKeyStatus` explains). The remedy and the cost of the remedy
 * travel together: an operator told only "change it" would stop every
 * user's authenticator codes working without knowing how they get back in.
 */
export function jwtSecretWeaknessWarningLines(weakness: {
  message: string;
}): readonly string[] {
  return [
    `${weakness.message} The server is starting anyway; replace it.`,
    'Generate a strong secret with "openssl rand -base64 32" and set ' +
      "JWT_SECRET to it, then restart.",
    "Changing JWT_SECRET invalidates everything signed or encrypted under " +
      "it: access tokens (the web app refreshes them, so signed-in users stay " +
      "signed in), CSRF tokens, trusted-device and OAuth provider cookies, " +
      "sign-ins and step-up confirmations in progress, restore upload " +
      "tickets, pending AI and MCP confirmations, and every user's two-factor " +
      "(TOTP) secret, so authenticator codes stop working. Backup codes keep " +
      "working.",
    "After changing it, users with 2FA sign in with a backup code and set " +
      "2FA up again (Settings > Security: disable, then enable). For anyone " +
      "without a backup code, and for everyone when FORCE_2FA is on (which " +
      "forbids disabling), an administrator uses Admin > User Management > " +
      `Reset 2FA. Full procedure, including the SQL fallback: ${JWT_SECRET_ROTATION_DOC}.`,
  ];
}

/**
 * Say at startup whether this deployment's `JWT_SECRET` is weak. Silent for a
 * sound secret; a fatal one never reaches here (`checkClusterBoot` exits
 * first). The same shape as `logEncryptionKeyStatus`, called beside it from
 * `main.ts`.
 */
export function logJwtSecretStatus(
  secret: string | undefined | null,
  logger: { warn: (message: string) => void },
): void {
  const weakness = jwtSecretWeakness(secret);
  if (weakness === null) return;
  for (const line of jwtSecretWeaknessWarningLines(weakness)) {
    logger.warn(line);
  }
}
