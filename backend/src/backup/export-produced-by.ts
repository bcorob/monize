import {
  compareMigrationFilenames,
  parseMigrationPrefix,
} from "../common/db/migration-filename";
import { BackupProducedBy } from "./backup-format";
import { ExportReader } from "./export-cursor";

/**
 * Whether the migration ledger exists here. `$1` is the exporting user, bound by
 * the reader to every query and compared with itself so the statement uses it;
 * the ledger holds nothing per user. A database built from entity metadata alone
 * (some test harnesses) has no ledger, and a failed `SELECT` would abort the
 * export's whole snapshot transaction, so the table is asked about first.
 */
const LEDGER_PRESENT_SQL = `
  SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present,
         $1::text IS NOT NULL AS bound`;

/**
 * Every applied migration filename. A few hundred short rows at most, so a
 * whole-result read is bounded by the number of migrations the repository has
 * ever shipped, never by the user's data. The runtime role may `SELECT` it
 * (`RUNTIME_READ_ONLY_TABLES`); it holds no write grant and none is needed.
 */
const APPLIED_MIGRATIONS_SQL = `
  SELECT filename FROM schema_migrations WHERE $1::text IS NOT NULL`;

/**
 * The `producedBy` document member, read in the export's snapshot: the newest
 * applied migration by `compareMigrationFilenames` (numeric on the prefix; a
 * string sort would rank a historical `NNN_` name wrongly), or `null` when the
 * ledger is absent or lists nothing orderable. `null` says "not known", which a
 * restore must not read as either old or current.
 */
export async function readProducedBy(
  reader: ExportReader,
): Promise<BackupProducedBy> {
  const [ledger] = await reader.read(LEDGER_PRESENT_SQL);
  if (ledger?.present !== true) return { schemaMigration: null };

  const names = (await reader.read(APPLIED_MIGRATIONS_SQL))
    .map((row) => row.filename)
    .filter(
      (name): name is string =>
        typeof name === "string" && parseMigrationPrefix(name) !== null,
    );
  if (names.length === 0) return { schemaMigration: null };
  return {
    schemaMigration: names.reduce((newest, name) =>
      compareMigrationFilenames(name, newest) > 0 ? name : newest,
    ),
  };
}
