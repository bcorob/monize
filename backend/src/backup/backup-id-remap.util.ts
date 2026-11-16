/**
 * Shared UUID-remap walker for backup payloads, used by the restore path
 * (BackupService) and the de-identified support export (SupportBackupService).
 * Extracted so the two can't drift: the caveats encoded here -- only genuine
 * row-id UUIDs enter the map (bigint ids share their string form with
 * unrelated values and must never be remapped), and ids embedded inside JSONB
 * values must be rewritten too -- apply to both consumers.
 */

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical UUID string length; cheap pre-filter before the Map lookup. */
const UUID_LENGTH = 36;

/**
 * Every spelling PostgreSQL's `uuid` input accepts, once an optional pair of
 * braces is removed: 32 hex digits in either case, with an optional hyphen after
 * any group of four. `UUID_REGEX` accepts only the hyphenated 8-4-4-4-12 form,
 * so a value in any of the others is a UUID to the database and not to a walker
 * that tests it with `UUID_REGEX`.
 */
const PG_UUID_INPUT = /^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i;

/**
 * The canonical form (lowercase, hyphenated 8-4-4-4-12) of a string PostgreSQL
 * would accept as a `uuid`, or `null` when it would not.
 *
 * Anything that decides whether an uploaded identifier is "one of ours" has to
 * compare canonical forms: the database stores and compares the 128-bit value,
 * so `A0EEBC99...`, `a0eebc999c0b4ef8...` and `{a0eebc99-...}` all name the row
 * `a0eebc99-9c0b-4ef8-...` does, and a check keyed on the spelling is a check a
 * different spelling walks past.
 */
export function canonicalUuid(value: unknown): string | null {
  // 32 digits, at most seven hyphens, and a pair of braces.
  if (typeof value !== "string" || value.length > 41) return null;
  let body = value;
  if (body.startsWith("{")) {
    if (!body.endsWith("}")) return null;
    body = body.slice(1, -1);
  }
  if (!PG_UUID_INPUT.test(body)) return null;
  const hex = body.replace(/-/g, "").toLowerCase();
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Adds every row's `id` (when it is a UUID) to the remap with a value from
 * `freshId`. Non-UUID ids (e.g. BIGSERIAL) are skipped -- the database assigns
 * fresh values on insert, and remapping them here would clobber unrelated
 * bigint values sharing the same string form.
 */
export function collectRowIdRemap(
  rows: Iterable<Record<string, unknown>>,
  remap: Map<string, string>,
  freshId: () => string,
): void {
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = row.id;
    if (typeof id === "string" && UUID_REGEX.test(id) && !remap.has(id)) {
      remap.set(id, freshId());
    }
  }
}

/**
 * Recursively rewrites any string that matches a remapped id. Recurses into
 * arrays and plain objects (e.g. JSONB columns) so ids nested inside JSON are
 * remapped too. Because the remap only contains genuine backup primary keys
 * (random UUIDs), non-id strings such as names or memos are left untouched;
 * the length pre-check skips the Map lookup for the vast majority of values
 * (dates, labels, enums).
 */
export function deepRemapIds(
  value: unknown,
  remap: Map<string, string>,
): unknown {
  if (typeof value === "string") {
    if (value.length !== UUID_LENGTH) return value;
    return remap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRemapIds(item, remap));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        deepRemapIds(val, remap),
      ]),
    );
  }
  return value;
}
