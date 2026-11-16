import { Logger } from "@nestjs/common";

/** The variable this deployment is expected to set. */
export const ENCRYPTION_KEY_ENV = "ENCRYPTION_KEY";

/**
 * The name it used to have. Still read, and still the winner where both are
 * set, because the two name the same secret and an existing deployment must not
 * have to re-key anything to take an upgrade -- every column encrypted under it
 * (AI provider API keys, emergency-access grant credentials, the stored backup
 * password) is AES-GCM ciphertext that only that key opens.
 */
export const LEGACY_ENCRYPTION_KEY_ENV = "AI_ENCRYPTION_KEY";

/** Shortest secret either name may supply. */
export const MIN_ENCRYPTION_KEY_LENGTH = 32;

export interface ResolvedEncryptionKey {
  key: string;
  /** Which variable supplied it, so the deprecation can be named exactly once. */
  source: typeof ENCRYPTION_KEY_ENV | typeof LEGACY_ENCRYPTION_KEY_ENV;
}

/** Anything that can answer "what is this variable set to" -- `ConfigService`,
 *  `process.env`, or a test's plain object. */
export type EnvReader = (name: string) => string | undefined;

export function envReaderFromRecord(
  env: Record<string, string | undefined>,
): EnvReader {
  return (name) => env[name];
}

/**
 * The one place the encryption key is read.
 *
 * Two names, one secret, and a deliberate preference for the legacy one: a
 * deployment that sets both has ciphertext written under `AI_ENCRYPTION_KEY`,
 * and reading the new name first would open none of it. New deployments set
 * only `ENCRYPTION_KEY` and never meet the question.
 *
 * A value shorter than the floor is not a key. It is returned as absent rather
 * than used, so "misconfigured" and "unset" reach the boot check
 * (`checkClusterBoot`) as the same refusal.
 */
export function resolveEncryptionKey(
  read: EnvReader,
): ResolvedEncryptionKey | null {
  const legacy = read(LEGACY_ENCRYPTION_KEY_ENV) ?? "";
  if (legacy.length >= MIN_ENCRYPTION_KEY_LENGTH) {
    return { key: legacy, source: LEGACY_ENCRYPTION_KEY_ENV };
  }
  const current = read(ENCRYPTION_KEY_ENV) ?? "";
  if (current.length >= MIN_ENCRYPTION_KEY_LENGTH) {
    return { key: current, source: ENCRYPTION_KEY_ENV };
  }
  return null;
}

/**
 * The boot refusal for a missing or too-short key, as `checkClusterBoot`
 * reports it. The first sentence is the fix, because it is the line an
 * operator reads in a crash-looping container's log.
 *
 * The reassurance for an existing keyless deployment is a claim about the
 * code, checked when the key became required: every path that encrypts
 * refuses, or skips storing, when no key is configured
 * (`EncryptionService.requireKey`, and the `isConfigured()` gates in the AI,
 * emergency-access, backup, payee-lookup, Web Push and OIDC signing-key
 * services), so a deployment that never had a key holds no ciphertext a new
 * key would fail to open. What it does hold is plaintext automatic backups,
 * which stay readable, and local accounts with no backup key yet, which get
 * one at their next sign-in.
 */
export function missingEncryptionKeyRefusal(): string {
  return (
    `${ENCRYPTION_KEY_ENV} is not set (or is shorter than ` +
    `${MIN_ENCRYPTION_KEY_LENGTH} characters). Generate one with ` +
    `"openssl rand -hex 32", set ${ENCRYPTION_KEY_ENV} to it and restart. ` +
    "It encrypts every secret the server stores (AI provider keys, " +
    "emergency-access credentials, each user's backup key, the Web Push and " +
    "OIDC signing keys). A deployment that has been running without one can " +
    "set one safely: nothing was ever encrypted under a key it did not have. " +
    "Automatic backups already written stay unencrypted, and a local " +
    "account's backups are encrypted from that user's next sign-in. If this " +
    "deployment ran with a key before, restore that exact value instead: a " +
    "different one cannot read what the old one stored. " +
    `(${LEGACY_ENCRYPTION_KEY_ENV}, the former name, is still accepted.)`
  );
}

/**
 * Say, at startup, whether the key came from the deprecated name.
 *
 * A missing key never reaches here: `checkClusterBoot` refuses the boot
 * first. So there are two states left, keyed by the current name (silent) and
 * keyed by the deprecated one (a rename notice).
 *
 * A rename nobody is told about is a rename that never happens, which is why
 * the legacy branch warns rather than staying quiet: the old name keeps working
 * forever if the only place it is mentioned is a changelog.
 */
export function logEncryptionKeyStatus(read: EnvReader, logger: Logger): void {
  const resolved = resolveEncryptionKey(read);

  if (resolved?.source === LEGACY_ENCRYPTION_KEY_ENV) {
    logger.warn(
      `${LEGACY_ENCRYPTION_KEY_ENV} is deprecated and has been renamed to ` +
        `${ENCRYPTION_KEY_ENV} (it encrypts more than AI provider keys). It is ` +
        "still read and still takes precedence, so nothing has to change today; " +
        `to move over, set ${ENCRYPTION_KEY_ENV} to the same value and remove ` +
        `${LEGACY_ENCRYPTION_KEY_ENV} -- changing the value re-keys nothing and ` +
        "makes every stored secret unreadable.",
    );
  }
}

/**
 * The error a write path raises when it is asked to encrypt without a key.
 * Unreachable in a booted server, which refuses to start without one; kept for
 * the specs, scripts and future entry points that construct `EncryptionService`
 * outside that path.
 */
export function missingEncryptionKeyMessage(): string {
  return (
    `${ENCRYPTION_KEY_ENV} is not configured (minimum ` +
    `${MIN_ENCRYPTION_KEY_LENGTH} characters). It encrypts AI provider API ` +
    "keys, emergency-access credentials and the password your backups are " +
    "encrypted with, so a server without it stores none of them. Generate one " +
    `with "openssl rand -hex 32" and set ${ENCRYPTION_KEY_ENV} in your ` +
    `environment. (${LEGACY_ENCRYPTION_KEY_ENV}, the former name for this ` +
    "variable, is still accepted.)"
  );
}
