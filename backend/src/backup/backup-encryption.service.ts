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
import { DATA_KEY_LENGTH, WRAPPED_KEY_LENGTH } from "./backup-envelope";
import {
  createWrappedBackupKey,
  decodeKeyColumn,
  loginPasswordRef,
  sameLoginPasswordRef,
  WrappedBackupKey,
} from "./backup-key-wrap";

const MIN_BACKUP_PASSWORD_LENGTH = 12;

/**
 * What Settings and the export screen are told about a user's backup
 * encryption. Mirrored by `BackupEncryptionStatus` in
 * `frontend/src/lib/backupApi.ts`.
 */
export interface BackupEncryptionStatus {
  /** A usable backup key is stored, so backups are written encrypted. */
  enabled: boolean;
  /** The dedicated backup-password controls belong to this user (OIDC only). */
  manageable: boolean;
  /** Which password opens this user's backups. */
  method: "login-password" | "backup-password";
  /** Whether this server holds key material to store a password at all. */
  available: boolean;
}

/**
 * What the automatic backup for a user should be encrypted with. Three answers,
 * not two: "no key stored" and "a key is stored that we cannot use" are
 * different situations and the caller has to treat them differently -- the
 * first is an ordinary unencrypted backup, the second is a misconfigured server
 * that must not quietly start writing plaintext where it used to write
 * ciphertext.
 */
export type BackupKeyResolution =
  | { status: "none" }
  | { status: "key"; key: WrappedBackupKey }
  | { status: "unrecoverable" };

/** Every column this feature owns, as a write that turns encryption off. */
export const CLEARED_BACKUP_KEY: Partial<User> = {
  backupEncryptionEnabled: false,
  backupPasswordEnc: null,
  backupKeyEnc: null,
  backupKeyWrap: null,
  backupKeyPasswordRef: null,
};

