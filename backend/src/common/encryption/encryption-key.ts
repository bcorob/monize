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
 * than used, so "misconfigured" and "unset" reach the startup check as the same
 * refusal instead of one of them booting a server that cannot decrypt anything
 * it writes.
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
 * What an operator is told, line by line, when neither name supplies a usable key.
 *
 * One array rather than one multi-line string because every line in this
 * application's log carries the `[Nest] pid - date LEVEL [Context]` prefix, and
 * a message with embedded newlines only gets it on the first one. Exported so
 * the startup path and the test that pins it read the same words.
 *
 * The wording is doing a job. `ENCRYPTION_KEY` is not required *yet* -- this
 * release still starts without it, because refusing to boot would turn an
 * upgrade into an outage for every deployment that never set the variable under
 * its old name. But that is exactly the state issue #1269 was reported from, so
 * a quiet log line is not enough: the operator has to learn that their backups
 * are going out unencrypted today, and that a future release will refuse to
 * start.
 */
export const MISSING_ENCRYPTION_KEY_WARNING_LINES: readonly string[] = [
  `${ENCRYPTION_KEY_ENV} is not set. THIS WILL BECOME A HARD REQUIREMENT IN A ` +
    "FUTURE RELEASE, and the server will then refuse to start without it.",
  "Until it is set, this deployment cannot store any secret it is asked to " +
    "keep: automatic backups are written UNENCRYPTED, AI provider API keys " +
    "cannot be saved, and emergency access cannot be enabled.",
  `Fix it now: generate a key with "openssl rand -hex 32" and set ` +
    `${ENCRYPTION_KEY_ENV} (minimum ${MIN_ENCRYPTION_KEY_LENGTH} characters). ` +
    "Nothing else changes, and existing data is unaffected.",
  `Keep the value stable once set -- changing it re-encrypts nothing, it makes ` +
    "every stored secret unreadable. Back it up with your other deployment " +
    `secrets. (${LEGACY_ENCRYPTION_KEY_ENV} is the former name of this ` +
    "variable and is still accepted.)",
];

/**
 * Say, at startup, which of the three configuration states this deployment is
 * in: keyed by the current name (silent), keyed by the deprecated one (a rename
 * notice), or unkeyed (the deprecation warning above).
 *
 * Deliberately not a refusal. The requirement is announced in this release and
 * enforced in a later one, so a deployment that has been running for a year
 * without the variable takes the upgrade, keeps serving, and gets told -- on
 * every boot -- what it is losing and what to do. When the enforcement lands,
 * turn the unkeyed branch into a throw; every caller and test is already shaped
 * for it.
 *
 * A rename nobody is told about is a rename that never happens, which is why
 * the legacy branch warns rather than staying quiet: the old name keeps working
 * forever if the only place it is mentioned is a changelog.
 */
export function logEncryptionKeyStatus(read: EnvReader, logger: Logger): void {
  const resolved = resolveEncryptionKey(read);

  if (!resolved) {
    for (const line of MISSING_ENCRYPTION_KEY_WARNING_LINES) {
      logger.warn(line);
    }
    return;
  }

  if (resolved.source === LEGACY_ENCRYPTION_KEY_ENV) {
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
 * The error a write path raises when it is asked to encrypt on a deployment
 * that has no key. Not a startup message: the server starts, and only the
 * operations that genuinely need a key fail, each saying why.
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
