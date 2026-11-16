/**
 * The one place a migration filename is parsed and ordered.
 *
 * Two prefix forms coexist in `database/migrations/` (issue #1277):
 *
 *  - `NNN_description.sql` -- the retired sequential scheme. Every file that
 *    carried it is historical: `schema_migrations` keys on the filename, so
 *    renaming one would re-run it on every deployed database. The set is
 *    frozen, and `LEGACY_PREFIX_CEILING` is the highest number it ever issued.
 *  - `YYYYMMDDHHMMSS_description.sql` -- the UTC second the migration was
 *    authored. Two authors cannot pick the same second, so a collision is not
 *    a rule anyone polices; it is arithmetically unavailable. The number is
 *    known before a PR exists (`date -u +%Y%m%d%H%M%S`).
 *
 * The runner, the test harnesses and the CI scripts all order migrations by
 * the NUMERIC value of that prefix, then by the full filename. A string sort
 * agrees with that order today only by a coincidence of digits: every
 * historical prefix begins with 0 or 1 and every timestamp with 2, so 191_
 * still sorts before 2026. Issue #1277 first considered a five-digit band
 * scheme, under which 13120_ would have sorted before 168_ and a fresh install
 * would have applied every new migration ahead of the whole history; a
 * three-digit prefix from 203 upward would break the timestamp scheme the same
 * way. Ordering by value makes the apply order a fact about numbers rather
 * than about leading digits, and `migration-filename.spec.ts` holds a fixture
 * a string sort gets wrong.
 *
 * The repository scripts (`scripts/check-migration-prefixes.mjs`,
 * `backend/scripts/migration-lint.mjs`) load this module through
 * `scripts/lib/migration-filename.mjs`, which relies on Node's type stripping,
 * so it must stay free of runtime imports and of TypeScript syntax that needs
 * a compiler (enums, parameter properties, namespaces).
 */

/** Width of the retired sequential prefix (`191_payee_lookup_ai_enabled.sql`). */
export const LEGACY_PREFIX_WIDTH = 3;

/** Width of a `YYYYMMDDHHMMSS` prefix. */
export const TIMESTAMP_PREFIX_WIDTH = 14;

/**
 * The highest sequential prefix ever issued. Frozen at adoption of the
 * timestamp scheme: a three-digit prefix above it is a new migration written
 * under the retired scheme, and `check-migration-prefixes.mjs` refuses it
 * whether or not a base branch is available to compare against.
 * `migration-filename.spec.ts` holds this against the directory in both
 * directions.
 */
export const LEGACY_PREFIX_CEILING = 191;

/**
 * The UTC instant the timestamp scheme was adopted, as a prefix value. A
 * timestamp before it is a typo (the wrong year, most likely), not a migration
 * authored before the scheme existed -- those all carry three digits.
 */
export const TIMESTAMP_SCHEME_ADOPTED = 20260905000000;

/**
 * One regular expression for both forms, anchored on the underscore that ends
 * the prefix. A four- or thirteen-digit prefix matches neither branch and is
 * refused everywhere rather than ordered somewhere surprising.
 */
const PREFIX_PATTERN = new RegExp(
  `^(\\d{${LEGACY_PREFIX_WIDTH}}|\\d{${TIMESTAMP_PREFIX_WIDTH}})_`,
);

export interface MigrationPrefix {
  kind: "legacy" | "timestamp";
  /** The prefix's numeric value. Both widths fit a double exactly. */
  value: number;
  /** The prefix as written, zero padding included. */
  text: string;
}

/**
 * The prefix of a migration filename, or `null` when the name carries neither
 * form. The `.sql` extension is not checked here: callers filter on it first,
 * and the check script wants to report a misnamed `.sql` file, not skip it.
 */
export function parseMigrationPrefix(name: string): MigrationPrefix | null {
  const match = PREFIX_PATTERN.exec(name);
  if (!match) return null;
  const text = match[1];
  return {
    kind: text.length === LEGACY_PREFIX_WIDTH ? "legacy" : "timestamp",
    value: Number(text),
    text,
  };
}

/**
 * The UTC instant a timestamp prefix names, or `null` when the fourteen digits
 * do not spell a real date and time (month 13, 30 February, hour 24). The
 * round trip through `Date.UTC` is what rejects those: JavaScript normalizes an
 * out-of-range component instead of refusing it, so the components are read
 * back and compared.
 */
export function timestampPrefixToDate(text: string): Date | null {
  if (!/^\d{14}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const hour = Number(text.slice(8, 10));
  const minute = Number(text.slice(10, 12));
  const second = Number(text.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? date : null;
}

/** A `YYYYMMDDHHMMSS` prefix for the given instant, in UTC. */
export function timestampPrefixFor(date: Date): string {
  return date.toISOString().replace(/\D/g, "").slice(0, TIMESTAMP_PREFIX_WIDTH);
}

/**
 * Numeric prefix order, then full-filename order. The tiebreak exists for the
 * six historical pairs (`022`, `068`, `075`, `116`, `117`, `124`), whose apply
 * order has always been alphabetical and must stay so -- a deployed database
 * recorded them in that order. Names that do not parse are not compared here;
 * `orderMigrations` refuses them before sorting.
 */
export function compareMigrationFilenames(a: string, b: string): number {
  const pa = parseMigrationPrefix(a);
  const pb = parseMigrationPrefix(b);
  if (!pa || !pb) {
    throw new Error(
      `cannot order migration filename ${JSON.stringify(!pa ? a : b)}: ` +
        "expected NNN_description.sql (historical) or YYYYMMDDHHMMSS_description.sql",
    );
  }
  if (pa.value !== pb.value) return pa.value - pb.value;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The migration filenames in apply order. Throws on a name that carries
 * neither prefix form, so a stray file fails the run loudly instead of being
 * applied at whatever position a string sort gave it. Does not mutate `names`.
 */
export function orderMigrations(names: readonly string[]): string[] {
  for (const name of names) {
    if (!parseMigrationPrefix(name)) {
      throw new Error(
        `cannot order migration filename ${JSON.stringify(name)}: ` +
          "expected NNN_description.sql (historical) or YYYYMMDDHHMMSS_description.sql",
      );
    }
  }
  return [...names].sort(compareMigrationFilenames);
}