/**
 * Owns the key material the auto-backup cron encrypts each user's backups with
 * (docs/specs/backup-envelope-key-wrapping.md).
 *
 * A user with encrypted backups has a random data key. The server holds it
 * twice: under `ENCRYPTION_KEY` (`backup_key_enc`), so the cron can encrypt
 * with nobody present, and wrapped under the password that opens the user's
 * backups (`backup_key_wrap`), which every automatic backup carries in its
 * header so the file opens with that password alone. The server never stores
 * the password, nor anything that decrypts to it.
 *
 * For a local-auth account there is nothing to configure. The wrap is made
 * under the login password at the moments the server sees it in plaintext --
 * registration, login and password change (`rewrapBackupKey`) -- and is bound to
 * the password hash it was made for (`backup_key_password_ref`), so a password
 * changed by a path that did not re-wrap (a reset link, an admin, an emergency
 * claim) makes the wrap visibly stale rather than silently wrong. Settings also
 * offers local accounts `enableWithLoginPassword`, which asks them to confirm
 * the login password so a session older than the feature can turn it on without
 * signing out (issue #1269).
 *
 * An OIDC account has no password of ours, so those users set a dedicated
 * backup password in Settings (`setBackupPasswordForOidcUser`), or leave their
 * backups unencrypted. The dedicated-password methods refuse a local-auth
 * account rather than pretending -- a local user who "disabled" encryption would
 * have it back at their next login.
 *
 * `users.backup_password_enc` is the retired shape: a recoverable copy of the
 * password itself. Nothing writes it; each remaining row is converted to a
 * wrapped key, and the column cleared, at the next sign-in or the next
 * automatic backup (`resolveBackupKey`), whichever comes first.
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
        user.authProvider === "oidc" && !user.backupKeyPasswordRef
          ? "backup-password"
          : "login-password",
      available: this.encryption.isConfigured(),
    };
  }

  /**
   * Local accounts: wrap a backup key under the login password from Settings,
   * by asking the user to confirm the one they already have.
   *
   * The sign-in path is the primary one and this does not replace it. It exists
   * because that path only fires when somebody types their password, and a
   * session outlives the deploy that shipped the feature: a user signed in since
   * before it existed has no key and no way to get one without signing out
   * (issue #1269). The password is verified against the account's own hash
   * rather than trusted from the form, so this is not a way to encrypt a backup
   * under a string the user misremembered -- the file it produces opens with
   * their login password or the request is refused.
   *
   * The comparison runs inside the transaction that writes, against the hash it
   * read there, and the write is conditional on that hash still being the
   * account's. bcrypt and the wrap's scrypt cost about 200ms of a pooled
   * connection, which is the price of the check refusing against the state the
   * write lands on rather than against a snapshot a concurrent password change
   * has already replaced.
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
        throw this.loginPasswordIncorrect();
      }
      const key = await createWrappedBackupKey(loginPassword);
      const stored = await this.storeBackupKey(repo, userId, key, {
        passwordHash: user.passwordHash,
      });
      if (!stored) {
        // The password changed between the read and the write: the one just
        // verified is no longer the account's.
        throw this.loginPasswordIncorrect();
      }
    });
  }

  /**
   * OIDC accounts: set or replace the dedicated password their backups are
   * encrypted with. There is no login password of ours for these users, so this
   * is the only way their backups can be encrypted at all. The password itself
   * is not stored: a fresh data key is wrapped under it.
   */
  async setBackupPasswordForOidcUser(
    userId: string,
    newBackupPassword: string,
  ): Promise<void> {
    // Strength and breach checks first, deliberately outside the transaction
    // below: `isBreached` is an HTTPS round trip to the breach service, and
    // holding a pooled database connection across it would tie every settings
    // save to that service's latency. The wrap's scrypt is outside it for the
    // same reason.
    await this.validatePasswordStrength(newBackupPassword);
    this.requireEncryptionConfigured();
    const key = await createWrappedBackupKey(newBackupPassword);

    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      // Re-read inside the transaction the write runs in: the manageability
      // check has to hold against the state the write lands on.
      await this.requireManageableUser(repo, userId);
      this.requireEncryptionConfigured();
      await this.storeBackupKey(repo, userId, key, null);
    });
  }

  /** OIDC accounts: stop encrypting backups and drop the stored key. */
  async disableForOidcUser(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      await this.requireManageableUser(repo, userId);
      await repo.update({ id: userId }, CLEARED_BACKUP_KEY);
    });
  }

  /**
   * Wrap a fresh backup key under the local-auth password the user has just
   * proved they know, so the backup cron can encrypt without it. Called from
   * registration, login and the change-password flow -- the only points where
   * the plaintext exists -- with the hash the caller verified it against (or
   * just created from it).
   *
   * A login whose wrap was already made for that hash writes nothing: the key
   * is current, and skipping it keeps ~100ms of scrypt off every sign-in. It
   * re-wraps when the hash moved (a password changed by some other path), when
   * there is no key yet, or when the row still holds the retired recoverable
   * copy of the password, which the same write clears.
   *
   * The write is conditional on `password_hash` still being the verified hash,
   * so a concurrent password change cannot leave a wrap recorded against a hash
   * its password does not match: the update matches no row, and the next
   * sign-in re-wraps. The read beforehand is only the skip; the refusal that
   * matters is the `WHERE`.
   *
   * Best-effort by design: this is a side benefit of signing in, and a failure
   * here must never stop somebody signing in.
   */
  async rewrapBackupKey(
    userId: string,
    password: string,
    verifiedPasswordHash: string,
  ): Promise<void> {
    try {
      if (!password || !verifiedPasswordHash) return;
      if (!this.encryption.isConfigured()) {
        // Logged rather than swallowed because this returning quietly is the
        // exact shape of issue #1269: the capture stopped happening and every
        // surface still said "encrypted by default".
        this.logger.warn(
          `No encryption key available; backups for user ${userId} will be written unencrypted`,
        );
        return;
      }
      const user = await this.scoped(User, (repo) =>
        repo.findOne({ where: { id: userId } }),
      );
      if (!user || !user.passwordHash) return;
      // An SSO account is re-wrapped only when its existing wrap is under the
      // login password (ref set), so the wrap follows a password change. No
      // wrap, a legacy dedicated backupPasswordEnc or a dedicated wrap stay.
      if (user.authProvider === "oidc" && !user.backupKeyPasswordRef) return;
      if (this.wrapIsCurrentFor(user, verifiedPasswordHash)) return;

      const key = await createWrappedBackupKey(password);
      await withScopedDb(this.dataSource, (manager) =>
        this.storeBackupKey(manager.getRepository(User), userId, key, {
          passwordHash: verifiedPasswordHash,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to wrap the backup key for user ${userId}: ${err.message}`,
      );
    }
  }

  /**
   * The key this user's automatic backup should be encrypted with.
   *
   * A key wrapped under a login password is checked against the account's
   * current password hash before it is used. A password changed through a path
   * that did not re-wrap would otherwise produce a backup that opens only with a
   * password the user no longer knows -- a file that looks like a backup and
   * cannot be opened. A stale key is dropped here and re-made at the next login.
   *
   * A row that still holds the retired recoverable copy of the password is
   * converted here: the copy is checked against the account's hash exactly as
   * before, a fresh key is wrapped under it and stored, and the copy is cleared.
   * This is what converts OIDC accounts, whose dedicated password is never typed
   * at sign-in. The backup is encrypted under the new key whether or not that
   * write lands, so a not-yet-converted user never gets a plaintext backup they
   * would have had encrypted before.
   */
  async resolveBackupKey(user: User): Promise<BackupKeyResolution> {
    if (!user.backupEncryptionEnabled) return { status: "none" };

    if (user.backupKeyEnc && user.backupKeyWrap) {
      if (this.wrapMatchesCurrentPassword(user)) {
        const key = this.readStoredKey(user);
        if (!key) return { status: "unrecoverable" };
        if (user.backupPasswordEnc) await this.clearLegacyCopy(user);
        return { status: "key", key };
      }
      this.logger.warn(
        `Stored backup key for user ${user.id} was wrapped under a password that is no longer theirs; dropping it until their next sign-in`,
      );
      if (!user.backupPasswordEnc) {
        await this.dropBackupKey(user.id, {
          backupKeyWrap: user.backupKeyWrap,
        });
        return { status: "none" };
      }
      // A newer legacy copy (written by a previous release during a rolling
      // deploy) may still be good; the conversion below decides.
    }

    if (user.backupPasswordEnc) return this.convertLegacyCopy(user);
    return { status: "none" };
  }

  /** Drop the stored key, leaving backups unencrypted until it is re-made. */
  async forgetBackupKey(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      const user = await repo.findOne({ where: { id: userId } });
      if (!user) return;
      await repo.update({ id: userId }, CLEARED_BACKUP_KEY);
    });
  }

  /** Whether the stored wrap was made for this exact password hash, with nothing left to rewrite. */
  private wrapIsCurrentFor(user: User, passwordHash: string): boolean {
    return (
      user.backupEncryptionEnabled &&
      !!user.backupKeyEnc &&
      !!user.backupKeyWrap &&
      !user.backupPasswordEnc &&
      !!user.backupKeyPasswordRef &&
      sameLoginPasswordRef(
        user.backupKeyPasswordRef,
        loginPasswordRef(passwordHash),
      )
    );
  }

  /**
   * A wrap with no password ref is under an OIDC dedicated backup password and
   * has nothing to go stale against. One with a ref is under a login password,
   * and is usable only while that password's hash is still the account's.
   */
  private wrapMatchesCurrentPassword(user: User): boolean {
    if (!user.backupKeyPasswordRef) return true;
    if (!user.passwordHash) return false;
    return sameLoginPasswordRef(
      user.backupKeyPasswordRef,
      loginPasswordRef(user.passwordHash),
    );
  }

  /** The stored data key and wrap, or null when either cannot be read. */
  private readStoredKey(user: User): WrappedBackupKey | null {
    let dataKey: Buffer | null;
    try {
      dataKey = decodeKeyColumn(
        this.encryption.decrypt(user.backupKeyEnc ?? ""),
        DATA_KEY_LENGTH,
      );
    } catch (err) {
      // Typically ENCRYPTION_KEY was rotated. The user's other backups are
      // encrypted, so writing this one in plaintext instead would be a silent
      // downgrade: report it and let the caller refuse.
      this.logger.error(
        `Failed to decrypt stored backup key for user ${user.id}: ${err.message}`,
      );
      return null;
    }
    const wrap = decodeKeyColumn(user.backupKeyWrap ?? "", WRAPPED_KEY_LENGTH);
    if (!dataKey || !wrap) {
      this.logger.error(`Stored backup key for user ${user.id} is malformed`);
      return null;
    }
    return { dataKey, wrap };
  }

  /**
   * The lazy conversion of a row still holding the retired password copy. The
   * checks are the ones the cron always made on that copy; what changes is that
   * the password is used once, to wrap a key, and then forgotten.
   */
  private async convertLegacyCopy(user: User): Promise<BackupKeyResolution> {
    const legacy = user.backupPasswordEnc ?? "";
    let password: string;
    try {
      password = this.encryption.decrypt(legacy);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt stored backup password for user ${user.id}: ${err.message}`,
      );
      return { status: "unrecoverable" };
    }

    let boundTo: { passwordHash: string } | null = null;
    if (user.authProvider === "local" && user.passwordHash) {
      const current = await bcrypt.compare(password, user.passwordHash);
      if (!current) {
        this.logger.warn(
          `Stored backup password for user ${user.id} no longer matches their login password; dropping it until their next sign-in`,
        );
        await this.dropBackupKey(user.id, { backupPasswordEnc: legacy });
        return { status: "none" };
      }
      boundTo = { passwordHash: user.passwordHash };
    }

    const key = await createWrappedBackupKey(password);
    try {
      await withScopedDb(this.dataSource, (manager) =>
        this.storeBackupKey(
          manager.getRepository(User),
          user.id,
          key,
          boundTo,
          {
            backupPasswordEnc: legacy,
          },
        ),
      );
    } catch (err) {
      // The key is good for the password just verified, so this backup is still
      // encrypted under it; the next run tries the conversion again.
      this.logger.error(
        `Failed to convert the stored backup password for user ${user.id}: ${err.message}`,
      );
    }
    return { status: "key", key };
  }

  /** Clear a legacy copy left beside a current key, if it is still the one read. */
  private async clearLegacyCopy(user: User): Promise<void> {
    try {
      await withScopedDb(this.dataSource, (manager) =>
        manager
          .getRepository(User)
          .update(
            { id: user.id, backupPasswordEnc: user.backupPasswordEnc ?? "" },
            { backupPasswordEnc: null },
          ),
      );
    } catch (err) {
      this.logger.error(
        `Failed to clear the stored backup password for user ${user.id}: ${err.message}`,
      );
    }
  }

  /**
   * Turn encryption off for a user whose key went stale, conditional on the row
   * still holding the stale value that was judged: a concurrent sign-in that
   * has just written a fresh key must not be wiped by this.
   */
  private async dropBackupKey(
    userId: string,
    stale: { backupKeyWrap: string } | { backupPasswordEnc: string },
  ): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(User)
        .update({ id: userId, ...stale }, CLEARED_BACKUP_KEY),
    );
  }

  /**
   * Write only the columns this feature owns, and clear the retired password
   * copy in the same statement. Returns whether a row was written.
   *
   * Every method here used to read the `users` row in one transaction and then
   * `repo.save(user)` it in another. `save` on a loaded entity writes *every*
   * column from that snapshot, so any concurrent change to the row in between
   * was silently reverted -- and `users` is written on ordinary traffic
   * (`last_activity_at`), on failed logins (lockout counters) and by admin
   * actions (role, disabled, forced password change). A targeted `update` writes
   * nothing unrelated.
   *
   * `boundTo` is the login password hash the wrap was made for: the update
   * matches only while it is still the account's, and records its ref. `null`
   * is an OIDC dedicated password, which has no hash to go stale against.
   * `expected` narrows the match further, for the lazy conversion's compare-
   * and-set on the legacy copy it read.
   */
  private async storeBackupKey(
    repo: Repository<User>,
    userId: string,
    key: WrappedBackupKey,
    boundTo: { passwordHash: string } | null,
    expected: { backupPasswordEnc?: string } = {},
  ): Promise<boolean> {
    const result = await repo.update(
      {
        id: userId,
        ...(boundTo ? { passwordHash: boundTo.passwordHash } : {}),
        ...expected,
      },
      {
        backupKeyEnc: this.encryption.encrypt(key.dataKey.toString("base64")),
        backupKeyWrap: key.wrap.toString("base64"),
        backupKeyPasswordRef: boundTo
          ? loginPasswordRef(boundTo.passwordHash)
          : null,
        backupPasswordEnc: null,
        backupEncryptionEnabled: true,
      },
    );
    return (result.affected ?? 0) > 0;
  }

  private loginPasswordIncorrect(): UnauthorizedException {
    return new UnauthorizedException(
      tr(
        "errors.backup.loginPasswordIncorrect",
        "That is not your current login password",
      ),
    );
  }

  /**
   * The user, provided their backup encryption is theirs to manage. A
   * local-auth account is refused rather than half-obeyed: its key is re-made
   * under the login password at sign-in, so anything set or cleared here would
   * be overwritten by the next one.
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
   * Refuse rather than store a key this server cannot read back: a deployment
   * with no `ENCRYPTION_KEY` (or its former name `AI_ENCRYPTION_KEY`) boots with
   * a warning, and has nowhere to keep the key the cron needs. Here so the write
   * paths cannot drift into storing a value that `resolveBackupKey` would later
   * call unrecoverable.
   */
  private requireEncryptionConfigured(): void {
    if (!this.encryption.isConfigured()) {
      throw new BadRequestException(
        tr(
          "errors.backup.encryptionNotConfigured",
          "Server is not configured for encryption (ENCRYPTION_KEY missing or too short)",
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
