import { Injectable, Logger } from "@nestjs/common";
import { EncryptionService } from "../common/encryption/encryption.service";
import { User } from "../users/entities/user.entity";
import { BackupExportService } from "./backup-export.service";
import { BackupRestoreService } from "./backup-restore.service";
import { resolveStoredBackupPassword } from "./backup-password.util";
import {
  BackupCompletenessReport,
  RestoreBackupInput,
  RestoreResult,
} from "./backup-format";
import { RESTORABLE_TABLES } from "./restore-plan";

export {
  BACKUP_VERSION,
  BackupCompletenessReport,
  BackupData,
  BackupPasswordRequiredError,
  RestoreBackupInput,
  RestoreResult,
} from "./backup-format";

/**
 * Re-exported from the restore plan, which derives it from the insertion order
 * so the allowlist and the order cannot disagree. Consumed by the coverage guard
 * test (backup-restore.integration.spec.ts), which asserts every live table is
 * either exported or in INTENTIONALLY_EXCLUDED_TABLES.
 */
export { RESTORABLE_TABLES };

/**
 * The backup module's front door.
 *
 * A facade, deliberately. Issue #1092 split the 2,600-line original into four
 * bounded components -- `BackupExportService`, `BackupRestoreService`,
 * `BackupAttachmentTransferService` and `BackupRestoreDatabaseService` -- and
 * this class is what keeps the controller, the auto-backup cron and the support
 * export from having to know which of them moved where. It holds no state and
 * makes no decisions: every method here is one delegation, so a behaviour
 * question is always answered in the component that owns it, never half here.
 *
 * The one exception is `resolveStoredBackupPassword`, which is a free function
 * (`backup-password.util.ts`) called from two places that must not depend on each
 * other -- the auto-backup cron through this facade, and the restore's
 * decrypt-candidate list.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly encryption: EncryptionService,
    private readonly exportService: BackupExportService,
    private readonly restoreService: BackupRestoreService,
  ) {}

  /** Ceiling on a restore's decompressed payload (see backup-limits.ts). */
  get restoreExpandedLimitBytes(): number {
    return this.restoreService.restoreExpandedLimitBytes;
  }

  /** Ceiling on the JSON a buffered export may accumulate. */
  get exportBufferLimitBytes(): number {
    return this.exportService.exportBufferLimitBytes;
  }

  /**
   * Resolves the password the auto-backup cron should use for encryption.
   * Returns null when encryption is disabled or no password is stored.
   */
  resolveStoredBackupPassword(user: User): string | null {
    return resolveStoredBackupPassword(user, this.encryption, this.logger);
  }

  /**
   * Produces the full backup file as a Buffer -- gzipped JSON, optionally
   * encrypted -- alongside a report of whether every attachment's bytes made it
   * in. Used by the auto-backup path, which must not promote or retain an
   * incomplete artifact as if it were complete.
   */
  exportToBuffer(
    userId: string,
    encryptionPassword?: string,
  ): Promise<{ buffer: Buffer; report: BackupCompletenessReport }> {
    return this.exportService.exportToBuffer(userId, encryptionPassword);
  }

  /** Streams a gzipped (or encrypted) backup to an express response. */
  streamExport(
    userId: string,
    res: import("express").Response,
    encryptionPassword?: string,
  ): Promise<void> {
    return this.exportService.streamExport(userId, res, encryptionPassword);
  }

  /**
   * Collects the full export as an in-memory map of table -> rows, using the
   * same queries as the streamed/gzipped export. Consumed by the support
   * (de-identified) backup.
   */
  collectRawExport(
    userId: string,
    options: { skipTables?: ReadonlySet<string> } = {},
  ): Promise<{
    version: number;
    exportedAt: string;
    tables: Record<string, Record<string, unknown>[]>;
  }> {
    return this.exportService.collectRawExport(userId, options);
  }

  /**
   * The set of tables the export writes (and the restore repopulates). Exposed
   * so the coverage guard test can assert every database table is either backed
   * up or explicitly excluded.
   */
  getBackedUpTableNames(): string[] {
    return this.exportService.getBackedUpTableNames();
  }

  /** The tables deliberately omitted from backups, exposed for the guard test. */
  getIntentionallyExcludedTableNames(): string[] {
    return this.exportService.getIntentionallyExcludedTableNames();
  }

  /** Replaces every scrap of this user's data with the uploaded artifact's. */
  restoreData(
    userId: string,
    input: RestoreBackupInput,
  ): Promise<RestoreResult> {
    return this.restoreService.restoreData(userId, input);
  }
}
