import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import * as bcrypt from "bcryptjs";
import { User } from "../users/entities/user.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { PasswordBreachService } from "../auth/password-breach.service";
import { tr } from "../i18n/translate";

const MIN_BACKUP_PASSWORD_LENGTH = 12;

/**
 * What the automatic backup for a user should be encrypted with. Three answers,
 * not two: "no password stored" and "a password is stored that we cannot use"
 * are different situations and the caller has to treat them differently -- the
 * first is an ordinary unencrypted backup, the second is a misconfigured server
 * that must not quietly start writing plaintext where it used to write
 * ciphertext.
 */
/**
 * What Settings and the export screen are told about a user's backup
 * encryption. Mirrored by `BackupEncryptionStatus` in
 * `frontend/src/lib/backupApi.ts`.
 */
export interface BackupEncryptionStatus {
  /** A usable password is stored, so backups are written encrypted. */
  enabled: boolean;
  /** The dedicated backup-password controls belong to this user (OIDC only). */
  manageable: boolean;
  /** Which password opens this user's backups. */
  method: "login-password" | "backup-password";
  /** Whether this server holds key material to store a password at all. */
  available: boolean;
}

export type BackupPasswordResolution =
  | { status: "none" }
  | { status: "password"; password: string }
  | { status: "unrecoverable" };

/**
 * Owns the stored copy of a user's backup password that the auto-backup cron
 * needs in order to encrypt what it writes.
 *
 * For a local-auth account there is nothing to configure. A backup is encrypted
 * with the password they already have, and the only moment the server ever sees
 * that password in plaintext is when they type it -- so it is captured there
 * (`rememberLoginPassword`, called on registration, login and password change)
 * rather than being a password they have to invent and remember separately.
 *
 * That capture is opportunistic, and opportunistic is not the same as reliable:
 * a user who was already signed in when the feature shipped never types their
 * password again, and their backups stay in plaintext for as long as their
 * session lives. So Settings offers local accounts one control --
 * `enableWithLoginPassword`, which asks them to confirm the login password they
 * already have and captures it on the spot (issue #1269). It is the same
 * password, so it neither invents a second secret nor conflicts with the next
 * sign-in.
 *
 * An OIDC account has no password of ours to capture, so nothing can be
 * automatic: those users set a dedicated backup password in Settings
 * (`setBackupPasswordForOidcUser`), or leave their backups unencrypted. The
 * dedicated-password methods refuse a local-auth account rather than pretending
 * -- a local user who "disabled" encryption would have it back at their next
 * login, because that is where the copy is captured.
 *
 * Storage shape: `users.backup_password_enc` holds the password ciphertext
 * written by `EncryptionService` under `ENCRYPTION_KEY`, and
 * `backup_encryption_enabled` records that a usable copy is there.
 */
@Injectable()
export class BackupEncryptionService {
  private readonly logger = new Logger(BackupEncryptionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly passwordBreach: PasswordBreachService,
  ) {}

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had. Multi-statement units use
   * an explicit `withScopedDb` block so their statements share one transaction.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  /**
   * What Settings and the export screen need to know about this user's backup
   * encryption: whether it is on, which password it uses, whether the server can
   * encrypt at all, and whether a dedicated password is theirs to manage.
   *
   * `enabled` alone was what the screen had, and "off" rendered as nothing at
   * all for a local account -- the state issue #1269 was reported from, where
   * the answer to "why are my backups not encrypted?" was not on the page in any
   * form. Every field here exists so that state can be shown and acted on:
   * `method` says which password would open the file, `available` distinguishes
   * "off" from "this server cannot", and `manageable` stays what it always was
   * -- whether the dedicated backup-password controls belong on the page.
   */
  async getStatus(userId: string): Promise<BackupEncryptionStatus> {
    const user = await this.requireUser(userId);
    return {
      enabled: user.backupEncryptionEnabled,
      manageable: user.authProvider === "oidc",
      method:
        user.authProvider === "oidc" ? "backup-password" : "login-password",
      available: this.encryption.isConfigured(),
    };
  }

