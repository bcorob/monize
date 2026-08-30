import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { gunzip } from "zlib";
import { promisify } from "util";
import { withScopedDb } from "../common/db/scoped-db";
import { withPreserveTimestamps } from "../common/db/with-context";
import { UserMaintenanceService } from "../common/jobs/user-maintenance.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { OidcReauthService } from "../auth/oidc/oidc-reauth.service";
import { User } from "../users/entities/user.entity";
import { tr } from "../i18n/translate";
import { gemConfigFingerprint } from "../strategies/gem-signal.service";
import { GemStrategy } from "../strategies/entities/gem-strategy.entity";
import { GemStrategyAsset } from "../strategies/entities/gem-strategy-asset.entity";
import { collectRowIdRemap, deepRemapIds } from "./backup-id-remap.util";
import {
  BackupDecryptionError,
  decryptBackup,
  isEncryptedBackup,
} from "./backup-crypto.util";
import { resolveRestoreExpandedLimitBytes } from "./backup-limits";
import { resolveStoredBackupPassword } from "./backup-password.util";
import { restoreProcessingGate } from "./restore-processing-gate";
import { RESTORE_PLAN } from "./restore-plan";
import {
  BACKUP_VERSION,
  BackupData,
  BackupPasswordRequiredError,
  backupTables,
  parseArtifactCompleteness,
  RestoreBackupInput,
  RestoreResult,
} from "./backup-format";
import { restoreAiProviderKey } from "./ai-provider-key-transport";
import { BackupAttachmentTransferService } from "./backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";

const gunzipAsync = promisify(gunzip);

/**
 * Restore orchestration: the processing gate, decryption, decompression, format
 * validation, re-authentication ordering, id remapping, and the single
 * transaction that the teardown, the inserts and the deferred-FK repair all run
 * inside.
 *
 * Split out of `BackupService` (issue #1092). The two collaborators it drives are
 * deliberately separate: `BackupAttachmentTransferService` owns everything
 * outside the transaction (object bytes, which do not roll back), and
 * `BackupRestoreDatabaseService` owns everything inside it. The ordering between
 * them is the whole safety argument, and it is stated once, here.
 */
@Injectable()
export class BackupRestoreService {
  private readonly logger = new Logger(BackupRestoreService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly oidcReauth: OidcReauthService,
    private readonly attachments: BackupAttachmentTransferService,
    private readonly db: BackupRestoreDatabaseService,
    private readonly maintenance: UserMaintenanceService,
  ) {}

  /**
   * Ceiling on a restore's decompressed payload (see backup-limits.ts).
   *
   * The **same** resolver `computeRestoreProcessingSlots` budgets against. It used
   * to be `resolveConfiguredBackupLimit`, which derives a quarter of the container
   * -- the same number the slot math derived, so the two agreed by coincidence.
   * Once the expanded ceiling became capacity-first (issue #1073) that coincidence
   * would have broken: the gate would admit one restore modeled at the new
   * ceiling while `gunzip` allowed the old one. A slot count that budgets against
   * a limit the parser does not enforce is F3R7-002 again.
   */
  get restoreExpandedLimitBytes(): number {
    return resolveRestoreExpandedLimitBytes(
      process.env.BACKUP_RESTORE_EXPANDED_LIMIT,
      undefined,
      (message) => this.logger.warn(message),
    );
  }

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

