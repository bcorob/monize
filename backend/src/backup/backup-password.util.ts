import { Logger } from "@nestjs/common";
import { EncryptionService } from "../common/encryption/encryption.service";
import { User } from "../users/entities/user.entity";
import { DATA_KEY_LENGTH } from "./backup-envelope";
import { decodeKeyColumn } from "./backup-key-wrap";

/**
 * Resolves the legacy stored password for a user's encrypted backups -- the
 * copy `users.backup_password_enc` held before backups were encrypted under a
 * wrapped data key (docs/specs/backup-envelope-key-wrapping.md). It is cleared
 * as each row is converted, so this answers only for a user who has not signed
 * in or been backed up since.
 *
 * Returns null when encryption is disabled or no password is stored -- three
 * outcomes collapse into two here on purpose: "nothing stored" and "stored but
 * undecryptable" are both "we have no usable password", and the caller decides
 * what that means. `BackupEncryptionService.resolveBackupKey` is where the
 * third outcome (refuse rather than silently downgrade to plaintext) is decided.
 *
 * A free function rather than a method because two owners need it -- the
 * backup facade, and the restore's decrypt-candidate list -- and neither should
 * have to hold the other.
 */
export function resolveStoredBackupPassword(
  user: User,
  encryption: EncryptionService,
  logger: Logger,
): string | null {
  if (!user.backupEncryptionEnabled || !user.backupPasswordEnc) {
    return null;
  }
  try {
    return encryption.decrypt(user.backupPasswordEnc);
  } catch (err) {
    logger.error(
      `Failed to decrypt stored backup password for user ${user.id}: ${err.message}`,
    );
    return null;
  }
}

/**
 * The user's current backup data key, which opens the automatic backups
 * written since their last re-wrap without asking for a password. Null when
 * there is none or it cannot be read; the restore then falls back to asking.
 */
export function resolveStoredBackupDataKey(
  user: User,
  encryption: EncryptionService,
  logger: Logger,
): Buffer | null {
  if (!user.backupEncryptionEnabled || !user.backupKeyEnc) {
    return null;
  }
  try {
    const dataKey = decodeKeyColumn(
      encryption.decrypt(user.backupKeyEnc),
      DATA_KEY_LENGTH,
    );
    if (!dataKey) {
      logger.error(`Stored backup data key for user ${user.id} is malformed`);
    }
    return dataKey;
  } catch (err) {
    logger.error(
      `Failed to decrypt stored backup data key for user ${user.id}: ${err.message}`,
    );
    return null;
  }
}
