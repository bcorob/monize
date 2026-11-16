import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  DataSource,
  EntityTarget,
  In,
  IsNull,
  LessThanOrEqual,
  Not,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { affectedRowCount } from "../common/db/query-result";
import { Cron } from "@nestjs/schedule";
import { createHash, randomUUID } from "crypto";
import {
  BACKUP_STORAGE_TARGET,
  BackupStorageTarget,
  BackupStoreLocation,
  OpenedArtifact,
  StoredArtifactEntry,
} from "./storage/backup-storage.interface";
import { DEFAULT_BACKUP_CONTAINER_DIR } from "./storage/local-backup-storage.target";
import { AutoBackupSettings } from "./entities/auto-backup-settings.entity";
import { AutoBackupPolicyRow } from "./entities/auto-backup-policy.entity";
import { BackupService, BackupCompletenessReport } from "./backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { User } from "../users/entities/user.entity";
import { DemoModeService } from "../common/demo-mode.service";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { UserMaintenanceService } from "../common/jobs/user-maintenance.service";
import { SystemAlertService } from "../system-alerts/system-alert.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import {
  UpdateAutoBackupSettingsDto,
  AutoBackupFrequency,
} from "./dto/update-auto-backup-settings.dto";
import {
  BACKUP_FILE_PREFIX,
  BackupTier,
  classifyBackupFileName,
  isEncryptedBackupFileName,
  PARTIAL_TIER_NAME,
} from "./backup-file-names";
import { BackupOffsiteDispatchService } from "./offsite/backup-offsite-dispatch.service";
import { offsiteArtifactFileName } from "./offsite/backup-offsite-keys";
import {
  BackupOffsiteTier,
  BackupOffsiteUpload,
  BackupOffsiteUploadStatus,
} from "./offsite/entities/backup-offsite-upload.entity";
import { tr } from "../i18n/translate";

/**
 * The deployment's automatic-backup policy: how backups run, for every account
 * on this instance.
 *
 * These are exactly the columns of `auto_backup_settings` that are **not** one
 * user's bookkeeping. The split is the whole point: `lastBackupAt`,
 * `lastBackupStatus`, `lastBackupError` and `nextBackupAt` describe how one
 * account's own run went and belong to that account's row; everything here
 * describes the deployment and has one value for all of them.
 *
 * It has its own singleton row (`auto_backup_policy`). It previously lived on
 * the `auto_backup_settings` row of the earliest-created active administrator,
 * which made three ordinary account operations silently rewrite a
 * deployment-wide setting: deactivating or demoting that administrator handed
 * ownership to the next one, whose row usually did not exist, so every account
 * reverted to the built-in defaults; deleting them cascaded the policy away;
 * and restoring their own backup replayed a months-old policy over the whole
 * instance. Before *that*, the admin surface wrote these columns onto the
 * administrator's own row while every other account was reconciled to a
 * hardcoded `defaultSettingsFor`, so an operator who changed the frequency or
 * the retention changed nothing for anybody but themselves.
 */
export interface AutoBackupPolicy {
  enabled: boolean;
  folderPath: string;
  frequency: AutoBackupFrequency;
  backupTime: string;
  timezone: string;
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
}

/**
 * What the admin surface reads back: the policy, plus where it lands and how
 * far it actually reaches.
 *
 * `scheduledAccountCount` is the honest half of the coverage pair. `accountCount`
 * is how many active accounts the policy governs; `scheduledAccountCount` is how
 * many of them currently hold an armed row the cron will pick up. They match on
 * a settled deployment and differ exactly when something is wrong or not yet
 * done -- a policy saved seconds ago, an account whose reconcile threw. A single
 * number could only have been the first, which would state coverage the
 * deployment does not have.
 */
export interface AutoBackupPolicyView extends AutoBackupPolicy {
  /** The base backups are written under, resolved by the active store. */
  folderPath: string;
  /** An example of the per-account folder underneath it; see `describeLocation`. */
  resolvedFolderPath?: string;
  /** Active accounts this policy governs. */
  accountCount: number;
  /** How many of them hold an armed schedule right now. */
  scheduledAccountCount: number;
  /** The most recent run of any account, deployment-wide. */
  lastBackupAt: Date | null;
  lastBackupStatus: string | null;
  lastBackupError: string | null;
  /** The soonest next run of any armed account. */
  nextBackupAt: Date | null;
}

/**
 * The policy fields that decide *when* the next run is.
 *
 * A change to one of these re-arms every account: the operator asked for a
 * different time, and carrying the old `next_backup_at` forward would run the
 * next backup on the schedule they just replaced -- up to a week late on
 * `weekly`, with the status line contradicting the form that set it. A change
 * to retention or the folder is not one of these and must leave
 * `next_backup_at` alone, because disturbing it for no reason is how the cron's
 * claim gets reverted.
 */
const SCHEDULE_FIELDS = ["frequency", "backupTime", "timezone"] as const;

/**
 * The policy fields, as a list, so "which columns does the policy own" is
 * written once. `reconcileManagedUsers` compares against it to decide whether a
 * row has drifted, and `policyFrom` projects a stored row down to it.
 */
const POLICY_FIELDS = [
  "enabled",
  "folderPath",
  "frequency",
  "backupTime",
  "timezone",
  "retentionDaily",
  "retentionWeekly",
  "retentionMonthly",
] as const;

/**
 * Re-exported from the `local` storage target, which is where the default lives
 * now that a container directory is one target's concern rather than every
 * backup's. Callers and specs have always found it here.
 */
export { DEFAULT_BACKUP_CONTAINER_DIR };

/**
 * Which path produced a backup run, because the admin alerts belong to only
 * one of them.
 *
 * An automatic run has nobody watching: its failure is the whole reason the
 * alerts exist. A **manual** run is somebody pressing "Back up now" and
 * reading the result in the response -- alerting on it filed an admin notice
 * titled "Automatic backup incomplete" about a backup that was not automatic,
 * let a manual partial run take that day's dedupe key and silence the real
 * automatic failure behind it, and made the HTTP request wait on a per-
 * administrator SMTP fan-out after the backup had already succeeded.
 */
type BackupRunOrigin = "automatic" | "manual";

/**
 * Days of the month on which a daily artifact is also promoted to weekly, and
 * the one on which it is promoted to monthly.
 *
 * Exported because they are the suite's calendar as much as the service's. A
 * test that writes a backup and then counts the files in the folder gets a
 * different answer on these five days, so `auto-backup.service.spec.ts` pins
 * its clock to a day that is in neither list and asserts that fact against
 * these constants. Widening either one without exporting it would silently
 * make ten assertions depend on the date the suite happened to run.
 */
export const WEEKLY_DAYS = [7, 14, 21, 28];

/** The day of the month a daily artifact is also promoted to monthly. */
export const MONTHLY_DAY = 1;

/**
 * How many of this user's off-site ledger rows one stored-backups listing reads,
 * newest first, to attach each artifact's copy status.
 *
 * Generous by design and never a correctness bound: only a published `daily`
 * artifact is dispatched off-machine (`dispatchOffsiteCopy`), the currently
 * stored dailies are the newest recovery points, and their ledger rows are
 * therefore the newest rows -- so the artifacts a listing can show a status for
 * always sit at the top of this window, well inside it for any realistic
 * retention. The cap only keeps an append-only table's whole history out of one
 * read.
 */
const OFFSITE_STATUS_SCAN_LIMIT = 500;

/**
 * How long a manual fan-out's claim stands before another caller may take it.
 *
 * The bound exists only for the holder that is gone -- a killed replica, a
 * container reaped mid-run -- because the claim is released in a `finally` on
 * every ordinary path. Generous rather than tight: a fan-out is one export per
 * account in sequence, and a bound shorter than a real run on a large
 * deployment would let a second caller start one on top of the first, which is
 * the thing the claim exists to prevent.
 */
const MANUAL_RUN_CLAIM_TTL_HOURS = 6;

const FREQUENCY_HOURS: Record<AutoBackupFrequency, number> = {
  every6hours: 6,
  every12hours: 12,
  daily: 24,
  weekly: 168,
};

/**
 * One stored automatic backup, as its owner sees it on the Settings page.
 *
 * `modifiedAt` is the file's mtime rather than the date in its name: the name
 * says which recovery point the artifact is (and which retention tier it is
 * kept under), the mtime says when these bytes were written, and a promoted
 * weekly or monthly copy has the two disagree. What a reader is choosing
 * between here is files, so the file's own timestamp is the honest column.
 */
export interface StoredBackup {
  filename: string;
  /** Last modification time of the file on the server, ISO-8601. */
  modifiedAt: string;
  /** Size in bytes. */
  size: number;
  /** True for an encrypted Monize envelope, which needs its password to restore. */
  encrypted: boolean;
  /**
   * The newest off-machine copy status per destination for this artifact, as an
   * icon on its row. Present only when at least one off-site ledger row names
   * the artifact: a weekly or monthly promotion, a partial, or a file that was
   * never dispatched has no rows and no `offsite`
   * (`docs/specs/backup-off-machine.md`).
   */
  offsite?: {
    s3?: BackupOffsiteUploadStatus;
    email?: BackupOffsiteUploadStatus;
  };
}

/**
 * What the owner of a backup folder is told about it.
 *
 * `enabled` is this user's own schedule, which is what decides whether the
 * Settings screen offers the section at all: a deployment that has not armed
 * automatic backups has nothing to say there. It travels with the listing
 * rather than on the settings endpoint because that one is admin-only, and the
 * people who most need this answer are exactly the ones who cannot read it.
 */
export interface StoredBackupsReport {
  enabled: boolean;
  backups: StoredBackup[];
}

/**
 * How much of the store one user's automatic backups occupy, for the admin user
 * list.
 *
 * `artifacts` and `bytes` are `null` **together** and only when the store could
 * not be enumerated at all -- a misconfigured backup root, an object store that
 * refused the listing. That is genuinely unknown and is reported as unknown: a
 * store nobody could read is not a store holding nothing, and zero is the
 * truthful answer only for a user whose namespace is empty, which enumerates
 * fine and answers `0`.
 *
 * `enabled` is this user's schedule as it stands now, which is a different
 * question from what the store is holding: a user switched off last week still
 * occupies whatever their retention window has not aged out yet.
 */
export interface StoredBackupUsage {
  readonly enabled: boolean;
  /** Artifacts attributable to this user, or `null` when the store is unreadable. */
  readonly artifacts: number | null;
  /** Their combined size in bytes; `null` exactly when `artifacts` is. */
  readonly bytes: number | null;
}