  async restoreData(
    userId: string,
    input: RestoreBackupInput,
  ): Promise<RestoreResult> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new NotFoundException(
        tr("errors.backup.userNotFoundRestore", "User not found"),
      );
    }

    // Two orderings had to be reconciled here, and both properties survive.
    //
    // #1060 moved file validation BEFORE the re-authentication: the OIDC artifact
    // is single-use and the round trip that mints it loses the user's file
    // selection, so consuming it and only then finding a wrong backup password
    // charged a full identity-provider round trip for a mistake that has nothing
    // to do with identity -- and the honest failure then looks like a spent
    // artifact on the retry.
    //
    // The audit-03 work put the whole of it inside the processing gate: the peak
    // is dominated by the *expanded* payload, which a small compressed upload
    // reaches just as easily as a large one, so upload admission cannot bound it.
    // The gate caps how many restores decompress at once (one, on the default pod)
    // and refuses with a 503 when the model leaves no room for even one
    // (F3RB-005), rather than letting the request walk into an OOM kill.
    //
    // Keeping the gate outside and #1060's ordering inside satisfies both: nothing
    // decompresses unbudgeted, and no artifact is spent on a file that was never
    // going to restore.
    return restoreProcessingGate.run(
      async () => {
        // Everything below holds a slot, so nothing below is cancellable: the
        // signal above bounds the wait for the slot and is not consulted again.
        const gzippedPayload = await this.maybeDecrypt(input, user);
        const rawData = await this.decompressAndParse(gzippedPayload);
        this.validateBackupFormat(rawData);

        await this.verifyAuthentication(user, input);

        // A support (de-identified) backup restores like any other, but the data
        // is synthetic -- masked names, amounts scaled by a hidden factor. Log it
        // so scaled balances aren't mistaken for corruption later.
        if ((rawData as { supportBackup?: unknown }).supportBackup === true) {
          this.logger.log(
            `Restoring a de-identified support backup for user ${userId} (names masked, amounts scaled)`,
          );
        }

        this.warnIfArtifactIncomplete(userId, rawData);

        // Remap every primary key in the backup to a fresh UUID (and rewrite all
        // references to those keys, including ids embedded in JSONB columns) so the
        // restore behaves as if the backup came from an entirely separate system.
        // Without this, restoring one user's backup into another user's account on
        // the SAME system would collide on the original UUIDs: the inserts would be
        // silently skipped by ON CONFLICT DO NOTHING, and the Phase-3 deferred-FK
        // UPDATEs (keyed only by id) would mutate the OTHER user's rows.
        const idRemap = this.buildBackupIdRemap(rawData);
        const data = this.remapBackupIds(rawData, idRemap);
        this.rehashGemSignalFingerprints(data, idRemap);

        this.logger.log(`Starting backup restore for user ${userId}`);

        // Attachment bytes are staged before anything is deleted: an object that is
        // missing or fails its checksum has to be discovered while the user's
        // current data is still there, not halfway through replacing it.
        const {
          stagedKeys,
          sourceKeys,
          skipped: skippedAttachments,
        } = await this.attachments.stageAttachmentObjects(
          userId,
          data,
          idRemap,
        );

        // Everything between staging and the restore transaction runs after
        // objects have been written to the store but before the transaction's
        // `.catch` (below) is wired to discard them. A throw here would therefore
        // orphan every staged object: the failure never reaches the handler that
        // cleans them up. So this region discards the staged objects itself before
        // re-raising. The cleanup swallows its own delete failures, so it cannot
        // mask the error that actually aborted the restore.
        let displacedKeys: string[];
        let unusableAiProviderKeys: number;
        try {
          // The keys this user's *current* attachments occupy, read before the
          // delete because afterwards there is nothing left to read them from.
          // They are deleted after a successful commit -- see
          // `deleteDisplacedAttachmentObjects` for why that is the only safe
          // moment and why the backup's own old keys are not in this set.
          displacedKeys =
            await this.attachments.collectExternalAttachmentKeys(userId);

          // Re-encrypt every AI provider key the artifact carries in plaintext
          // under *this* instance's ENCRYPTION_KEY, before the transaction: the
          // work is scrypt-bound (tens of milliseconds per key) and does not
          // belong inside the transaction that holds every one of this user's
          // rows. Rows an older artifact carries as foreign ciphertext are left
          // alone and counted, which is the pre-transport behaviour and the only
          // case still reportable.
          unusableAiProviderKeys = this.restoreAiProviderKeys(userId, data);
        } catch (error) {
          await this.attachments.discardStagedAttachmentObjects(stagedKeys);
          throw error;
        }

        const restored: Record<string, number> = {};

        // One transaction for the whole restore, exactly as the QueryRunner block
        // was: a half-applied restore would leave the account in a state that is
        // neither the backup nor what was there before. `preserveTimestamps` makes
        // withScopedDb emit `app.preserve_timestamps` for this transaction (in
        // every RLS mode), so the GUC-aware `updated_at` trigger keeps the backup's
        // timestamps through the Phase-3 deferred-FK UPDATEs -- replacing the old
        // trigger-disabling ALTER TABLE DDL, which the unprivileged runtime role
        // cannot execute under enforcement (task C5).
        // The delete-and-reinsert runs under this user's maintenance lease, taken
        // only now -- after authentication, before the first delete. A concurrent
        // restore, delete-my-data, or `.mny` import already replacing this
        // account's data makes the lease refuse with a 409, and because the refusal
        // precedes `fn`, nothing here has run: no row deleted, the account left
        // exactly as the other operation will leave it (audit DR-04-02). Staged
        // attachment bytes are discarded by the `.catch` below, since they were
        // written before the lease and this request no longer owns the restore.
        // One thing has happened by here, though: the OIDC step-up proof was
        // already spent in its own committed transaction during
        // verifyAuthentication above, so a 409 (or any later throw) leaves it
        // consumed and the user must re-authenticate to retry. That is the safe
        // direction -- do not "fix" this path by treating it as replay-safe.
        return this.maintenance
          .withMaintenanceLease(userId, "backup restore", () =>
            withPreserveTimestamps(() =>
              withScopedDb(this.dataSource, async (manager) => {
                // Phase 1: Delete all existing user data (same order as deleteData in users.service)
                await this.db.deleteAllUserData(userId, manager);

                // Phase 2a: ensure every referenced currency code exists before
                // restoring the tables with FK references to currencies(code).
                await this.db.ensureCurrenciesExist(manager, data, userId);

                // Phase 2b: insert every backed-up table in FK-safe order. The order,
                // the row-count key and whether user_id is forced live in
                // RESTORE_PLAN, which restore-plan.spec.ts checks against the schema's
                // foreign keys -- so a new table or a new FK cannot quietly land in the
                // wrong position.
                for (const { table, countKey, scopeToUser } of RESTORE_PLAN) {
                  // monthly_account_balances is a derived cache, not authoritative
                  // data. Trusting the backup's rows re-imports whatever
                  // calculation semantics produced them -- so a backup taken
                  // before the #1242 fix would restore its wrong investment
                  // market_value even on a fixed instance, and migration 164 (a
                  // one-time delete) cannot catch a backup restored after it ran
                  // (review MZ-1242-R3). Skip the insert and let
                  // NetWorthService.ensurePopulated rebuild every account from the
                  // restored source transactions and prices on the next net-worth
                  // read (count === 0 -> full recalculateAllAccounts).
                  if (table === "monthly_account_balances") {
                    restored[countKey] = 0;
                    continue;
                  }
                  restored[countKey] = await this.db.insertRows(
                    manager,
                    table,
                    backupTables(data)[table],
                    scopeToUser ? userId : null,
                  );
                }

                // Phase 3: Restore deferred FK columns that were stripped during insert
                // to avoid circular/forward reference violations.
                await this.db.restoreDeferredFkColumns(manager, data);

                this.logger.log(`Backup restore completed for user ${userId}`);
                // `skippedAttachments` and `unusableAiProviderKeys` are reported
                // beside `restored`, never inside it: the client sums `restored`'s
                // values to show a row total, and neither a count of rows that were
                // deliberately not written nor a count of rows whose contents did not
                // survive belongs in that sum. Both are omitted at zero so "no field"
                // and "nothing to report" are the same answer.
                return {
                  message: "Backup restored successfully",
                  restored,
                  ...(skippedAttachments > 0 ? { skippedAttachments } : {}),
                  ...(unusableAiProviderKeys > 0
                    ? { unusableAiProviderKeys }
                    : {}),
                };
              }),
            ),
          )
          .then(async (result) => {
            // After the commit, never before: until it lands, the metadata that
            // references these objects may come back with a rollback.
            await this.attachments.deleteDisplacedAttachmentObjects(
              displacedKeys,
              [...stagedKeys, ...sourceKeys],
            );
            return result;
          })
          .catch(async (error) => {
            this.logger.error(
              `Backup restore failed for user ${userId}: ${error.message}`,
            );
            // The database rolled back; the objects staged for it did not, so remove
            // them rather than leaving bytes nothing references. The user's own old
            // objects stay exactly where they are -- their metadata rolled back with
            // everything else, so those bytes are still referenced.
            await this.attachments.discardStagedAttachmentObjects(stagedKeys);
            throw error;
          });
      },
      { signal: input.queueAbortSignal },
    );
  }

  /**
   * If the upload is encrypted, decrypt it using (in order of preference):
   * 1) the explicit backupPassword the frontend sent for this restore,
   * 2) the user's auth password (most backups encrypt with this),
   * 3) the user's currently stored backup password.
   *
   * Returns the inner gzipped JSON payload, or the input unchanged if it's
   * not encrypted. Throws BackupPasswordRequiredError when we know it's
   * encrypted but every available password failed -- the frontend uses that
   * to prompt the user for the password the backup was made with.
   */
  private async maybeDecrypt(
    input: RestoreBackupInput,
    user: User,
  ): Promise<Buffer> {
    if (!isEncryptedBackup(input.compressedData)) {
      return input.compressedData;
    }

    const candidates: string[] = [];
    if (input.backupPassword) candidates.push(input.backupPassword);
    if (input.password) candidates.push(input.password);
    const stored = resolveStoredBackupPassword(
      user,
      this.encryption,
      this.logger,
    );
    if (stored) candidates.push(stored);

    for (const pw of candidates) {
      try {
        return await decryptBackup(input.compressedData, pw);
      } catch (err) {
        if (!(err instanceof BackupDecryptionError)) throw err;
        // try next candidate
      }
    }

    throw new BackupPasswordRequiredError(
      input.backupPassword
        ? tr(
            "errors.backup.backupPasswordWrong",
            "The password you entered cannot decrypt this backup. Try the password that was set when the backup was created.",
          )
        : tr(
            "errors.backup.backupPasswordRequired",
            "This backup is encrypted. Provide the password that was used when the backup was created.",
          ),
    );
  }

  /**
   * Decompress and parse the uploaded backup, under a hard ceiling on the
   * decompressed size.
   *
   * Express caps the *compressed* body, which bounds nothing about what comes
   * out of gzip. `gunzipSync` with no `maxOutputLength` allocated whatever the
   * stream expanded to -- so a few hundred kilobytes of repeated text became
   * gigabytes of buffer, allocated before the version check, the format check,
   * or anything else that could refuse the request. `maxOutputLength` makes zlib
   * stop and raise instead of allocating past the limit.
   *
   * Asynchronous for the second half of the same problem: `gunzipSync` inflated
   * on the event loop, so a large payload froze every other request in the
   * process for the duration. The async form runs on the libuv threadpool. The
   * `JSON.parse` below still blocks, unavoidably -- a JSON document has to be
   * whole to be parsed -- but it now blocks on a string of bounded length.
   */
  private async decompressAndParse(
    compressedData: Buffer,
  ): Promise<BackupData> {
    let json: string;
    try {
      const decompressed = await gunzipAsync(compressedData, {
        maxOutputLength: this.restoreExpandedLimitBytes,
      });
      json = decompressed.toString("utf-8");
    } catch (error) {
      // zlib reports the ceiling as ERR_BUFFER_TOO_LARGE / RangeError. Say so:
      // "not valid gzip" would send the user looking for a corrupt file.
      if (
        error instanceof RangeError ||
        (error as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE"
      ) {
        this.logger.warn(
          `Rejected a backup restore whose decompressed size exceeded ${this.restoreExpandedLimitBytes} bytes`,
        );
        throw new BadRequestException(
          tr(
            "errors.backup.decompressTooLarge",
            `Backup is too large to restore: it expands past this deployment's limit of ${this.restoreExpandedLimitBytes} bytes. That ceiling is derived from the container's memory and a measured cost per byte, so raising it alone models a restore the process cannot finish -- raise the container memory limit instead (Kubernetes: backend.resources.limits.memory).`,
            { limit: this.restoreExpandedLimitBytes },
          ),
        );
      }
      throw new BadRequestException(
        tr(
          "errors.backup.decompressFailed",
          "Failed to decompress backup file. Ensure the file is gzip-compressed.",
        ),
      );
    }

    try {
      return JSON.parse(json) as BackupData;
    } catch {
      throw new BadRequestException(
        tr(
          "errors.backup.invalidJsonBackup",
          "Invalid backup file: decompressed content is not valid JSON",
        ),
      );
    }
  }

  private async verifyAuthentication(
    user: User,
    input: RestoreBackupInput,
  ): Promise<void> {
    if (user.authProvider === "oidc") {
      // A signed, action-bound, one-time artifact minted by the OIDC callback
      // after a prompt=login round trip. This used to accept any non-empty
      // string -- the client sent the literal "oidc-session-confirmed" -- so the
      // second proof for the single most destructive action in the product was
      // possession of the session that was already required (P2-005). Bound to
      // "restore-backup" specifically: an artifact minted to delete data must not
      // authorize overwriting everything instead.
      await this.oidcReauth.consume(
        user.id,
        "restore-backup",
        input.oidcIdToken,
      );
    } else if (!user.passwordHash) {
      // Local account with no password (admin-provisioned, reset not completed).
      // This fell off the end of the else-if chain and proved nothing at all.
      throw new UnauthorizedException(
        tr(
          "errors.backup.reauthUnavailable",
          "Finish setting up your account password before restoring a backup.",
        ),
      );
    } else {
      if (!input.password) {
        throw new UnauthorizedException(
          tr(
            "errors.backup.passwordRequiredForRestore",
            "Password is required to confirm restore",
          ),
        );
      }
      const isValid = await bcrypt.compare(input.password, user.passwordHash);
      if (!isValid) {
        throw new UnauthorizedException(
          tr("errors.backup.invalidPassword", "Invalid password"),
        );
      }
    }
  }

  /**
   * Say so when the artifact itself declares it was never complete.
   *
   * The claim travels in the envelope precisely so it outlives the run that
   * produced it: the settings row is on the instance the backup came from, and
   * the filename is gone the moment somebody renames or re-uploads the file. A
   * restore that silently replaces everything from an artifact known to be
   * missing attachment bytes is the outcome F3R7-001 exists to prevent, arrived
   * at from the other end.
   *
   * Not a refusal: restoring a partial artifact is often exactly what the user
   * means to do, and the alternative on offer is usually nothing. An artifact
   * that makes no claim (written before the field existed) is silent here --
   * absence is "not known", not "incomplete".
   */
  private warnIfArtifactIncomplete(userId: string, data: BackupData): void {
    const completeness = parseArtifactCompleteness(
      (data as { completeness?: unknown }).completeness,
    );
    if (completeness === null || completeness.complete) return;
    this.logger.warn(
      `Restoring an artifact its export recorded as incomplete for user ${userId}: ` +
        `${completeness.missingAttachments} attachment(s) had no bytes and ` +
        `${completeness.inconsistentAttachments} contradicted their metadata, of ` +
        `${completeness.expectedAttachments} total. Those attachments cannot come back ` +
        `from this file.`,
    );
  }

  /**
   * Re-key every AI provider row in the artifact, and report the ones that could
   * not be re-keyed.
   *
   * `ai-provider-key-transport.ts` owns the four outcomes; this counts the two
   * that leave the user without a working key, because those are what
   * `RestoreResult.unusableAiProviderKeys` is for -- the rows *are* restored, so
   * a silent success would leave provider entries that look configured and fail
   * on every call.
   *
   * The rows are replaced rather than mutated in place. The artifact has already
   * been copied once by `remapBackupIds`, so this is not about protecting the
   * caller's object; it is about the plaintext field never surviving into
   * anything the insert path can see.
   */
  private restoreAiProviderKeys(userId: string, data: BackupData): number {
    const tables = backupTables(data);
    const rows = tables.ai_provider_configs;
    if (!rows || rows.length === 0) return 0;

    let unusable = 0;
    tables.ai_provider_configs = rows.map((row) => {
      const result = restoreAiProviderKey(row, this.encryption);
      if (result.outcome === "dropped-unencryptable") {
        unusable += 1;
      } else if (
        result.outcome === "kept-foreign-ciphertext" &&
        !this.encryption.canDecrypt(result.row.api_key_enc as string)
      ) {
        // An older artifact, written before keys travelled in plaintext. It only
        // restores onto the instance that produced it; anywhere else the column
        // is populated and unreadable, which is exactly the failure this field
        // exists to stop being silent.
        unusable += 1;
      }
      return result.row;
    });

    if (unusable > 0) {
      this.logger.warn(
        `Restoring ${unusable} AI provider configuration(s) for user ${userId} without a ` +
          "usable API key: the artifact carried instance-key ciphertext this server " +
          "cannot read, or ENCRYPTION_KEY is unset here. The rows are restored; " +
          "the keys must be re-entered.",
      );
    }
    return unusable;
  }

  private validateBackupFormat(data: BackupData): void {
    if (!data || typeof data !== "object") {
      throw new BadRequestException(
        tr(
          "errors.backup.invalidBackupFormat",
          "Invalid backup format: data must be an object",
        ),
      );
    }
    if (data.version !== BACKUP_VERSION) {
      throw new BadRequestException(
        tr(
          "errors.backup.unsupportedBackupVersion",
          `Unsupported backup version: ${data.version}. Expected ${BACKUP_VERSION}`,
          { version: data.version, expected: BACKUP_VERSION },
        ),
      );
    }
    if (!data.exportedAt) {
      throw new BadRequestException(
        tr(
          "errors.backup.missingExportedAt",
          "Invalid backup format: missing exportedAt",
        ),
      );
    }
  }

  /**
   * Builds a map from every primary-key UUID in the backup to a freshly
   * generated UUID. Currencies are intentionally excluded: they are shared,
   * global rows keyed by `code` (not by a per-user UUID) and are referenced by
   * code, so they must keep their original identifiers. Non-UUID ids (e.g.
   * `security_prices.id` is BIGSERIAL) are also excluded -- they get a fresh
   * value assigned by the DB on insert (see insertRows), and remapping them
   * to UUIDs here would (a) corrupt them and (b) clobber unrelated bigint
   * values in other columns that happen to share the same string form.
   */
  /**
   * Re-hash each GEM signal's `config_fingerprint` onto the remapped security
   * ids.
   *
   * The fingerprint is a hash of the strategy's cadence, lookback and the
   * security assigned to every role -- so it contains ids, but as hashed
   * *material*, not as a value `deepRemapIds` can rewrite. A restore mints new
   * UUIDs for every security, and the stored hashes went on describing the old
   * ones. The report reads a mismatch as "the user changed the settings", so
   * the first read after a restore would recompute the whole history where it
   * could, and hide the periods it could not -- the user's own past decisions,
   * and the `executed` flags on them, gone or rewritten by an import that
   * changed nothing they can see.
   *
   * The relation is translated, not overwritten. Only signals whose hash
   * matches the configuration *as it was* are moved to the configuration *as
   * it now is*; a signal that was already stale before the backup stays stale,
   * because it answered a different question then and still does. Blanket
   * re-stamping would promote retired history into the current run.
   */
  private rehashGemSignalFingerprints(
    data: BackupData,
    idRemap: Map<string, string>,
  ): void {
    const signals = data.gem_strategy_signals;
    if (!signals?.length) return;

    const toOldId = new Map(
      [...idRemap].map(([oldId, newId]) => [newId, oldId] as const),
    );
    const assetsByStrategy = new Map<string, Record<string, unknown>[]>();
    for (const asset of data.gem_strategy_assets ?? []) {
      const key = String(asset.strategy_id ?? "");
      const group = assetsByStrategy.get(key);
      if (group) group.push(asset);
      else assetsByStrategy.set(key, [asset]);
    }

    /** The backup's snake_case rows in the shape the hash function wants. */
    const fingerprintOf = (
      strategy: Record<string, unknown>,
      assets: Record<string, unknown>[],
      securityIdOf: (asset: Record<string, unknown>) => string | null,
    ): string =>
      gemConfigFingerprint(
        {
          cadence: strategy.cadence as GemStrategy["cadence"],
          lookbackMonths: Number(strategy.lookback_months),
        },
        assets.map(
          (asset) =>
            ({
              role: asset.role,
              securityId: securityIdOf(asset),
            }) as GemStrategyAsset,
        ),
      );

    for (const strategy of data.gem_strategies ?? []) {
      const strategyId = String(strategy.id ?? "");
      const assets = assetsByStrategy.get(strategyId) ?? [];
      const asNow = fingerprintOf(strategy, assets, (asset) =>
        asset.security_id === null || asset.security_id === undefined
          ? null
          : String(asset.security_id),
      );
      const asBackedUp = fingerprintOf(strategy, assets, (asset) => {
        if (asset.security_id === null || asset.security_id === undefined) {
          return null;
        }
        const remapped = String(asset.security_id);
        return toOldId.get(remapped) ?? remapped;
      });
      if (asNow === asBackedUp) continue;

      for (const signal of signals) {
        if (String(signal.strategy_id ?? "") !== strategyId) continue;
        if (signal.config_fingerprint === asBackedUp) {
          signal.config_fingerprint = asNow;
        }
      }
    }
  }

  private buildBackupIdRemap(data: BackupData): Map<string, string> {
    const remap = new Map<string, string>();
    for (const [table, rows] of Object.entries(data)) {
      if (table === "currencies" || !Array.isArray(rows)) continue;
      collectRowIdRemap(rows, remap, randomUUID);
    }
    return remap;
  }

  /**
   * Returns a deep copy of the backup with every id and every reference to an
   * id (FK columns plus ids embedded in JSONB values such as scheduled
   * transaction `tag_ids` or override `splits`) rewritten via the remap. The
   * `user_id` columns are never remapped here -- they are not backup row ids,
   * and insertRows() forces them to the restoring user. Currencies are passed
   * through unchanged.
   */
  private remapBackupIds(
    data: BackupData,
    remap: Map<string, string>,
  ): BackupData {
    if (remap.size === 0) return data;
    const result: Record<string, unknown> = { ...data };
    for (const [table, rows] of Object.entries(data)) {
      if (table === "currencies" || !Array.isArray(rows)) continue;
      result[table] = rows.map((row) => this.deepRemapIds(row, remap));
    }
    return result as unknown as BackupData;
  }

  /** See backup-id-remap.util.ts -- shared with the support (de-identified)
   *  export so the two walkers cannot drift. */
  private deepRemapIds(value: unknown, remap: Map<string, string>): unknown {
    return deepRemapIds(value, remap);
  }
}
