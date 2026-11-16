import { QueryFailedError } from "typeorm";

/**
 * A transaction's `externalId` is the API caller's own key for a row it
 * created (issue #1713): a create that repeats a key returns the row that
 * already holds it instead of writing a second one, so a client whose request
 * timed out can retry without knowing whether the first attempt committed.
 *
 * An OFX import stores each row's bank id under the same column
 * (`import/ofx-external-id.ts`) and skips a row whose key the account already
 * holds, so a download that overlaps an earlier one adds only the new rows.
 *
 * The guarantee is the partial unique index below, one row per
 * `(account_id, external_id)`, the same shape bank sync uses for the rows it
 * imports. The lookup each create path makes before its insert is advisory: it
 * only lets the common retry answer with the existing row without a failed
 * insert. Two concurrent creates with one key both miss it, the index refuses
 * the second, and that path re-reads the winner (`isExternalIdConflict`).
 */
export const EXTERNAL_ID_MAX_LENGTH = 255;

/** The partial unique index on `transactions(account_id, external_id)`. */
export const EXTERNAL_ID_INDEX = "idx_transactions_account_external_id";

const UNIQUE_VIOLATION = "23505";

/**
 * True when `error` is the unique violation of {@link EXTERNAL_ID_INDEX}.
 * Matched by name, so a violation of some other constraint is never answered
 * with "here is the row you already created".
 */
export function isExternalIdConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as
    { code?: string; constraint?: string } | undefined;
  return (
    driver?.code === UNIQUE_VIOLATION &&
    driver?.constraint === EXTERNAL_ID_INDEX
  );
}