/**
 * What one written artifact is, to anything downstream of the write.
 *
 * `digest` is the **egress digest** (`docs/specs/backup-off-machine.md` section
 * 3): the SHA-256 of the exact bytes handed to `writeFileAtomic`, computed once
 * over the buffer that was written rather than re-read from the file, so the
 * value is the identity of the artifact this run produced and not of whatever
 * happens to sit under that name later. It is the checksum an off-machine copy
 * declares (INV-BACKUP-005), the disambiguator in its object key, and the
 * durable identity its state row carries -- one digest, computed once.
 *
 * `sizeBytes` travels with it because the two are one claim about the same
 * bytes: a size that disagrees with the file on disk means the digest describes
 * something the reader is not holding.
 */
interface WrittenArtifact {
  filename: string;
  report: BackupCompletenessReport;
  /** SHA-256 of the written bytes, lowercase hex. */
  digest: string;
  /** Length of the written bytes. */
  sizeBytes: number;
}

/** One stored artifact paired with what its name declares it to be. */
interface BackupFile {
  entry: StoredArtifactEntry;
  date: Date;
  tier: BackupTier;
}

/**
 * Automatic backups: scheduling, retention, and where the files land.
 *
 * **Layout.** Each user's backups live in their own folder under the configured
 * base, fanned out by user id exactly the way attachment bytes are:
 * `<BACKUP_CONTAINER_DIR>/<ab>/<cd>/<userId>/monize-backup-daily-<date>.json.gz`
 * (see `common/shard-path.util.ts`). The filenames carry only a tier and a
 * date, so a flat shared folder gave every user the same name for the same day
 * -- whoever ran last overwrote the others, and one user's retention pass
 * deleted another's files. The per-user folder is what makes a backup belong to
 * somebody.
 *
 * **Who configures it, and whose data it covers.** Only an administrator sees
 * the controls (the endpoints live on `AutoBackupController`, behind
 * `@Roles("admin")`), and what they edit is one **deployment policy**
 * (`AutoBackupPolicy`) rather than their own preference: every active account on
 * the instance is reconciled onto it, hourly by `reconcileManagedUsers` and
 * immediately on save. So a frequency, folder or retention chosen here is the
 * frequency, folder and retention every account runs on -- which is what the
 * screen has always said it was doing.
 *
 * **Where the policy is stored.** In its own singleton row,
 * `auto_backup_policy` -- a table with no owner column, because the thing it
 * describes has no owner. Every administrator reads and writes that one row, so
 * two operators edit one policy rather than two, and no account operation can
 * rewrite it. An instance whose row has never been written runs on
 * `defaultPolicy`, which is enabled: a deployment that has never opened the
 * screen still backs every account up.
 */
@Injectable()
export class AutoBackupService {
  private readonly logger = new Logger(AutoBackupService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly backupService: BackupService,
    private readonly backupEncryption: BackupEncryptionService,
    private readonly demoMode: DemoModeService,
    private readonly maintenance: UserMaintenanceService,
    private readonly systemAlerts: SystemAlertService,
    // The off-machine copy of a completed artifact. Dispatched on the tail of a
    // run, after the local outcome is durable and outside the export
    // transaction (INV-BACKUP-003); it never throws, so it cannot turn a written
    // backup into a failed one.
    private readonly offsiteDispatch: BackupOffsiteDispatchService,
    // Where the artifacts land: a container directory (`local`, the default) or
    // an S3-compatible bucket (`s3`). Every storage operation in this class goes
    // through it, so nothing here knows which one is bound.
    @Inject(BACKUP_STORAGE_TARGET)
    private readonly store: BackupStorageTarget,
  ) {}

  /**
   * This user's namespace in the store, for a caller about to write.
   *
   * Every user keeping the default used to share one folder with one set of
   * date-based filenames, so a second user's job overwrote the first's artifact
   * and then applied its own retention counts to whatever was left. Splitting by
   * user is what makes naming, promotion, listing and retention a per-tenant
   * question again -- and the target, not this class, is what knows how that
   * split is spelled in the storage it is talking to.
   */
  private resolveWriteLocation(
    userId: string,
    folderPath: string | null | undefined,
  ): Promise<BackupStoreLocation> {
    return this.store.resolveLocation(userId, folderPath, { create: true });
  }

  /**
   * This user's namespace in the store, for a caller that only reads.
   *
   * `resolveWriteLocation` proves the store is writable, so a deployment whose
   * storage has gone read-only refuses there. That is right for a backup about
   * to be written and wrong for reading the backups already stored -- which is
   * exactly the moment somebody needs to find them.
   */
  private resolveReadLocation(
    userId: string,
    folderPath: string | null | undefined,
  ): Promise<BackupStoreLocation> {
    return this.store.resolveLocation(userId, folderPath, { create: false });
  }

  /**
   * Where one user's stored artifacts are read back from, for a caller outside
   * this class -- the off-site retry sweep, which holds a durable row describing
   * a copy and has to find the artifact again hours later.
   *
   * It resolves from the user's *current* settings rather than from anything
   * remembered, because an operator may have moved the backup root since the
   * artifact was written, and it runs the same checks every other read does
   * (`resolveReadLocation`): a public entry point that skipped them would be the
   * one hole in a fence this class otherwise keeps whole.
   */
  async resolveStoredBackupLocation(
    userId: string,
  ): Promise<BackupStoreLocation> {
    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    return this.resolveReadLocation(userId, settings?.folderPath);
  }

  /**
   * The automatic backups this deployment is holding for one user.
   *
   * Only the caller's own namespace is read. The store's `legacy` artifacts --
   * on the `local` target, the flat base folder a version before per-user
   * folders wrote into -- are deliberately skipped: those filenames carry no
   * user id, so nothing there can be attributed to anybody, and offering one for
   * download would hand a user another user's ledger. Retention still sweeps
   * them (`enforceRetention`), which is where that shared history ages out.
   *
   * A store that holds nothing for this user yet is an empty list, not an error:
   * a user enrolled on the deployment defaults has artifacts only after their
   * first run.
   */
  async listStoredBackups(userId: string): Promise<StoredBackupsReport> {
    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    const enabled = settings?.enabled === true;
    let entries: StoredArtifactEntry[];
    try {
      const location = await this.resolveReadLocation(
        userId,
        settings?.folderPath,
      );
      entries = await this.store.list(location);
    } catch {
      return { enabled, backups: [] };
    }

    // Each artifact's off-machine copy status, keyed by the local filename its
    // ledger row round-trips to. One scoped read for the whole listing, matched
    // in memory -- there is no per-file query.
    const offsiteByFilename = await this.offsiteStatusByFilename(userId);

    const backups: StoredBackup[] = [];
    for (const entry of entries) {
      if (entry.legacy) continue;
      if (!classifyBackupFileName(entry.name)) continue;
      const offsite = offsiteByFilename.get(entry.name);
      backups.push({
        filename: entry.name,
        modifiedAt: entry.modifiedAt.toISOString(),
        size: entry.sizeBytes,
        encrypted: isEncryptedBackupFileName(entry.name),
        // Only when a ledger row names this artifact; a promotion, a partial
        // or an un-dispatched file simply has none.
        ...(offsite ? { offsite } : {}),
      });
    }
    // Newest first: the artifact somebody reaches for in a crisis is the last
    // one written.
    backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return { enabled, backups };
  }

