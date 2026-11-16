import * as crypto from "crypto";
import {
  assertSupportedKdf,
  BackupDecryptionError,
  backupEnvelopeVersion,
  deriveKey,
  IV_LENGTH,
  KDF_SCRYPT,
  MAGIC,
  SALT_LENGTH,
  TAG_LENGTH,
  VERSION_FRAMED,
  VERSION_KEY_WRAPPED,
  VERSION_MONOLITHIC,
} from "./backup-envelope";
import { decryptFramedBackup } from "./backup-stream-crypto";
import { decryptKeyWrappedBackup } from "./backup-key-wrap";

export { BackupDecryptionError };

/**
 * Whole-payload encryption, and the one door every backup decryption goes
 * through.
 *
 * The format itself -- every version of it -- is documented in
 * `backup-envelope.ts`. What lives here is the monolithic (v1) writer and a
 * reader that accepts every version, because an artifact produced before a
 * newer container existed must still open. Streamed exports under a typed
 * password write v2 through `createBackupEncryptStream`; the automatic backup
 * writes v3 through `createKeyWrappedEncryptStream`; the support export still
 * writes v1, deliberately, because it assembles its payload in memory anyway and
 * gains nothing from framing.
 */

/**
 * True if `buf` carries the Monize encrypted-backup magic header, in either
 * container version. Used so restore can tell whether the upload is a raw gzip
 * backup (legacy) or an encrypted envelope, without trying both code paths.
 */
export function isEncryptedBackup(buf: Buffer): boolean {
  return backupEnvelopeVersion(buf) !== null;
}

/**
 * Encrypt the gzipped-JSON payload under a password-derived AES-256-GCM key.
 * Returns the full v1 envelope: magic + version + kdf + salt + iv + tag + ct.
 */
export async function encryptBackup(
  payload: Buffer,
  password: string,
): Promise<Buffer> {
  if (!password) {
    throw new Error("Backup encryption requires a non-empty password");
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION_MONOLITHIC, KDF_SCRYPT]),
    salt,
    iv,
    authTag,
    ciphertext,
  ]);
}

/**
 * Decrypt a Monize encrypted-backup envelope, whichever container it uses. A
 * wrong password (or any tampering) surfaces as a BackupDecryptionError --
 * callers map this to a prompt-for-password response instead of a transaction
 * failure.
 */
export async function decryptBackup(
  envelope: Buffer,
  password: string,
): Promise<Buffer> {
  const version = backupEnvelopeVersion(envelope);
  if (version === null) {
    throw new BackupDecryptionError(
      "Backup file is not in the encrypted Monize format",
    );
  }
  if (version === VERSION_FRAMED) {
    return decryptFramedBackup(envelope, password);
  }
  if (version === VERSION_KEY_WRAPPED) {
    return decryptKeyWrappedBackup(envelope, { password });
  }

  assertSupportedKdf(envelope);

  let offset = MAGIC.length + 2;
  const salt = envelope.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = envelope.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = envelope.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const ciphertext = envelope.subarray(offset);

  const key = await deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth-tag mismatch -- almost always a wrong password.
    throw new BackupDecryptionError(
      "Failed to decrypt backup: the password is incorrect or the file is corrupt",
    );
  }
}

/**
 * Decrypt a key-wrapped (v3) envelope with the data key itself, which is what
 * the server holds for the automatic backups it wrote since the last re-wrap.
 * Any other version -- or a v3 file written under a different data key --
 * surfaces as a BackupDecryptionError, so a restore can move on to the next
 * candidate.
 */
export async function decryptBackupWithDataKey(
  envelope: Buffer,
  dataKey: Buffer,
): Promise<Buffer> {
  if (backupEnvelopeVersion(envelope) !== VERSION_KEY_WRAPPED) {
    throw new BackupDecryptionError(
      "Backup file is not encrypted under a stored data key",
    );
  }
  return decryptKeyWrappedBackup(envelope, { dataKey });
}
