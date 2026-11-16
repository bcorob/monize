import * as crypto from "crypto";
import { Transform } from "stream";
import {
  assertSupportedKdf,
  BackupDecryptionError,
  DATA_KEY_LENGTH,
  deriveKey,
  IV_LENGTH,
  KDF_SCRYPT,
  KEY_SALT_LENGTH,
  KEY_WRAPPED_HEADER_LENGTH,
  MAGIC,
  NONCE_PREFIX_LENGTH,
  SALT_LENGTH,
  TAG_LENGTH,
  VERSION_KEY_WRAPPED,
  WRAPPED_KEY_LENGTH,
} from "./backup-envelope";
import {
  createFramedEncryptStream,
  openFrames,
  readFrameBoundaries,
} from "./backup-stream-crypto";

/**
 * The key-wrapped (v3) encrypted-backup container.
 *
 * The automatic backup is written by a cron with nobody present, and must open
 * with the user's password. It used to meet both by storing the password
 * itself; this is what replaces that (docs/specs/backup-envelope-key-wrapping.md).
 * A user has a random data key. The server holds it under `ENCRYPTION_KEY` so
 * the cron can encrypt, and holds it wrapped under the password so every file
 * can carry that wrap in its header. Opening a file takes the password (unwrap,
 * then decrypt) or the data key itself -- never anything that decrypts to the
 * password.
 *
 * The frames are v2's (`backup-stream-crypto.ts`), sealed under a per-file key
 * `HKDF(dataKey, keySalt)`: one data key encrypts many files, and a per-file
 * key is what keeps two of them from ever sharing a GCM nonce.
 */

/** A data key and its password wrap, as the cron hands them to the writer. */
export interface WrappedBackupKey {
  dataKey: Buffer;
  /** salt || iv || tag || wrapped data key -- the v3 header's `wrappedKey`. */
  wrap: Buffer;
}

/**
 * What an export is encrypted with: a password typed for this export (v2), or
 * the stored key of an automatic backup (v3).
 */
export type BackupEncryptionInput = string | WrappedBackupKey;

const FILE_KEY_INFO = Buffer.from("monize-backup-v3-file-key", "ascii");

/** The first six header bytes, sealed into the wrap so it cannot change version or KDF. */
function wrapAad(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([VERSION_KEY_WRAPPED, KDF_SCRYPT])]);
}

function fileKey(dataKey: Buffer, keySalt: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", dataKey, keySalt, FILE_KEY_INFO, DATA_KEY_LENGTH),
  );
}

/**
 * A fresh random data key, wrapped under `password`. Fresh on every call by
 * design: a password change must not leave the old password able to open what
 * is written afterwards.
 */
export async function createWrappedBackupKey(
  password: string,
): Promise<WrappedBackupKey> {
  if (!password) {
    throw new Error("Backup encryption requires a non-empty password");
  }
  const dataKey = crypto.randomBytes(DATA_KEY_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const kek = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(wrapAad());
  const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    dataKey,
    wrap: Buffer.concat([salt, iv, cipher.getAuthTag(), wrapped]),
  };
}

/** The data key inside `wrap`, or a BackupDecryptionError for a wrong password. */
export async function unwrapBackupKey(
  wrap: Buffer,
  password: string,
): Promise<Buffer> {
  if (wrap.length !== WRAPPED_KEY_LENGTH) {
    throw new BackupDecryptionError(
      "Failed to decrypt backup: the wrapped key has the wrong length",
    );
  }
  let offset = 0;
  const salt = wrap.subarray(offset, (offset += SALT_LENGTH));
  const iv = wrap.subarray(offset, (offset += IV_LENGTH));
  const tag = wrap.subarray(offset, (offset += TAG_LENGTH));
  const wrapped = wrap.subarray(offset);
  const kek = await deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAAD(wrapAad());
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch {
    throw new BackupDecryptionError(
      "Failed to decrypt backup: the password is incorrect or the file is corrupt",
    );
  }
}

/** A Transform that turns plaintext into a v3 envelope under `key`. */
export function createKeyWrappedEncryptStream(
  key: WrappedBackupKey,
): Transform {
  if (key.dataKey.length !== DATA_KEY_LENGTH) {
    throw new Error("Backup data key has the wrong length");
  }
  if (key.wrap.length !== WRAPPED_KEY_LENGTH) {
    throw new Error("Backup key wrap has the wrong length");
  }
  const keySalt = crypto.randomBytes(KEY_SALT_LENGTH);
  const noncePrefix = crypto.randomBytes(NONCE_PREFIX_LENGTH);
  const header = Buffer.concat([wrapAad(), key.wrap, keySalt, noncePrefix]);
  return createFramedEncryptStream(
    fileKey(key.dataKey, keySalt),
    header,
    noncePrefix,
  );
}

/**
 * Opens a v3 envelope held in memory, with the password that wrapped its data
 * key or with the data key itself. Frame boundaries are checked before any key
 * is derived, as in v2.
 */
export async function decryptKeyWrappedBackup(
  envelope: Buffer,
  secret: { password: string } | { dataKey: Buffer },
): Promise<Buffer> {
  assertSupportedKdf(envelope);
  let offset = MAGIC.length + 2;
  const wrap = envelope.subarray(offset, (offset += WRAPPED_KEY_LENGTH));
  const keySalt = envelope.subarray(offset, (offset += KEY_SALT_LENGTH));
  const noncePrefix = envelope.subarray(offset, offset + NONCE_PREFIX_LENGTH);
  const header = envelope.subarray(0, KEY_WRAPPED_HEADER_LENGTH);
  const frames = readFrameBoundaries(envelope, KEY_WRAPPED_HEADER_LENGTH);

  const dataKey =
    "password" in secret
      ? await unwrapBackupKey(wrap, secret.password)
      : secret.dataKey;
  if (dataKey.length !== DATA_KEY_LENGTH) {
    throw new BackupDecryptionError(
      "Failed to decrypt backup: the data key has the wrong length",
    );
  }
  return openFrames(
    envelope,
    frames,
    fileKey(dataKey, keySalt),
    header,
    noncePrefix,
  );
}

/** SHA-256 of a bcrypt hash: which login password a wrap was made for. */
export function loginPasswordRef(passwordHash: string): string {
  return crypto.createHash("sha256").update(passwordHash).digest("hex");
}

/** Constant-time comparison of two `loginPasswordRef` values. */
export function sameLoginPasswordRef(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Decodes a base64 column that must hold exactly `length` bytes, asserting the
 * round trip: `Buffer.from(value, "base64")` silently drops characters outside
 * the alphabet, and a key decoded from a corrupted column must be refused, not
 * used.
 */
export function decodeKeyColumn(value: string, length: number): Buffer | null {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) {
    return null;
  }
  return bytes;
}