  /**
   * The same store listing as `listStoredBackups`, reduced to a count and a
   * total -- what the admin user list shows per user.
   *
   * It counts exactly the artifacts that listing offers, and for the same
   * reasons: `legacy` ones are skipped because their names carry no owner, so
   * attributing their bytes to anybody would be a guess, and a name
   * `classifyBackupFileName` does not recognise is not an artifact this module
   * wrote. Both exclusions can make the column read low on a `local` store
   * holding pre-namespacing files; a figure that under-counts a shared history
   * is better than one that bills it to whichever user happens to be listed.
   *
   * Deliberately no off-site lookup: this is called once per user on an admin
   * page, and the per-destination status is a property of an individual
   * artifact, not of the total.
   *
   * An unreadable store answers `null`/`null` rather than throwing, so one
   * user's broken backup root does not take the whole admin listing down --
   * `listStoredBackups` swallows the same failure into an empty list, and the
   * difference here is that an empty list and an unreadable store must not
   * render as the same number.
   */
  async summarizeStoredBackups(userId: string): Promise<StoredBackupUsage> {
    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    const enabled = settings?.enabled === true;
    let entries: StoredArtifactEntry[];
    try {
      const location = await this.resolveReadLocation(
        userId,
        settings?.folderPath,
      );
      entries = await this.store.list(location);
    } catch {
      return { enabled, artifacts: null, bytes: null };
    }

    let artifacts = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (entry.legacy) continue;
      if (!classifyBackupFileName(entry.name)) continue;
      artifacts += 1;
      bytes += entry.sizeBytes;
    }
    return { enabled, artifacts, bytes };
  }

  /**
   * The newest off-machine copy status per destination, for every artifact of
   * this user's that a ledger row names -- the icon each stored-backup row
   * shows.
   *
   * Read under the caller's own scope like the rest of this listing, newest
   * first, and grouped by the LOCAL filename each row round-trips to through
   * `offsiteArtifactFileName` (the inverse of the key the dispatcher wrote), so
   * the two directions cannot drift and no object key is hand-parsed here. Rows
   * arrive newest first, so the first status seen for a (filename, destination)
   * pair -- for example a same-day re-export that produced a second row -- is
   * the current one. A filename with no row is absent from the map, and its
   * `offsite` stays undefined.
   */
  private async offsiteStatusByFilename(
    userId: string,
  ): Promise<Map<string, NonNullable<StoredBackup["offsite"]>>> {
    const rows = await this.scoped(BackupOffsiteUpload, (repo) =>
      repo.find({
        where: { userId },
        order: { createdAt: "DESC" },
        take: OFFSITE_STATUS_SCAN_LIMIT,
      }),
    );
    const byFilename = new Map<string, NonNullable<StoredBackup["offsite"]>>();
    for (const row of rows) {
      const filename = offsiteArtifactFileName(
        row.destination,
        row.objectKey,
        row.digest,
      );
      const group = byFilename.get(filename) ?? {};
      // Newest first, so the first status seen for a destination wins.
      if (group[row.destination] === undefined) {
        group[row.destination] = row.status;
      }
      byFilename.set(filename, group);
    }
    return byFilename;
  }

  /**
   * Open one of this user's stored backups so the caller can stream it.
   *
   * Two checks, each of which would be enough on its own and neither of which is
   * therefore load-bearing alone. The name is accepted only when
   * `classifyBackupFileName` recognises it -- the patterns admit a fixed prefix,
   * a tier, a date and one of two extensions, and nothing with a separator in
   * it. The store then matches that name against what it is actually holding and
   * opens its own entry, never the caller's string; on the `local` target that
   * is the CWE-22 boundary the folder validation states for operator-supplied
   * paths, and on an object store there is no path to traverse at all.
   *
   * An unrecognised name and an absent artifact answer the same 404 on purpose:
   * the difference between "no such artifact" and "not a name we write" tells a
   * caller nothing they may act on.
   */
  async openStoredBackup(
    userId: string,
    filename: string,
  ): Promise<OpenedArtifact> {
    const notFound = () =>
      new NotFoundException(
        tr("errors.backup.storedBackupNotFound", "Backup file not found"),
      );
    if (!classifyBackupFileName(filename)) throw notFound();

    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    const location = await this.resolveReadLocation(
      userId,
      settings?.folderPath,
    );
    const artifact = await this.store.open(location, filename);
    if (!artifact) throw notFound();
    return artifact;
  }

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had.
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
   * The policy a deployment runs on until an administrator saves one.
   *
   * **Enabled**, unlike `defaultSettingsFor` below, and deliberately: an
   * instance that has never had its backup policy opened still backs every
   * account up, which is the behaviour managed users have always had (the old
   * the enrollment it replaces hardcoded `enabled: true` for them). A disabled
   * default would have turned automatic backups off for every such deployment
   * the moment the policy started being honoured.
   */
  private defaultPolicy(): AutoBackupPolicy {
    return {
      enabled: true,
      // Only where the store has a location somebody may choose. Writing an
      // object store's `s3://bucket/prefix` into this column would persist a
      // value nothing reads -- and would be read as a directory, and refused,
      // by a deployment that later switched back to a `local` store.
      folderPath: this.store.locationSelectable ? this.store.defaultBase : "",
      frequency: "daily",
      backupTime: "02:00",
      timezone: "UTC",
      retentionDaily: 7,
      retentionWeekly: 4,
      retentionMonthly: 6,
    };
  }

  /**
   * The policy half of a stored row, with its bookkeeping columns dropped.
   *
   * Takes either shape: the policy singleton, and -- where a caller already
   * holds one -- an account's reconciled `auto_backup_settings` row, whose
   * policy columns are a copy of the same values.
   */
  private policyFrom(
    settings: AutoBackupPolicyRow | AutoBackupSettings,
  ): AutoBackupPolicy {
    return {
      enabled: settings.enabled,
      folderPath: settings.folderPath,
      frequency: settings.frequency as AutoBackupFrequency,
      backupTime: settings.backupTime,
      timezone: settings.timezone,
      retentionDaily: settings.retentionDaily,
      retentionWeekly: settings.retentionWeekly,
      retentionMonthly: settings.retentionMonthly,
    };
  }

  /**
   * This deployment's automatic-backup policy, and the row it came from.
   *
   * `row` is absent when nothing has ever been saved, in which case the policy
   * is `defaultPolicy()` and nothing has been persisted.
   *
   * `withSystemContext` is not a bypass here -- `auto_backup_policy` is
   * RLS-exempt, so there is no policy to bypass. It is what gives
   * `withScopedDb` an ambient identity on the path that has none: the hourly
   * cron, which runs under no request.
   */
  private async loadPolicy(): Promise<{
    policy: AutoBackupPolicy;
    /** The stored row the policy came from, when there is one. */
    row?: AutoBackupPolicyRow;
  }> {
    const row = await withSystemContext(() =>
      this.scoped(AutoBackupPolicyRow, (repo) =>
        repo.findOne({ where: { id: true } }),
      ),
    );
    return row
      ? { policy: this.policyFrom(row), row }
      : { policy: this.defaultPolicy() };
  }

  /**
   * What the admin surface shows beside the policy: how many accounts it
   * governs, and how the deployment's runs are actually going.
   *
   * The status columns are a **deployment-wide** answer -- the most recent run
   * of any account, and the soonest next run of any armed one -- not the
   * administrator's own. A policy screen reporting one row's `lastBackupAt` says
   * "Last backup: today" on an instance where eleven of twelve accounts have
   * never been backed up at all.
   */
  private async describeCoverage(): Promise<{
    accountCount: number;
    scheduledAccountCount: number;
    lastBackupAt: Date | null;
    lastBackupStatus: string | null;
    lastBackupError: string | null;
    nextBackupAt: Date | null;
  }> {
    // RLS: a deployment-wide count and two deployment-wide aggregates.
    return withSystemContext(async () => {
      const accountCount = await this.scoped(User, (repo) =>
        repo.count({ where: { isActive: true } }),
      );
      // One read of a table with one row per account, reduced here rather than
      // two ordered `findOne`s: the aggregates are over the same rows, and a
      // second round trip to answer the second half of one question is a round
      // trip.
      const rows = await this.scoped(AutoBackupSettings, (repo) =>
        repo.find({
          where: [{ lastBackupAt: Not(IsNull()) }, { enabled: true }],
        }),
      );
      const lastRun = rows
        .filter((row) => row.lastBackupAt)
        .sort(
          (a, b) =>
            (b.lastBackupAt as Date).getTime() -
            (a.lastBackupAt as Date).getTime(),
        )[0];
      const nextRun = rows
        .filter((row) => row.enabled && row.nextBackupAt)
        .sort(
          (a, b) =>
            (a.nextBackupAt as Date).getTime() -
            (b.nextBackupAt as Date).getTime(),
        )[0];
      // Counted from the rows themselves rather than from the account list:
      // an account whose reconcile threw is logged and skipped, and counting
      // it as covered is the one thing this figure must not do.
      const scheduledAccountCount = rows.filter(
        (row) => row.enabled && row.nextBackupAt,
      ).length;
      return {
        accountCount,
        scheduledAccountCount,
        lastBackupAt: lastRun?.lastBackupAt ?? null,
        lastBackupStatus: lastRun?.lastBackupStatus ?? null,
        lastBackupError: lastRun?.lastBackupError ?? null,
        nextBackupAt: nextRun?.nextBackupAt ?? null,
      };
    });
  }

  /**
   * Settings for a user with no persisted row yet (not saved by this method).
   *
   * Disabled, unlike `defaultPolicy`: this is the shape of an account that
   * nothing has reconciled yet, and claiming it is armed would have the cron
   * skip it while the screen said otherwise. `reconcileManagedUsers` is what
   * turns it into a row that runs.
   */
  private defaultSettingsFor(userId: string): AutoBackupSettings {
    const defaults = Object.assign(
      new AutoBackupSettings(),
      this.defaultPolicy(),
    );
    defaults.userId = userId;
    defaults.enabled = false;
    defaults.lastBackupAt = null;
    defaults.lastBackupStatus = null;
    defaults.lastBackupError = null;
    defaults.nextBackupAt = null;
    return defaults;
  }

  /**
   * Attach the read-only `resolvedFolderPath` -- where this user's artifacts
   * actually land -- so the settings screen can show where to look. Computed on
   * every read rather than stored: the layout is derived from the base and the
   * user id, and a persisted copy could disagree with both.
   */
  private withResolvedFolder(settings: AutoBackupSettings): AutoBackupSettings {
    const basePath = this.store.resolveBase(settings.folderPath);
    return Object.assign(new AutoBackupSettings(), settings, {
      folderPath: basePath,
      resolvedFolderPath: this.store.describeLocation(
        settings.userId,
        settings.folderPath,
      ),
    });
  }

  /**
   * The deployment policy, as the admin surface reads it.
   *
   * Not the caller's own row: whichever administrator is signed in, this is the
   * one policy the instance runs on, with deployment-wide coverage and status
   * attached (`describeCoverage`). `userId` on the returned object is the
   * policy's owner, which is what `resolvedFolderPath` is an example path for.
   */
  async getSettings(actingUserId: string): Promise<AutoBackupPolicyView> {
    const { policy } = await this.loadPolicy();
    // Report the folder backups are actually written to, so a policy that never
    // had one chosen shows the deployment default instead of a blank, and an
    // example of the per-account folder underneath it. The example is resolved
    // for the administrator reading the screen -- every account's is the same
    // shape under the same base.
    const basePath = this.store.resolveBase(policy.folderPath);
    return {
      ...policy,
      folderPath: basePath,
      resolvedFolderPath: this.store.describeLocation(
        actingUserId,
        policy.folderPath,
      ),
      ...(await this.describeCoverage()),
    };
  }

  /**
   * Whether this deployment can write an automatic backup anywhere.
   *
   * Enabling a schedule already fails when it cannot -- `resolveWriteLocation`
   * makes the user's namespace and proves the store is writable, so a read-only
   * root filesystem with no mount is refused rather than stored. But it is
   * refused only *after* the user has configured a frequency, a time and a
   * retention policy and pressed save, and the answer does not depend on
   * anything they chose. A surface that can say "this deployment has no backup
   * storage" up front is telling them something true earlier.
   *
   * The store the **policy** would actually write to is what gets probed -- its
   * stored base when one is set, the deployment default otherwise. Probing only
   * the default reported "no storage" while a configured secondary root from
   * BACKUP_ALLOWED_ROOTS was mounted and writable, and the banner then blocked
   * re-arming a schedule that would have worked (F3RB-003).
   */
  async describeCapability(userId: string): Promise<{
    available: boolean;
    folderPath: string;
    locationSelectable: boolean;
    storageProvider: string;
    artifactCount?: number;
    reason?: string;
  }> {
    // The policy's folder, not the caller's own row: this surface reports
    // whether the deployment can write the backups the policy asks for, and on
    // a second administrator's session those are two different folders.
    const { policy } = await this.loadPolicy();
    const capability = await this.store.describeStore(
      userId,
      policy.folderPath,
    );
    return {
      available: capability.available,
      folderPath: capability.location,
      locationSelectable: capability.locationSelectable,
      // Which store is bound, so the screen can name it rather than inferring
      // "S3" from the absence of a folder picker. `locationSelectable` answers
      // "may I choose a location"; it does not answer "where do my backups
      // live", and a surface that has to guess gets it wrong the first time a
      // third target exists.
      storageProvider: this.store.name,
      ...(capability.artifactCount !== undefined
        ? { artifactCount: capability.artifactCount }
        : {}),
      ...(capability.reason !== undefined ? { reason: capability.reason } : {}),
    };
  }

  /**
   * Change the deployment policy, and make it true of every account now.
   *
   * The write lands on the primary administrator's row wherever the caller's own
   * row is, so two administrators edit one policy. The
   * reconcile afterwards is the point of the whole method: a policy that only
   * took effect at the top of the next hour would leave "Save" looking like it
   * had done nothing, and a policy that only ever governed the row it was stored
   * on -- which is what this used to be -- is the defect being fixed.
   */
  async updateSettings(
    actingUserId: string,
    dto: UpdateAutoBackupSettingsDto,
  ): Promise<AutoBackupPolicyView> {
    const { policy: current } = await this.loadPolicy();
    // Seed from the same defaults getSettings reports, so an update that only
    // touches one field still lands on a complete policy.
    const settings: AutoBackupPolicy = { ...current };

    if (dto.folderPath !== undefined) {
      settings.folderPath = this.store.acceptBase(dto.folderPath);
    }
    if (dto.frequency !== undefined) {
      settings.frequency = dto.frequency;
    }
    if (dto.backupTime !== undefined) {
      settings.backupTime = dto.backupTime;
    }
    if (dto.timezone !== undefined) {
      settings.timezone = dto.timezone;
    }
    if (dto.retentionDaily !== undefined) {
      settings.retentionDaily = dto.retentionDaily;
    }
    if (dto.retentionWeekly !== undefined) {
      settings.retentionWeekly = dto.retentionWeekly;
    }
    if (dto.retentionMonthly !== undefined) {
      settings.retentionMonthly = dto.retentionMonthly;
    }

    if (dto.enabled !== undefined) {
      settings.enabled = dto.enabled;
      if (dto.enabled) {
        // Persist the resolved base so the stored row always records where
        // backups actually go, even when the user never picked one -- but only
        // where the store has a location somebody may choose, for the reason
        // `defaultSettingsFor` gives. What gets checked for writability is the
        // per-user namespace inside it, which is where the artifact will land.
        if (this.store.locationSelectable) {
          settings.folderPath = this.store.resolveBase(settings.folderPath);
        }
        // Make and check a namespace now, so a store that is readable but not
        // writable is reported at save time rather than at 02:00 as a failed
        // backup. The administrator's own is the one to probe: every account's
        // namespace is the same shape under the same base, and this one is
        // theirs to create.
        await this.resolveWriteLocation(actingUserId, settings.folderPath);
      }
      // No `nextBackupAt` here: the policy holds no schedule of its own. Arming
      // and disarming every account's own `next_backup_at` is the reconcile's
      // job below, which is the only writer that knows which rows already hold
      // a claim.
    }

    // One row, upserted: `id` is always `true`, so the conflict target is the
    // whole table and two administrators saving at once leave one policy rather
    // than two. `manual_run_claimed_at` is deliberately not in the update list
    // -- it is a claim, not a setting, and a save must not free a fan-out that
    // is still running.
    const saved = await this.writePolicy(settings);

    // The policy is now stored; make it true of every account before answering,
    // so the count the screen reads back is the count that is actually running
    // on it. One account's row failing to reconcile is caught and logged per
    // account inside, so it cannot turn a saved policy into a 500 the operator
    // reads as "not saved".
    await this.reconcileManagedUsers(new Date(), saved);

    return {
      ...saved,
      folderPath: this.store.resolveBase(saved.folderPath),
      resolvedFolderPath: this.store.describeLocation(
        actingUserId,
        saved.folderPath,
      ),
      ...(await this.describeCoverage()),
    };
  }

  /**
   * Store the deployment policy, as one upsert against the singleton.
   *
   * `ON CONFLICT (id) DO UPDATE` rather than read-then-save: the row may not
   * exist yet on a deployment that has never saved, and two administrators
   * pressing Save together must leave one policy rather than race a read. The
   * column list is exactly the policy -- `manual_run_claimed_at` is a claim a
   * fan-out may be holding and is not a setting to overwrite.
   */
  private async writePolicy(
    policy: AutoBackupPolicy,
  ): Promise<AutoBackupPolicy> {
    await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO auto_backup_policy
             (id, enabled, folder_path, frequency, backup_time, timezone,
              retention_daily, retention_weekly, retention_monthly, updated_at)
           VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 folder_path = EXCLUDED.folder_path,
                 frequency = EXCLUDED.frequency,
                 backup_time = EXCLUDED.backup_time,
                 timezone = EXCLUDED.timezone,
                 retention_daily = EXCLUDED.retention_daily,
                 retention_weekly = EXCLUDED.retention_weekly,
                 retention_monthly = EXCLUDED.retention_monthly,
                 updated_at = CURRENT_TIMESTAMP`,
          [
            policy.enabled,
            policy.folderPath,
            policy.frequency,
            policy.backupTime,
            policy.timezone,
            policy.retentionDaily,
            policy.retentionWeekly,
            policy.retentionMonthly,
          ],
        ),
      ),
    );
    return policy;
  }

  /**
   * Admin folder validation and enumeration, answered by the active store.
   *
   * Both are meaningful only where the store has a location somebody may choose
   * -- a container directory has one, an object store's bucket and prefix are
   * the deployment's -- so the target owns the refusal as much as the walk.
   */
  async validateFolder(
    folderPath: string,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.store.validateFolder(folderPath);
  }

  async browseFolders(
    folderPath: string,
  ): Promise<{ current: string; directories: string[] }> {
    return this.store.browseFolders(folderPath);
  }

  /**
   * "Run Backup Now" on the policy screen: back up **every account this
   * deployment holds**, not the administrator pressing the button.
   *
   * The button sits under a deployment policy, so backing up one row was the
   * same defect as the policy governing one row -- an operator pressed it to
   * prove backups worked and proved it for themselves only. Accounts are run one
   * at a time, through the same per-user path the cron uses, and one account's
   * failure never stops the rest: the counts come back so the screen can say how
   * many accounts were written, skipped and failed rather than showing a
   * filename that belongs to whichever ran last.
   *
   * It is a fan-out inside one request, and the request waits for it. That is
   * the honest shape for a button labelled "now" on an instance whose accounts
   * are counted in tens; an instance where it is not should arm the schedule and
   * let the hourly cron do the work.
   */
  async runManualBackup(actingUserId: string): Promise<{
    message: string;
    usersRequested: number;
    usersBackedUp: number;
    usersSkipped: number;
    usersFailed: number;
    usersPartial: number;
    /**
     * The artifact written for the account that pressed the button, when one
     * was. Deliberately only that one: a single filename cannot describe a
     * fan-out, and naming whichever account happened to run last would be a
     * value the reader would take for their own.
     */
    filename?: string;
  }> {
    const { policy } = await this.loadPolicy();

    // One fan-out at a time, deployment-wide. The button walks every account in
    // a single request, so a proxy timeout that leaves the run going and an
    // operator who presses again -- or a second operator on another replica --
    // otherwise interleave two full passes over the same rows. The claim is a
    // conditional UPDATE on the policy singleton with its own staleness bound,
    // so a replica killed mid-run frees it and there is no unlock to forget.
    const claim = await this.claimManualRun();
    if (!claim) {
      throw new ConflictException(
        tr(
          "errors.backup.manualRunInProgress",
          "A backup of every account is already running on this deployment. Wait for it to finish and try again.",
        ),
      );
    }
    try {
      return await this.runManualBackupClaimed(actingUserId, policy);
    } finally {
      await this.releaseManualRun(claim);
    }
  }

  /**
   * Take the deployment-wide manual-run claim, or report that somebody holds it.
   *
   * The predicate is re-evaluated after the row lock, so exactly one caller gets
   * a row back -- the same shape `claimDueBackup` uses for a window. The
   * staleness bound is what makes a crashed holder recoverable without a
   * janitor: a claim older than `MANUAL_RUN_CLAIM_TTL_HOURS` is takeable,
   * because a fan-out that has been running for that long is not running.
   */
  private async claimManualRun(): Promise<string | null> {
    const token = randomUUID();
    const rows = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE auto_backup_policy
              SET manual_run_claimed_at = CURRENT_TIMESTAMP,
                  manual_run_claim_token = $2
            WHERE id = true
              AND (manual_run_claimed_at IS NULL
                   OR manual_run_claimed_at
                      < CURRENT_TIMESTAMP - make_interval(hours => $1::int))
            RETURNING id`,
          [MANUAL_RUN_CLAIM_TTL_HOURS, token],
        ),
      ),
    );
    if (affectedRowCount(rows) > 0) return token;
    // No row at all means nothing has ever been saved, so there is nothing
    // holding a claim and nothing to contend with. Insert the row and take it;
    // `DO NOTHING` is what makes the loser of a race fall through to `null`
    // rather than take a claim somebody else holds.
    const claimed = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO auto_backup_policy
             (id, manual_run_claimed_at, manual_run_claim_token)
           VALUES (true, CURRENT_TIMESTAMP, $1)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [token],
        ),
      ),
    );
    return affectedRowCount(claimed) > 0 ? token : null;
  }

  /**
   * Release the manual-run claim, by token.
   *
   * By token, not by row: a fan-out that outran `MANUAL_RUN_CLAIM_TTL_HOURS`
   * would otherwise free the claim a later run has since taken, and both would
   * then be walking the same accounts -- which is the thing the claim exists to
   * prevent. Never throws: a run that finished is finished, and an unreleased
   * claim ages out on its own, delaying the next run rather than blocking it.
   */
  private async releaseManualRun(token: string): Promise<void> {
    try {
      await withSystemContext(() =>
        withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `UPDATE auto_backup_policy
                SET manual_run_claimed_at = NULL,
                    manual_run_claim_token = NULL
              WHERE id = true
                AND manual_run_claim_token = $1`,
            [token],
          ),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Could not release the manual backup claim: ${error.message}`,
      );
    }
  }

  /** The fan-out itself, with the deployment-wide claim already held. */
  private async runManualBackupClaimed(
    actingUserId: string,
    policy: AutoBackupPolicy,
  ): Promise<{
    message: string;
    usersRequested: number;
    usersBackedUp: number;
    usersSkipped: number;
    usersFailed: number;
    usersPartial: number;
    filename?: string;
  }> {
    const userIds = await this.resolveBackupTargets(actingUserId);

    let usersBackedUp = 0;
    let usersSkipped = 0;
    let usersFailed = 0;
    let usersPartial = 0;
    let ownFilename: string | undefined;
    // Kept so a run that wrote nothing can say *why* rather than "it did not
    // work". The operator pressed this button to find out.
    let firstError: unknown;

    for (const userId of userIds) {
      try {
        const outcome = await this.runBackupForUser(userId, policy);
        if (!outcome) {
          usersSkipped++;
          continue;
        }
        usersBackedUp++;
        if (userId === actingUserId) ownFilename = outcome.filename;
        if (!outcome.complete) usersPartial++;
      } catch (error) {
        usersFailed++;
        firstError ??= error;
        this.logger.error(
          `Manual backup failed for user ${userId}: ${error.message}`,
        );
      }
    }

    // Nothing was written at all: a 200 carrying zeroes reads as "done" on a
    // screen whose whole job is to say whether backups work.
    if (usersBackedUp === 0 && userIds.length > 0) {
      if (usersFailed === 1) {
        // One account, one reason: the caller gets the actual refusal -- the
        // undecryptable password, the missing user row, the unwritable folder
        // -- with its own status, not a generic replacement for it.
        throw firstError;
      }
      if (usersFailed > 1) {
        const reason = String((firstError as Error)?.message ?? firstError);
        throw new ConflictException(
          tr(
            "errors.backup.manualRunFailed",
            `No backup could be written: ${usersFailed} account(s) failed. First error: ${reason}`,
            { count: usersFailed, reason },
          ),
        );
      }
      // Skipped, not failed: every account is mid-replacement.
      throw new ConflictException(
        tr(
          "errors.maintenance.inProgress",
          "Another operation is currently replacing this account's data. Wait for it to finish and try again.",
        ),
      );
    }

    return {
      // A count is not a result on its own: a partial artifact is the one
      // outcome a reader would otherwise take for a complete backup, so the
      // message says what "partial" cost them and what it did not.
      message:
        `Backed up ${usersBackedUp} of ${userIds.length} account(s)` +
        (usersPartial > 0 ? `, ${usersPartial} partial` : "") +
        (usersSkipped > 0 ? `, ${usersSkipped} skipped` : "") +
        (usersFailed > 0 ? `, ${usersFailed} failed` : "") +
        (usersPartial > 0
          ? ". Some attachments could not be included: those artifacts were " +
            "saved as partial artifacts, were not promoted, and did not " +
            "replace or age out any complete backup."
          : ""),
      usersRequested: userIds.length,
      usersBackedUp,
      usersSkipped,
      usersFailed,
      usersPartial,
      ...(ownFilename !== undefined ? { filename: ownFilename } : {}),
    };
  }

  /**
   * Every active account a manual run covers, the caller's own first so an
   * operator watching the request sees their own data protected before anyone
   * else's if it is cut short.
   */
  private async resolveBackupTargets(actingUserId: string): Promise<string[]> {
    // RLS: a deployment-wide fan-out, the same read `reconcileManagedUsers`
    // makes.
    const ids = await withSystemContext(async () => {
      const users = await this.scoped(User, (repo) =>
        repo.find({ select: { id: true }, where: { isActive: true } }),
      );
      return users.map((u) => u.id);
    });
    if (ids.length === 0) return [actingUserId];
    return [
      ...ids.filter((id) => id === actingUserId),
      ...ids.filter((id) => id !== actingUserId),
    ];
  }

  /**
   * One account's manual backup: `null` when its data is mid-replacement and the
   * run was therefore skipped, otherwise the artifact that was written.
   *
   * The cron defers in the maintenance state; a manual run says so instead of
   * writing the file anyway, which would produce an empty backup and then rotate
   * the last good one out to keep the retention count.
   *
   * An account that has never been reconciled still gets a working run: the row
   * is seeded from the **deployment policy** here -- not from a disabled
   * `defaultSettingsFor` -- so a run cannot be what persists an "off" policy row
   * for an instance that was running on the enabled default.
   */
  private async runBackupForUser(
    userId: string,
    policy: AutoBackupPolicy,
  ): Promise<{ filename: string; complete: boolean } | null> {
    // RLS: each account's own body runs under its own identity, exactly as the
    // cron's `runDueBackup` does.
    const underMaintenance = await withUserContext(userId, () =>
      this.maintenance.isUnderMaintenance(userId),
    );
    if (underMaintenance) {
      this.logger.log(
        `Manual backup skipped for user ${userId}: their data is being replaced`,
      );
      return null;
    }

    const stored = await withUserContext(userId, () =>
      this.scoped(AutoBackupSettings, (repo) =>
        repo.findOne({ where: { userId } }),
      ),
    );
    let settings = stored;
    if (!settings) {
      // No row yet -- a disabled policy writes none. Create it from the policy
      // before the run rather than after it, so the outcome below has a row to
      // record against: a targeted UPDATE that matches nothing would leave the
      // artifact on disk and nothing anywhere saying it was taken.
      const seeded = Object.assign(this.defaultSettingsFor(userId), policy, {
        userId,
      });
      await withUserContext(userId, () =>
        this.scoped(AutoBackupSettings, (repo) => repo.save(seeded)),
      );
      settings = seeded;
    }
    if (this.store.locationSelectable) {
      settings.folderPath = this.store.resolveBase(settings.folderPath);
    }

    const location = await this.resolveWriteLocation(
      userId,
      settings.folderPath,
    );
    const timezone = settings.timezone || "UTC";
    const artifact = await withUserContext(userId, () =>
      this.exportToStore(userId, location, timezone),
    );
    const { filename, report } = artifact;
    // A partial artifact is published under its own `partial-<date>` name and
    // its own retention tier, so it cannot replace this day's complete artifact
    // and no later retention pass counts it as one (F3RB-001, issue #1069). It
    // is never promoted, and the only deletion its run may make is of older
    // partial artifacts.
    await this.applyBackupOutcome(
      settings,
      location,
      filename,
      report,
      timezone,
      "manual",
    );

    // Only the outcome columns, through the same targeted UPDATE the cron uses.
    // A whole-entity `save` here wrote back `next_backup_at` from a snapshot
    // read before the export, which could revert a claim another replica's cron
    // had taken in the meantime and have that account backed up twice. A manual
    // run is out of band and deliberately does not move the automatic schedule
    // at all: the next scheduled backup is the one the operator configured, not
    // one pushed out by having pressed a button.
    await this.recordBackupOutcome(
      userId,
      new Date(),
      report.complete ? "success" : "partial",
      settings.lastBackupError,
    );

    // After the local artifact exists and this run's own bookkeeping is durable,
    // and outside every transaction above (INV-BACKUP-003).
    await this.dispatchOffsiteCopy(userId, location, artifact, "manual");

    return { filename, complete: report.complete };
  }

  /**
   * Records the backup's outcome and runs promotion + retention only when the
   * artifact is complete.
   *
   * `success` promotes weekly/monthly copies and enforces retention across every
   * tier. `partial` promotes nothing and never deletes a complete artifact: the
   * incomplete artifact stays on disk under its own `partial-` name so the
   * ledger is backed up, and the only deletion that run may make is of *older
   * partial artifacts*, which is what keeps a storage outage from filling the
   * volume with them. A later complete backup resumes normal promotion and
   * retention. This is the invariant that a backup shown as successful is a
   * backup that can be restored in full (F3R7-001), and that a partial one can
   * neither replace nor age out a complete copy (F3RB-001, issue #1069).
   */
  private async applyBackupOutcome(
    settings: AutoBackupSettings,
    location: BackupStoreLocation,
    filename: string,
    report: BackupCompletenessReport,
    timezone: string,
    origin: BackupRunOrigin,
  ): Promise<void> {
    if (report.complete) {
      const weeklyError = await this.copyToWeeklyIfNeeded(
        location,
        filename,
        timezone,
      );
      const monthlyError = await this.copyToMonthlyIfNeeded(
        location,
        filename,
        timezone,
      );
      const retentionErrors = await this.enforceRetention(location, settings);
      settings.lastBackupStatus = "success";
      settings.lastBackupError = null;
      // Promotion and retention failures used to be a `logger.warn` and
      // nothing else -- the artifact is complete, so the status column
      // rightly stays "success", and the alert row is the only durable state
      // these paths have. The daily backup exists; what the admin is told is
      // that the weekly/monthly copy or the cleanup did not happen.
      await this.raiseBackupSideEffectAlerts(
        settings.userId,
        filename,
        origin,
        {
          weeklyError,
          monthlyError,
          retentionErrors,
        },
      );
      return;
    }
    const retentionErrors = await this.enforceRetention(location, settings, [
      PARTIAL_TIER_NAME,
    ]);
    settings.lastBackupStatus = "partial";
    settings.lastBackupError =
      `${report.missingAttachments} attachment(s) could not be included and ` +
      `${report.inconsistentAttachments} did not match their metadata, of ` +
      `${report.expectedAttachments} total. This artifact was written as ` +
      `${filename} and not promoted, and no complete backup was deleted for ` +
      `it, so complete backups are preserved.`;
    this.logger.warn(
      `Auto-backup for user ${settings.userId} is partial: ${settings.lastBackupError}`,
    );
    await this.raiseBackupPartialAlert(settings.userId, "attachments", origin, {
      message: `The backup was written, but ${settings.lastBackupError}`,
      missingAttachments: report.missingAttachments,
      inconsistentAttachments: report.inconsistentAttachments,
      expectedAttachments: report.expectedAttachments,
      filename,
    });
    await this.raiseBackupSideEffectAlerts(settings.userId, filename, origin, {
      weeklyError: null,
      monthlyError: null,
      retentionErrors,
    });
  }

  /**
   * Raise BACKUP_PARTIAL admin alerts for a run whose artifact is fine but
   * whose promotion copies or retention cleanup failed -- the two paths that
   * otherwise leave no durable state at all (`lastBackupStatus` stays
   * "success", correctly: the daily artifact is complete).
   */
  private async raiseBackupSideEffectAlerts(
    userId: string,
    filename: string,
    origin: BackupRunOrigin,
    outcome: {
      weeklyError: string | null;
      monthlyError: string | null;
      retentionErrors: string[];
    },
  ): Promise<void> {
    const promotionErrors = [outcome.weeklyError, outcome.monthlyError].filter(
      (e): e is string => e !== null,
    );
    if (promotionErrors.length > 0) {
      await this.raiseBackupPartialAlert(userId, "promotion", origin, {
        message:
          `The daily backup ${filename} succeeded, but its weekly/monthly ` +
          `copy could not be written: ${promotionErrors.join("; ")}`,
        error: promotionErrors.join("; "),
        filename,
      });
    }
    if (outcome.retentionErrors.length > 0) {
      await this.raiseBackupPartialAlert(userId, "retention", origin, {
        message:
          `The backup succeeded, but ${outcome.retentionErrors.length} old ` +
          `backup file(s) could not be cleaned up: ` +
          outcome.retentionErrors.join("; "),
        error: outcome.retentionErrors.join("; "),
        filename,
      });
    }
  }

  /**
   * One BACKUP_PARTIAL alert to the administrators, deduped per affected
   * user, reason and day. `data` carries the facts for client-side
   * localization; the stored message is the English fallback.
   */
  private async raiseBackupPartialAlert(
    userId: string,
    reason: "attachments" | "promotion" | "retention",
    origin: BackupRunOrigin,
    detail: { message: string } & Record<string, unknown>,
  ): Promise<void> {
    if (origin !== "automatic") return;
    const { message, ...data } = detail;
    const email = await this.userEmailQuietly(userId);
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.BACKUP_PARTIAL,
      severity: NotificationSeverity.WARNING,
      title: "Automatic backup incomplete",
      message: `Automatic backup for ${email ?? `user ${userId}`}: ${message}`,
      data: {
        system: true,
        affectedUserId: userId,
        affectedUserEmail: email,
        reason,
        ...data,
      },
      dedupeKey: `BACKUP_PARTIAL:${userId}:${reason}:${utcDateString()}`,
      // One row per affected user (an administrator has to know WHICH users
      // lost a backup), but one email per reason per day: the usual cause is
      // one broken volume, and a sixty-user install would otherwise send an
      // administrator sixty identical messages about it.
      emailDedupeKey: `BACKUP_PARTIAL:${reason}:${utcDateString()}`,
    });
  }

  /** One BACKUP_FAILED alert to the administrators, deduped per user and day. */
  private async raiseBackupFailedAlert(
    userId: string,
    cause: unknown,
    at: Date,
  ): Promise<void> {
    const error = String((cause as Error)?.message ?? cause).slice(0, 300);
    const email = await this.userEmailQuietly(userId);
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.BACKUP_FAILED,
      severity: NotificationSeverity.CRITICAL,
      title: "Automatic backup failed",
      message:
        `The automatic backup for ${email ?? `user ${userId}`} failed: ` +
        `${error}. No new backup was written this window; the next attempt ` +
        "is the next scheduled one.",
      data: {
        system: true,
        affectedUserId: userId,
        affectedUserEmail: email,
        error,
        date: utcDateString(at),
      },
      dedupeKey: `BACKUP_FAILED:${userId}:${utcDateString(at)}`,
      // As above: the rows stay per user, the mail is said once a day.
      emailDedupeKey: `BACKUP_FAILED:${utcDateString(at)}`,
    });
  }

  /**
   * The affected user's email, for the admin alert's copy -- an address means
   * more to an operator than a UUID. Best-effort: the alert goes out either
   * way, and this lookup runs from failure paths where the database may be
   * the problem.
   */
  private async userEmailQuietly(userId: string): Promise<string | null> {
    try {
      const user = await withSystemContext(() =>
        this.scoped(User, (repo) =>
          repo.findOne({ where: { id: userId }, select: ["id", "email"] }),
        ),
      );
      return user?.email && user.email !== "" ? user.email : null;
    } catch {
      return null;
    }
  }

  /**
   * Claim one due backup by advancing its own schedule.
   *
   * Every replica fires this cron, so without a claim a two-replica cluster
   * writes every user's backup twice -- and worse, one replica's
   * `enforceRetention` can delete the file the other is still writing.
   *
   * The claim is the schedule advance itself: `next_backup_at` is a column this
   * job owns, so `UPDATE ... WHERE next_backup_at <= now RETURNING` re-evaluates
   * the predicate after taking the row lock and exactly one replica gets a row
   * back. No claim table and no lease to expire -- the row already carries the
   * fact. Advancing *before* the export also means a crash mid-backup skips this
   * window rather than retrying forever, which is the behaviour the failure path
   * already had.
   *
   * `RETURNING user_id` because that column is this table's primary key -- there
   * is no `id`. `RETURNING id` parses fine in a mocked-`query` unit test and
   * fails at runtime with `column "id" does not exist` (42703), which took the
   * claim, and therefore every automatic backup, down for every user. The
   * columns any raw SQL in `src/` names are now checked against
   * `database/schema.sql` by `backend/src/common/db/raw-sql-columns.spec.ts`.
   */
  private async claimDueBackup(
    settings: AutoBackupSettings,
    now: Date,
    nextBackupAt: Date,
  ): Promise<boolean> {
    const rows = await withUserContext(settings.userId, () =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE auto_backup_settings
              SET next_backup_at = $1
            WHERE user_id = $2
              AND enabled = true
              AND next_backup_at IS NOT NULL
              AND next_backup_at <= $3
            RETURNING user_id`,
          [nextBackupAt, settings.userId, now],
        ),
      ),
    );
    return affectedRowCount(rows) > 0;
  }

  /**
   * Write only the columns describing how the run went.
   *
   * `repo.save(settings)` would write back every column of the snapshot this
   * sweep read at the top, so a user who changed their folder, frequency or
   * retention through the UI while the sweep was running would find those edits
   * reverted. The outcome columns are the only ones this job is entitled to
   * write; `next_backup_at` was already set by the claim.
   */
  private async recordBackupOutcome(
    userId: string,
    at: Date,
    status: "success" | "partial" | "failed",
    error: string | null,
  ): Promise<void> {
    await withUserContext(userId, () =>
      this.scoped(AutoBackupSettings, (repo) =>
        repo
          .createQueryBuilder()
          .update(AutoBackupSettings)
          .set({
            lastBackupAt: at,
            lastBackupStatus: status,
            lastBackupError: error,
          })
          .where("user_id = :userId", { userId })
          .execute(),
      ),
    );
  }

  @Cron("0 * * * *")
  async handleAutoBackupCron(): Promise<void> {
    const now = new Date();
    await this.reconcileManagedUsers(now);
    // RLS (task C2): cross-user fan-out over every user's due backup settings.
    const dueSettings = await withSystemContext(() =>
      this.scoped(AutoBackupSettings, (repo) =>
        repo.find({
          where: {
            enabled: true,
            nextBackupAt: LessThanOrEqual(now),
          },
        }),
      ),
    );

    if (dueSettings.length === 0) return;

    this.logger.log(`Auto-backup cron: ${dueSettings.length} backup(s) due`);

    for (const settings of dueSettings) {
      // Everything about one user, including the steps *before* the claim,
      // happens inside this try. It used to start below the claim, so an error
      // raised while deciding whether to run -- the maintenance pre-check, or
      // the claim's own UPDATE -- escaped the loop and ended the sweep for
      // every user after this one, with nothing recorded as failed either. That
      // is precisely how `RETURNING id` against a table with no `id` column
      // turned one bad statement into "no automatic backups at all". The same
      // rule is already written out in `reconcileManagedUsers` below: one user's
      // row failing must not stop the others.
      try {
        await this.runDueBackup(settings, now);
      } catch (error) {
        this.logger.error(
          `Auto-backup failed for user ${settings.userId}: ${error.message}`,
        );
        await this.recordFailureQuietly(settings.userId, now, error);
        // The alert is the notification the failure row never was (the status
        // sat on auto_backup_settings and nobody looked). Backups are an
        // operator setting, so the audience is the administrators.
        // `raiseAdminAlert` never throws -- one user's alert failing must not
        // end the sweep any more than the backup failing may.
        await this.raiseBackupFailedAlert(settings.userId, error, now);
      }
    }
  }

  /**
   * One user's window: decide whether to run it, claim it, export it, record it.
   *
   * Throws rather than swallowing, so `handleAutoBackupCron` -- which owns the
   * "one user must not take out the sweep" rule -- is the only place that
   * decides what a failure means.
   */
  private async runDueBackup(
    settings: AutoBackupSettings,
    now: Date,
  ): Promise<void> {
    const nextBackupAt = this.calculateNextBackupAt(
      settings.frequency as AutoBackupFrequency,
      settings.backupTime,
      settings.timezone,
      now,
    );

    // Do not start a backup of a dataset that is already mid-replacement. A
    // `.mny` import with "start fresh" commits its wipe and then writes rows
    // for minutes, so an hourly backup landing in that window would export the
    // empty dataset, save it as today's file, and enforce retention --
    // rotating the last good backup out to make room for one containing
    // nothing. Skipping without claiming leaves `next_backup_at` in the past,
    // so the next hour retries (audit DR-04-02).
    //
    // This is a pre-check and only a pre-check: `isUnderMaintenance` is
    // documented as a hint, and maintenance can still begin between this read
    // and the export snapshot below. It narrows the window rather than closing
    // it; closing it needs backup admission and maintenance acquisition to
    // share one lease, which is the outstanding HIGH item in the PR
    // description.
    //
    // Runs under the user's context like the claim and the outcome write: it
    // reaches `import_jobs` and `job_claims` through `withScopedDb`, which
    // throws without an ambient identity. The `withSystemContext` fan-out
    // above covers only the cross-user settings read.
    const underMaintenance = await withUserContext(settings.userId, () =>
      this.maintenance.isUnderMaintenance(settings.userId),
    );
    if (underMaintenance) {
      this.logger.log(
        `Auto-backup deferred for user ${settings.userId}: their data is being replaced`,
      );
      return;
    }

    const claimed = await this.claimDueBackup(settings, now, nextBackupAt);
    if (!claimed) {
      // Either another replica took this window, or the user disabled or
      // rescheduled the backup after this sweep read its snapshot. Both mean
      // "not ours to run".
      return;
    }

    if (this.store.locationSelectable) {
      settings.folderPath = this.store.resolveBase(settings.folderPath);
    }
    const location = await this.resolveWriteLocation(
      settings.userId,
      settings.folderPath,
    );
    const timezone = settings.timezone || "UTC";
    // RLS (task C2): the export reads this user's entire dataset, and the
    // settings write below is that user's row -- both under a user context.
    const artifact = await withUserContext(settings.userId, () =>
      this.exportToStore(settings.userId, location, timezone),
    );
    const { filename, report } = artifact;
    // Promotion and retention run only for a complete artifact; a partial is
    // written but never allowed to displace a complete copy (F3R7-001).
    await this.applyBackupOutcome(
      settings,
      location,
      filename,
      report,
      timezone,
      "automatic",
    );

    // applyBackupOutcome set lastBackupStatus/Error to reflect a complete
    // ("success") or incomplete ("partial") artifact; record exactly that,
    // never a hardcoded success, so a partial backup is not persisted as a
    // full one (F3R7-001). The write is the targeted outcome UPDATE, not a
    // whole-row save, so it cannot revert a concurrent settings edit.
    await this.recordBackupOutcome(
      settings.userId,
      now,
      report.complete ? "success" : "partial",
      settings.lastBackupError,
    );

    // Last, and only now: the local copy is written and the run is recorded, so
    // the off-machine copy can neither precede it nor take it down with it
    // (INV-BACKUP-003, and the push-after-commit shape of
    // `docs/external-side-effects.md` section 4a).
    await this.dispatchOffsiteCopy(
      settings.userId,
      location,
      artifact,
      "automatic",
    );

    this.logger.log(
      `Auto-backup ${report.complete ? "completed" : "written (partial)"} for user ${settings.userId}: ${filename}`,
    );
  }

  /**
   * Offer one written artifact to the user's off-machine destinations.
   *
   * Two gates, and both are invariants rather than tidiness. **Only a complete
   * artifact is a candidate** (INV-BACKUP-003): a partial one is published under
   * its own `partial-` tier precisely because it is not this day's recovery
   * point, and copying it off-machine would put a backup that cannot be restored
   * in full where an operator reaches for it in a crisis. **The tier comes out
   * of the filename**, the same source retention and the owner-facing listing
   * read it from, so the durable off-site row cannot disagree with the artifact
   * it names.
   *
   * `dispatchAfterBackup` never throws, and this method catches anyway. The
   * containment has to be a property of *this* class: the cron's per-user catch
   * records a failed window, so a rejection escaping here would turn a backup
   * that is complete and on disk into one recorded as failed -- and the manual
   * path would answer a 500 for a backup it had already written.
   */
  private async dispatchOffsiteCopy(
    userId: string,
    location: BackupStoreLocation,
    artifact: WrittenArtifact,
    origin: BackupRunOrigin,
  ): Promise<void> {
    if (!artifact.report.complete) return;
    const tier = publishedOffsiteTier(artifact.filename);
    if (!tier) return;
    try {
      await this.offsiteDispatch.dispatchAfterBackup({
        userId,
        location,
        filename: artifact.filename,
        tier,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        origin,
      });
    } catch (error) {
      this.logger.error(
        `Off-site dispatch of ${artifact.filename} for user ${userId} could ` +
          `not be started: ${error instanceof Error ? error.message : String(error)}. ` +
          "The local backup is unaffected.",
      );
    }
  }

  /**
   * Record a failed window without letting the recording become the failure.
   *
   * The outcome write is itself a database call, so the errors most likely to
   * bring the export down -- the connection, the pool, a broken statement --
   * are exactly the ones that can also break the write recording them. Throwing
   * here would put the sweep back where it started: one user's failure ending
   * everybody else's backups.
   */
  private async recordFailureQuietly(
    userId: string,
    at: Date,
    cause: unknown,
  ): Promise<void> {
    const message = String((cause as Error)?.message ?? cause).slice(0, 1024);
    try {
      await this.recordBackupOutcome(userId, at, "failed", message);
    } catch (error) {
      this.logger.error(
        `Auto-backup could not record the failure for user ${userId}: ${error.message}`,
      );
    }
  }

  /**
   * Put every account on this deployment's backup policy.
   *
   * Automatic backups are not a per-user preference: only an administrator can
   * see or change the policy, so anybody else would silently have no backups at
   * all unless something enrolled them. This runs at the top of the hourly cron
   * rather than at registration so that accounts that already existed are
   * covered too, with no migration to write and nothing to re-run by hand, and
   * again the moment the policy is saved so an operator does not have to wait an
   * hour to see it take.
   *
   * **Every active account**, administrators included and with no exception.
   * Two have been made here before and both cost somebody their backups: first
   * every administrator was excluded, so a second operator who never opened the
   * settings screen was enrolled by nothing at all; then the account holding the
   * policy was excluded, which on a deployment whose administrator had never
   * pressed Save left the operator's own data the single account the policy did
   * not reach -- while the screen counted it as covered. An account whose row
   * already matches costs one comparison and no write, so there is nothing an
   * exception buys.
   *
   * The row is managed: its policy columns are written back whenever they have
   * drifted, which is also how a row left over from when the feature was
   * user-configurable gets brought into line. `lastBackup*` is never touched,
   * and `nextBackupAt` is only armed when absent or cleared when the policy is
   * off, so a reconciled account is not re-backed-up every hour.
   */
  private async reconcileManagedUsers(
    now: Date,
    known?: AutoBackupPolicy,
  ): Promise<void> {
    // Demo data is regenerated daily and every visitor is a separate user, so
    // enrolling them would write throwaway exports for accounts that are about
    // to be deleted.
    if (this.demoMode.isDemo) return;

    // `known` is the policy the caller just wrote. Re-reading it would be a
    // round trip to learn what we are holding, and would reconcile to whatever
    // a concurrent save had left there instead of to the policy this call is
    // applying.
    const policy = known ?? (await this.loadPolicy()).policy;

    // RLS: reading every user and writing rows that are not the caller's is
    // cross-user work by definition.
    const managedUserIds = await withSystemContext(async () => {
      const users = await this.scoped(User, (repo) =>
        repo.find({
          select: { id: true },
          where: { isActive: true },
        }),
      );
      return users.map((u) => u.id);
    });
    if (managedUserIds.length === 0) return;

    const existing = await withSystemContext(() =>
      this.scoped(AutoBackupSettings, (repo) =>
        repo.find({ where: { userId: In(managedUserIds) } }),
      ),
    );
    const byUserId = new Map(existing.map((s) => [s.userId, s]));

    for (const userId of managedUserIds) {
      const current = byUserId.get(userId);
      if (!this.policyHasDrifted(current, policy)) continue;
      try {
        await withUserContext(userId, () =>
          current
            ? this.updatePolicyColumns(
                userId,
                policy,
                now,
                SCHEDULE_FIELDS.some((key) => current[key] !== policy[key]),
              )
            : this.insertManagedRow(userId, policy, now),
        );
        this.logger.log(
          `Reconciled user ${userId} onto the deployment's automatic backup policy`,
        );
      } catch (error) {
        // One user's row failing to reconcile must not stop the others from
        // being reconciled, nor the backups that are already due from running.
        this.logger.error(
          `Failed to reconcile user ${userId} onto the automatic backup policy: ${error.message}`,
        );
      }
    }
  }

  /**
   * Whether this account's row needs writing at all -- so a settled deployment
   * writes nothing on the hourly tick.
   *
   * A missing row under a disabled policy needs none: there is no schedule to
   * record, and a table of disabled rows is not one.
   */
  private policyHasDrifted(
    current: AutoBackupSettings | undefined,
    policy: AutoBackupPolicy,
  ): boolean {
    if (!current) return policy.enabled;
    if (POLICY_FIELDS.some((key) => current[key] !== policy[key])) return true;
    // An armed policy over a row with no next run would never be picked up by
    // the cron; a disarmed one over a row that still has a next run would keep
    // taking backups.
    return policy.enabled
      ? current.nextBackupAt === null
      : current.nextBackupAt !== null;
  }

  /**
   * Write the policy columns of one existing row, and nothing else.
   *
   * A whole-entity `save` was what this used to do, and it wrote back every
   * column of a snapshot read before the loop -- including `next_backup_at`.
   * That column is the cron's **claim** (`claimDueBackup`): a replica that has
   * just claimed a window and begun exporting would have the claim reverted
   * under it by a reconcile carrying the pre-claim value, and the account would
   * be backed up twice. `recordBackupOutcome` already writes only its own
   * columns for the mirror image of this reason.
   *
   * `next_backup_at` is therefore left alone while it holds a value, with two
   * exceptions, both of which are an operator asking for something now. A
   * disabled policy clears it. And `rearm` -- set when a `SCHEDULE_FIELDS`
   * value moved -- replaces it, which cannot revert a claim: the claim's whole
   * property is `next_backup_at > now`, and `calculateNextBackupAt` returns a
   * future slot, so one future value gives way to another and the row stays
   * un-due. Everything else (retention, folder) only fills in a row that has
   * none.
   */
  private async updatePolicyColumns(
    userId: string,
    policy: AutoBackupPolicy,
    now: Date,
    rearm: boolean,
  ): Promise<void> {
    const nextBackupAt = policy.enabled
      ? this.calculateNextBackupAt(
          policy.frequency,
          policy.backupTime,
          policy.timezone,
          now,
        )
      : null;
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE auto_backup_settings
            SET enabled = $2,
                folder_path = $3,
                frequency = $4,
                backup_time = $5,
                timezone = $6,
                retention_daily = $7,
                retention_weekly = $8,
                retention_monthly = $9,
                next_backup_at = CASE
                  WHEN NOT $2 THEN NULL
                  WHEN $11 THEN $10
                  ELSE COALESCE(next_backup_at, $10)
                END,
                updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1`,
        [
          userId,
          policy.enabled,
          policy.folderPath,
          policy.frequency,
          policy.backupTime,
          policy.timezone,
          policy.retentionDaily,
          policy.retentionWeekly,
          policy.retentionMonthly,
          nextBackupAt,
          rearm,
        ],
      ),
    );
  }

  /** Enrol an account that has no row yet, armed from the policy. */
  private async insertManagedRow(
    userId: string,
    policy: AutoBackupPolicy,
    now: Date,
  ): Promise<void> {
    const managed = Object.assign(this.defaultSettingsFor(userId), policy, {
      userId,
      nextBackupAt: policy.enabled
        ? this.calculateNextBackupAt(
            policy.frequency,
            policy.backupTime,
            policy.timezone,
            now,
          )
        : null,
    });
    await this.scoped(AutoBackupSettings, (repo) => repo.save(managed));
  }

  /**
   * Publish one export to the store and describe what was written: the filename,
   * the completeness report the name was chosen from, and the egress digest and
   * size of the exact bytes (`WrittenArtifact`).
   */
  private async exportToStore(
    userId: string,
    location: BackupStoreLocation,
    timezone: string,
  ): Promise<WrittenArtifact> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new BadRequestException(
        tr("errors.backup.userNotFound", `User ${userId} not found`, {
          userId,
        }),
      );
    }

    // Backups are encrypted under the user's backup key whenever the server
    // holds a usable one -- a data key wrapped under their own password, so the
    // file opens with that password -- and there is nothing for them to switch
    // on.
    const resolution = await this.backupEncryption.resolveBackupKey(user);
    if (resolution.status === "unrecoverable") {
      // A key is stored but cannot be decrypted (typically ENCRYPTION_KEY was
      // rotated). Their previous backups are encrypted,
      // so quietly writing this one in plaintext would be a downgrade nobody
      // sees. Fail loud instead.
      throw new BadRequestException(
        tr(
          "errors.backup.encryptedPasswordDecryptFailed",
          "Encrypted backups are enabled but the stored password could not be decrypted. Re-enable encryption in Security settings.",
        ),
      );
    }
    if (resolution.status === "none") {
      // Plaintext is a legitimate outcome -- an OIDC account that set no backup
      // password, or a local account whose password has not been captured yet --
      // but it is never a silent one. Issue #1269 was a deployment writing
      // plaintext for months while every surface said backups were encrypted by
      // default, and a line per backup is what makes that answerable from the
      // logs instead of from the file extension.
      this.logger.warn(
        `Backup for user ${userId} is being written unencrypted: no usable backup key is stored` +
          (user.authProvider === "local"
            ? " (one is made when they next sign in, or from Settings -> Backup & Restore)"
            : " (set a backup password in Settings -> Backup & Restore)"),
      );
    }
    const encryption = resolution.status === "key" ? resolution.key : undefined;

    const dateStr = this.getLocalDateString(new Date(), timezone);
    const ext = encryption ? "mzbe" : "json.gz";

    // Leftovers from an interrupted write, cleared before this one rather than
    // by retention: a partial write is not a backup, so counting it towards
    // "keep 7 daily" would quietly shorten the retention window. A store whose
    // publish has no intermediate state answers 0 and nothing branches on it.
    const removed = await this.store.sweepIncomplete(location, Date.now());
    if (removed > 0) {
      this.logger.warn(
        `Removed ${removed} stale partial backup file(s) in ${location.display}`,
      );
    }

    const { buffer, report } = await this.backupService.exportToBuffer(
      userId,
      encryption,
    );
    // The name is chosen AFTER the export, from what the export found. Choosing
    // it first published an incomplete artifact over that day's complete one and
    // only then noticed -- and `writeFileAtomic` replaces the final name by
    // design, so there was nothing left to preserve by the time
    // `applyBackupOutcome` recorded `partial` (F3RB-001, issue #1069).
    const tier = report.complete ? "daily" : PARTIAL_TIER_NAME;
    const filename = `${BACKUP_FILE_PREFIX}${tier}-${dateStr}.${ext}`;
    // Whole or not at all (INV-BACKUP-006): a write that could truncate the
    // final name first would leave a partial artifact with a valid extension
    // that sorts newest and that retention counts.
    await this.store.publish(location, filename, buffer);

    // Over `buffer`, the bytes the store just published, and not over a re-read
    // of the artifact: a hash of what is under the name now answers a question a
    // concurrent same-day run can already have changed, while the egress digest
    // has to name the artifact this run wrote. The publish has already refused
    // to expose bytes that disagree with the buffer's length, so the two are the
    // same bytes at the moment the name starts referring to them.
    const digest = createHash("sha256").update(buffer).digest("hex");

    this.logger.log(
      `Backup written to ${location.display}/${filename}${encryption ? " (encrypted)" : ""} ` +
        `(sha256 ${digest}, ${buffer.length} bytes)`,
    );
    return { filename, report, digest, sizeBytes: buffer.length };
  }

  /** Returns the copy error's message when the promotion failed, else null. */
  private async copyToWeeklyIfNeeded(
    location: BackupStoreLocation,
    dailyFilename: string,
    timezone: string,
  ): Promise<string | null> {
    const dayOfMonth = this.getLocalDayOfMonth(new Date(), timezone);
    if (!WEEKLY_DAYS.includes(dayOfMonth)) return null;

    const ext = dailyFilename.endsWith(".mzbe") ? "mzbe" : "json.gz";
    const dateStr = this.getLocalDateString(new Date(), timezone);
    const weeklyFilename = `${BACKUP_FILE_PREFIX}weekly-${dateStr}.${ext}`;
    try {
      // All-or-nothing for the same reason as the daily publish: a promotion
      // that could truncate the destination first destroyed last week's artifact
      // and left a partial one named as though it had replaced it.
      await this.store.promote(location, dailyFilename, weeklyFilename);
      this.logger.log(`Copied daily backup to weekly: ${weeklyFilename}`);
    } catch (err) {
      this.logger.warn(`Failed to copy daily to weekly: ${err.message}`);
      return `weekly: ${err.message}`;
    }
    return null;
  }

  /** Returns the copy error's message when the promotion failed, else null. */
  private async copyToMonthlyIfNeeded(
    location: BackupStoreLocation,
    dailyFilename: string,
    timezone: string,
  ): Promise<string | null> {
    const dayOfMonth = this.getLocalDayOfMonth(new Date(), timezone);
    if (dayOfMonth !== MONTHLY_DAY) return null;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "2-digit",
      month: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const ext = dailyFilename.endsWith(".mzbe") ? "mzbe" : "json.gz";
    const monthlyFilename = `${BACKUP_FILE_PREFIX}monthly-${year}-${month}.${ext}`;

    try {
      await this.store.promote(location, dailyFilename, monthlyFilename);
      this.logger.log(`Copied daily backup to monthly: ${monthlyFilename}`);
    } catch (err) {
      this.logger.warn(`Failed to copy daily to monthly: ${err.message}`);
      return `monthly: ${err.message}`;
    }
    return null;
  }

  /**
   * The artifacts the store holds for this location, tagged with the tier and
   * date their names declare.
   *
   * Tier and date come out of the name, never out of the modification time or a
   * settings row -- `backup-file-names.ts` says why, and the owner-facing
   * listing asks it the same way. Anything the store holds that this module did
   * not write is not classified and is therefore never deleted.
   */
  private classifyStoredArtifacts(
    entries: readonly StoredArtifactEntry[],
  ): BackupFile[] {
    const files: BackupFile[] = [];
    for (const entry of entries) {
      const classified = classifyBackupFileName(entry.name);
      if (classified) files.push({ entry, ...classified });
    }
    return files;
  }

  /**
   * Delete backups past the retention limit of their tier, newest kept.
   *
   * The store's `legacy` artifacts are never swept, and never take a slot. On
   * the `local` target those are the flat base folder a version before per-user
   * folders wrote into: the filenames carry no user id, so nothing proves one is
   * this user's, and deleting it could take another owner's only pre-upgrade
   * recovery point (INV-BACKUP-001; `open()` refuses them for the same reason).
   * They are left for an operator to remove, and the pass logs how many remain.
   *
   * `tiers` restricts which tiers may be swept. A partial run passes
   * `["partial"]`: it must bound its own artifacts without being able to delete
   * a complete one, and a tier list is the form of that rule a caller cannot get
   * half right (F3RB-001, issue #1069).
   */
  private async enforceRetention(
    location: BackupStoreLocation,
    settings: AutoBackupSettings,
    tiers: readonly BackupTier[] = ["daily", "weekly", "monthly", "partial"],
  ): Promise<string[]> {
    let files: BackupFile[];
    try {
      files = this.classifyStoredArtifacts(await this.store.list(location));
    } catch (err) {
      // A store that cannot be enumerated is a retention failure, not a backup
      // failure: the artifact this run published is already there. It becomes an
      // admin alert the same way a failed delete does.
      this.logger.warn(`Retention: could not list the store: ${err.message}`);
      return [`listing: ${err.message}`];
    }
    // Returned to the caller so a delete failure can become an admin alert --
    // it has no durable state of its own and the run's status stays "success".
    const failures: string[] = [];

    const legacyCount = files.filter((f) => f.entry.legacy).length;
    if (legacyCount > 0) {
      this.logger.log(
        `Retention: ${legacyCount} legacy flat-folder backup(s) left for an operator to remove`,
      );
    }
    const owned = files.filter((f) => !f.entry.legacy);

    // Sort each tier newest first and delete beyond retention limit
    const deleteExcess = async (tier: BackupTier, limit: number) => {
      if (!tiers.includes(tier)) return;
      const sorted = owned
        .filter((f) => f.tier === tier)
        .sort((a, b) => b.date.getTime() - a.date.getTime());
      for (let i = limit; i < sorted.length; i++) {
        const { entry } = sorted[i];
        try {
          await this.store.remove(location, entry);
          this.logger.log(`Retention: deleted old backup ${entry.name}`);
        } catch (err) {
          this.logger.warn(
            `Retention: failed to delete ${entry.name}: ${err.message}`,
          );
          failures.push(`${entry.name}: ${err.message}`);
        }
      }
    };

    await deleteExcess("daily", settings.retentionDaily);
    await deleteExcess("weekly", settings.retentionWeekly);
    await deleteExcess("monthly", settings.retentionMonthly);
    // Partial artifacts are kept to the same depth as complete dailies, in their
    // own tier: they arrive on the same cadence, so the daily count is already
    // the user's answer to "how many recovery points of that age do I want", and
    // a separate setting would be a migration and a fourth number in the UI for a
    // question nobody has asked. What matters is that the two counts are
    // *independent* -- a partial can neither take a complete artifact's slot nor
    // accumulate without bound while storage is broken.
    await deleteExcess(PARTIAL_TIER_NAME, settings.retentionDaily);
    return failures;
  }

  private getLocalDateString(date: Date, timezone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  }

  private getLocalDayOfMonth(date: Date, timezone: string): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      day: "numeric",
    });
    return Number(formatter.format(date));
  }

  private calculateNextBackupAt(
    frequency: AutoBackupFrequency,
    backupTime: string,
    timezone: string,
    fromDate: Date,
  ): Date {
    const [hours] = backupTime.split(":").map(Number);
    const intervalHours = FREQUENCY_HOURS[frequency] ?? 24;

    // Snap minutes to 0 -- the cron fires at minute 0 of each hour,
    // so non-zero minutes would cause the backup to run an hour late.
    const todayInTz = this.localTimeToUtc(fromDate, hours, 0, timezone);

    if (frequency === "daily" || frequency === "weekly") {
      const next = new Date(todayInTz);

      // If the target time is in the past for today, move forward by one interval
      if (next.getTime() <= fromDate.getTime()) {
        next.setTime(next.getTime() + intervalHours * 60 * 60 * 1000);
      }
      return next;
    }

    // Sub-daily frequencies (every6hours, every12hours):
    // Align to the configured time, then add interval increments
    let next = new Date(todayInTz);
    while (next.getTime() <= fromDate.getTime()) {
      next = new Date(next.getTime() + intervalHours * 60 * 60 * 1000);
    }
    return next;
  }

  /**
   * Convert a local time (hours:minutes) in the given timezone to a UTC Date
   * for the same calendar day as `referenceDate`.
   */
  private localTimeToUtc(
    referenceDate: Date,
    hours: number,
    minutes: number,
    timezone: string,
  ): Date {
    // Get the current date parts in the target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(referenceDate);
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const day = parts.find((p) => p.type === "day")!.value;

    // Build an ISO string representing the local time in the timezone,
    // then compute the UTC equivalent by finding the offset
    const localIso = `${year}-${month}-${day}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

    // Use the timezone offset at that specific moment to convert to UTC
    const offsetMs = this.getTimezoneOffsetMs(localIso, timezone);
    return new Date(new Date(localIso + "Z").getTime() - offsetMs);
  }

  /**
   * Get the UTC offset in milliseconds for a given local datetime in a timezone.
   */
  private getTimezoneOffsetMs(localIso: string, timezone: string): number {
    const utcDate = new Date(localIso + "Z");
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(utcDate);
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    const localAtUtc = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`;
    return new Date(localAtUtc).getTime() - utcDate.getTime();
  }
}

/**
 * The UTC calendar day, as the daily bucket in a system-alert dedupe key. UTC
 * rather than the user's backup timezone on purpose: the key only has to be
 * the same on every replica, and replicas share a clock, not a user timezone
 * lookup.
 */
function utcDateString(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The retention tier a *published* artifact's name declares, or `null` for a
 * `partial-` one and for anything this module did not write.
 *
 * `BackupOffsiteTier` is the narrower of the two vocabularies -- the off-site
 * table's CHECK constraint admits only the three published tiers -- so this is
 * where the wider one is narrowed, once, rather than at each call site.
 */
function publishedOffsiteTier(filename: string): BackupOffsiteTier | null {
  const classified = classifyBackupFileName(filename);
  if (!classified || classified.tier === PARTIAL_TIER_NAME) return null;
  return classified.tier;
}
