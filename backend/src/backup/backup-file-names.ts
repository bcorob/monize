/**
 * What an automatic-backup filename says about the artifact it names.
 *
 * A file's name is its identity here: the tier it is retained under and the day
 * it covers are read back out of the name, because a rescan after a restart --
 * or on another machine entirely -- has no settings row to consult, and an
 * encrypted artifact's envelope is inside the ciphertext (see
 * `docs/backend/backup.md`). Retention and the owner-facing listing both ask
 * that same question, so it is answered in one place rather than once per
 * caller.
 */

/** Retention tier an artifact belongs to, decided by its name alone. */
export type BackupTier = "daily" | "weekly" | "monthly" | "partial";

/**
 * The tier a partial artifact is published under. Its own tier so it can never
 * occupy a complete artifact's retention slot (F3RB-001, issue #1069).
 */
export const PARTIAL_TIER_NAME = "partial";

export const BACKUP_FILE_PREFIX = "monize-backup-";

// File extensions: .json.gz for unencrypted, .mzbe for encrypted Monize
// backups. Both are matched everywhere a name is classified, so a legacy and an
// encrypted artifact are enumerated the same way.
const DAILY_FILE_PATTERN =
  /^monize-backup-daily-(\d{4}-\d{2}-\d{2})\.(json\.gz|mzbe)$/;
const WEEKLY_FILE_PATTERN =
  /^monize-backup-weekly-(\d{4}-\d{2}-\d{2})\.(json\.gz|mzbe)$/;
const MONTHLY_FILE_PATTERN =
  /^monize-backup-monthly-(\d{2}-\d{2})\.(json\.gz|mzbe)$/;
/**
 * An artifact that could not include every attachment it names. Its own tier,
 * and deliberately not `daily-` -- see `PARTIAL_TIER_NAME`.
 */
const PARTIAL_FILE_PATTERN =
  /^monize-backup-partial-(\d{4}-\d{2}-\d{2})\.(json\.gz|mzbe)$/;

function parseDateString(ds: string): Date | null {
  const date = new Date(ds + "T00:00:00Z");
  return isNaN(date.getTime()) ? null : date;
}

function parseYearMonthString(ym: string): Date | null {
  const date = new Date(`20${ym}-01T00:00:00Z`);
  return isNaN(date.getTime()) ? null : date;
}

/** The tier and covered date a backup filename declares. */
export interface ClassifiedBackupFile {
  tier: BackupTier;
  /** The day (or month) the artifact covers, from its name -- not its mtime. */
  date: Date;
}

/**
 * Classify one directory entry, or `null` when the name is not an artifact this
 * module wrote.
 *
 * `null` is the answer for a temp file, a legacy name with no parseable date,
 * and anything else that happens to share the directory. Callers treat it as
 * "not a backup": retention will not delete it and the owner-facing listing
 * will not offer it.
 */
export function classifyBackupFileName(
  name: string,
): ClassifiedBackupFile | null {
  const dated: [RegExp, BackupTier][] = [
    [DAILY_FILE_PATTERN, "daily"],
    [WEEKLY_FILE_PATTERN, "weekly"],
    [PARTIAL_FILE_PATTERN, PARTIAL_TIER_NAME],
  ];
  for (const [pattern, tier] of dated) {
    const match = pattern.exec(name);
    if (match) {
      const date = parseDateString(match[1]);
      return date ? { tier, date } : null;
    }
  }
  const monthly = MONTHLY_FILE_PATTERN.exec(name);
  if (monthly) {
    const date = parseYearMonthString(monthly[1]);
    return date ? { tier: "monthly", date } : null;
  }
  return null;
}

/**
 * Whether an artifact is an encrypted Monize envelope, from its name.
 *
 * The bytes are authoritative (the envelope's `MZBE` magic), but a listing that
 * has not opened the file has only the name -- and the name is written by the
 * same code that chose the encryption, so the two cannot disagree for a file
 * this module produced.
 */
export function isEncryptedBackupFileName(name: string): boolean {
  return name.endsWith(".mzbe");
}