  /**
   * Local accounts: capture the login password from Settings, by asking the user
   * to confirm the one they already have.
   *
   * The sign-in capture is the primary path and this does not replace it. It
   * exists because that path only fires when somebody types their password, and
   * a session outlives the deploy that shipped the feature: a user signed in
   * since before it existed has no stored copy and no way to get one without
   * signing out (issue #1269). The password is verified against the account's
   * own hash rather than trusted from the form, so this is not a way to encrypt
   * a backup under a string the user misremembered -- the file it produces opens
   * with their login password or the request is refused.
   *
   * The comparison runs inside the transaction that writes, against the hash it
   * read there. bcrypt costs about 100ms of a pooled connection, which is the
   * price of the check refusing against the state the write lands on rather than
   * against a snapshot a concurrent password change has already replaced.
   */
  async enableWithLoginPassword(
    userId: string,
    loginPassword: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      const user = await repo.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException(
          tr("errors.backup.userNotFoundRestore", "User not found"),
        );
      }
      if (user.authProvider !== "local" || !user.passwordHash) {
        throw new BadRequestException(
          tr(
            "errors.backup.backupPasswordLocalOnly",
            "This account has no login password to encrypt backups with; set a backup password instead",
          ),
        );
      }
      this.requireEncryptionConfigured();
      const matches = await bcrypt.compare(loginPassword, user.passwordHash);
      if (!matches) {
        throw new UnauthorizedException(
          tr(
            "errors.backup.loginPasswordIncorrect",
            "That is not your current login password",
          ),
        );
      }
      await this.storeBackupPassword(repo, userId, loginPassword);
    });
  }

  /**
   * OIDC accounts: set or replace the dedicated password their backups are
   * encrypted with. There is no login password of ours to capture for these
   * users, so this is the only way their backups can be encrypted at all.
   */
  async setBackupPasswordForOidcUser(
    userId: string,
    newBackupPassword: string,
  ): Promise<void> {
    // Strength and breach checks first, deliberately outside the transaction
    // below: `isBreached` is an HTTPS round trip to the breach service, and
    // holding a pooled database connection across it would tie every settings
    // save to that service's latency.
    await this.validatePasswordStrength(newBackupPassword);

    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      // Re-read inside the transaction the write runs in: the manageability
      // check has to hold against the state the write lands on.
      await this.requireManageableUser(repo, userId);
      this.requireEncryptionConfigured();
      await this.storeBackupPassword(repo, userId, newBackupPassword);
    });
  }

  /** OIDC accounts: stop encrypting backups and drop the stored password. */
  async disableForOidcUser(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      await this.requireManageableUser(repo, userId);
      await repo.update(
        { id: userId },
        { backupEncryptionEnabled: false, backupPasswordEnc: null },
      );
    });
  }

  /**
   * Store the local-auth password the user has just proved they know, so the
   * backup cron can encrypt with it. Called from registration, login and the
   * change-password flow -- those are the only points where the plaintext
   * exists, and re-storing it on every login is what keeps the copy current
   * after a reset that went through some other path.
   *
   * Best-effort by design: this is a side benefit of signing in, and a failure
   * here must never stop somebody signing in.
   */
  async rememberLoginPassword(userId: string, password: string): Promise<void> {
    try {
      if (!password) return;
      if (!this.encryption.isConfigured()) {
        // Unreachable on a booted server (`JWT_SECRET` is enforced at startup),
        // and logged rather than swallowed because this returning quietly is the
        // exact shape of issue #1269: the capture stopped happening and every
        // surface still said "encrypted by default".
        this.logger.warn(
          `No encryption key available; backups for user ${userId} will be written unencrypted`,
        );
        return;
      }
      await withScopedDb(this.dataSource, async (manager) => {
        const repo = manager.getRepository(User);
        const user = await repo.findOne({ where: { id: userId } });
        // OIDC accounts have no password of ours to remember.
        if (!user || user.authProvider !== "local") return;

        // Always re-encrypt and store, rather than reading the existing copy
        // back to see whether it changed. Comparing would mean decrypting a
        // secret and matching it against the one supplied, which is a timing
        // side channel (CWE-208) if done with `===` and an insecure password
        // hash if done with a digest; and it saves nothing, because every
        // caller -- login, registration, change-password -- already writes
        // this row anyway (`lastLogin`, the new hash). AES-GCM over one short
        // string is cheaper than the round trip the check would have avoided.
        //
        // The write is a targeted update in the same transaction as the read:
        // this runs during a password change, which is writing `password_hash`
        // on the same row, and a full-entity save from a snapshot read moments
        // earlier could put the old hash back.
        await this.storeBackupPassword(repo, userId, password);
      });
    } catch (err) {
      this.logger.error(
        `Failed to store the backup password for user ${userId}: ${err.message}`,
      );
    }
  }

  /**
   * The password this user's automatic backup should be encrypted with.
   *
   * A stored copy is checked against the account's current password hash before
   * it is used. A password changed through a path that could not update the
   * stored copy would otherwise produce a backup encrypted with a password the
   * user no longer knows -- a file that looks like a backup and cannot be
   * opened. A stale copy is dropped here and re-captured at the next login.
   */
  async resolveBackupPassword(user: User): Promise<BackupPasswordResolution> {
    if (!user.backupEncryptionEnabled || !user.backupPasswordEnc) {
      return { status: "none" };
    }

    let password: string;
    try {
      password = this.encryption.decrypt(user.backupPasswordEnc);
    } catch (err) {
      // Typically ENCRYPTION_KEY was rotated. The user's other backups are
      // encrypted, so writing this one in plaintext instead would be a silent
      // downgrade: report it and let the caller refuse.
      this.logger.error(
        `Failed to decrypt stored backup password for user ${user.id}: ${err.message}`,
      );
      return { status: "unrecoverable" };
    }

    if (user.authProvider === "local" && user.passwordHash) {
      const current = await bcrypt.compare(password, user.passwordHash);
      if (!current) {
        this.logger.warn(
          `Stored backup password for user ${user.id} no longer matches their login password; dropping it until their next sign-in`,
        );
        await this.forgetStoredPassword(user.id);
        return { status: "none" };
      }
    }

    return { status: "password", password };
  }

  /** Drop the stored copy, leaving backups unencrypted until it is recaptured. */
  async forgetStoredPassword(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      const user = await repo.findOne({ where: { id: userId } });
      if (!user) return;
      await repo.update(
        { id: userId },
        { backupEncryptionEnabled: false, backupPasswordEnc: null },
      );
    });
  }

  /**
   * Write only the two columns this feature owns.
   *
   * Every method here used to read the `users` row in one transaction and then
   * `repo.save(user)` it in another. `save` on a loaded entity writes *every*
   * column from that snapshot, so any concurrent change to the row in between
   * was silently reverted -- and `users` is written on ordinary traffic
   * (`last_activity_at`), on failed logins (lockout counters) and by admin
   * actions (role, disabled, forced password change). Turning on encrypted
   * backups could therefore undo an account being disabled, or reset a lockout
   * that was counting up.
   *
   * A targeted `update` inside the same transaction as the read fixes both
   * halves: nothing unrelated is written, and the checks that can refuse the
   * request run against the state the write lands on.
   */
  private async storeBackupPassword(
    repo: Repository<User>,
    userId: string,
    password: string,
  ): Promise<void> {
    await repo.update(
      { id: userId },
      {
        backupPasswordEnc: this.encryption.encrypt(password),
        backupEncryptionEnabled: true,
      },
    );
  }

  /**
   * The user, provided their backup encryption is theirs to manage. A
   * local-auth account is refused rather than half-obeyed: its password is
   * recaptured at every login, so anything set or cleared here would be
   * overwritten by the next sign-in.
   *
   * Takes the transaction's repository so the check and the write it guards
   * run against the same state -- a caller must invoke it inside the same
   * `withScopedDb` block that performs the mutation.
   */
  private async requireManageableUser(
    repo: Repository<User>,
    userId: string,
  ): Promise<User> {
    const user = await repo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(
        tr("errors.backup.userNotFoundRestore", "User not found"),
      );
    }
    if (user.authProvider !== "oidc") {
      throw new BadRequestException(
        tr(
          "errors.backup.backupPasswordOidcOnly",
          "Backup password is only configurable for OIDC users; local users use their login password",
        ),
      );
    }
    return user;
  }

  /**
   * Refuse rather than store a password this server cannot read back. Only
   * reachable on a server with no usable `JWT_SECRET`, which startup already
   * refuses to boot -- it is here so the two write paths cannot drift into
   * storing a value that `resolveBackupPassword` would later call unrecoverable.
   */
  private requireEncryptionConfigured(): void {
    if (!this.encryption.isConfigured()) {
      throw new BadRequestException(
        tr(
          "errors.backup.encryptionNotConfigured",
          "Server is not configured for encryption (JWT_SECRET missing or too short)",
        ),
      );
    }
  }

  private async validatePasswordStrength(password: string): Promise<void> {
    if (!password || password.length < MIN_BACKUP_PASSWORD_LENGTH) {
      throw new BadRequestException(
        tr(
          "errors.backup.backupPasswordTooShort",
          `Backup password must be at least ${MIN_BACKUP_PASSWORD_LENGTH} characters`,
          { minLength: MIN_BACKUP_PASSWORD_LENGTH },
        ),
      );
    }
    const breached = await this.passwordBreach.isBreached(password);
    if (breached) {
      throw new BadRequestException(
        tr(
          "errors.backup.backupPasswordBreached",
          "This password has been found in a data breach. Please choose a different password.",
        ),
      );
    }
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new NotFoundException(
        tr("errors.backup.userNotFoundRestore", "User not found"),
      );
    }
    return user;
  }
}
