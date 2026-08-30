import { Logger } from "@nestjs/common";
import { EncryptionService } from "../common/encryption/encryption.service";
import { User } from "../users/entities/user.entity";

/**
 * Resolves the password stored for a user's encrypted backups.
 *
 * Returns null when encryption is disabled or no password is stored -- three
 * outcomes collapse into two here on purpose: "nothing stored" and "stored but
 * undecryptable" are both "we have no usable password", and the caller decides
 * what that means. `BackupEncryptionService.resolveBackupPassword` is where the
 * third outcome (refuse rather than silently downgrade to plaintext) is decided.
 *
 * A free function rather than a method because two owners need it -- the
 * auto-backup cron through `BackupService`, and the restore's decrypt-candidate
 * list -- and neither should have to hold the other.
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
