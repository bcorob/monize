import { daysBetween } from "./price-boundary.util";

/**
 * The **explicitly approximate** counterpart to `closeAt`: the stored
 * observation nearest a date, in either direction, carried with the date it was
 * struck on.
 *
 * `docs/time-series-contract.md` section 2.1 bans a nearest-observation lookup
 * with no age test *outside this module*, and that ban stands -- a value-for-a-
 * date is `closeAt` and nothing else. What this module answers is a different
 * question, asked by exactly one surface (the Account Balances report, section
 * 4.2 / 7.2 of `docs/specs/account-balances-as-of.md`): when the database has
 * nothing inside the window and the provider could not fill it, what is the
 * closest thing anybody ever observed?
 *
 * The date travels with the number for the same reason the report's `asOfDate`
 * travels with its figures: a bare price cannot be told from one struck on the
 * day asked about, so a caller handed only the number would present an
 * approximation as a measurement. Every consumer of this module has to carry
 * the observation date through to the user, and the report's
 * `approximatedDisplayRates` / `approximatedPriceCount` are that carriage.
 *
 * It lives beside the bounded door rather than in the report because it is the
 * same concern -- turning a stored observation into a figure for a date -- and
 * two implementations of that is what section 2.1 exists to prevent.
 */

/** One stored observation: the date it was struck on, and its value. */
export interface DatedObservation {
  date: string;
  value: number;
}

/** Runs a parameterized read. The caller supplies its own RLS-scoped door. */
export type ObservationQuery = <T>(
  sql: string,
  params: unknown[],
) => Promise<T[]>;

/**
 * The candidate nearest `date`, measured in whole days either side.
 *
 * A tie goes to the **earlier** observation: it is a close that had already
 * been struck when the date arrived, where the later one is a price the date
 * could not have known. Nothing else distinguishes them.
 */
export function nearestObservation(
  candidates: ReadonlyArray<DatedObservation>,
  date: string,
): DatedObservation | null {
  let best: DatedObservation | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(daysBetween(candidate.date, date));
    // Strictly closer, or the same distance from before the date -- candidates
    // arrive in no guaranteed order, so the tie is decided on the dates
    // themselves rather than on which row the database returned first.
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== null && candidate.date < best.date)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The closest stored close to `date` for each security, in either direction.
 *
 * Absent from the map means the security has no stored close at all -- which
 * stays unpriced, because this fills a gap in *coverage* and never invents an
 * observation nobody made.
 */
export async function nearestClosesFor(
  runQuery: ObservationQuery,
  securityIds: ReadonlyArray<string>,
  date: string,
): Promise<Map<string, DatedObservation>> {
  if (securityIds.length === 0) return new Map();

  const rows = await runQuery<{
    security_id: string;
    price_date: string;
    close_price: string;
  }>(
    `SELECT s.security_id::text AS security_id,
            p.price_date::text AS price_date,
            p.close_price
       FROM unnest($1::uuid[]) AS s(security_id)
       CROSS JOIN LATERAL (
         (SELECT sp.price_date, sp.close_price
            FROM security_prices sp
           WHERE sp.security_id = s.security_id
             AND sp.price_date <= $2::date
           ORDER BY sp.price_date DESC
           LIMIT 1)
         UNION ALL
         (SELECT sp.price_date, sp.close_price
            FROM security_prices sp
           WHERE sp.security_id = s.security_id
             AND sp.price_date > $2::date
           ORDER BY sp.price_date ASC
           LIMIT 1)
       ) p`,
    [securityIds, date],
  );

  const candidates = new Map<string, DatedObservation[]>();
  for (const row of rows) {
    const point = {
      date: row.price_date.slice(0, 10),
      value: Number(row.close_price),
    };
    // A close of zero or less is not a price; it is a row that says nothing,
    // and substituting it would report a held position as worthless.
    if (!Number.isFinite(point.value) || point.value <= 0) continue;
    const existing = candidates.get(row.security_id);
    if (existing) existing.push(point);
    else candidates.set(row.security_id, [point]);
  }

  const nearest = new Map<string, DatedObservation>();
  for (const [securityId, points] of candidates) {
    const point = nearestObservation(points, date);
    if (point) nearest.set(securityId, point);
  }
  return nearest;
}

/**
 * The closest stored rate to `date` for each wanted pair, keyed by the
 * direction it is **stored** in (`"USD->CAD"`).
 *
 * Both directions are searched and the nearer one wins, because a pair stored
 * only in reverse is the same observation seen from the other side --
 * `convertWithRateLookup` is what turns it back around, exactly as it does for
 * a rate inside the window.
 */
export async function nearestRatesFor(
  runQuery: ObservationQuery,
  pairs: ReadonlyArray<{ from: string; to: string }>,
  date: string,
): Promise<Map<string, DatedObservation>> {
  const wanted = pairs.filter((p) => p.from && p.to && p.from !== p.to);
  if (wanted.length === 0) return new Map();

  const rows = await runQuery<{
    stored_from: string;
    stored_to: string;
    rate_date: string;
    rate: string;
  }>(
    `SELECT r.from_currency AS stored_from,
            r.to_currency AS stored_to,
            r.rate_date::text AS rate_date,
            r.rate
       FROM unnest($1::text[], $2::text[]) AS w(from_currency, to_currency)
       CROSS JOIN LATERAL (
         (SELECT er.from_currency, er.to_currency, er.rate_date, er.rate
            FROM exchange_rates er
           WHERE ((er.from_currency = w.from_currency AND er.to_currency = w.to_currency)
               OR (er.from_currency = w.to_currency AND er.to_currency = w.from_currency))
             AND er.rate_date <= $3::date
           ORDER BY er.rate_date DESC
           LIMIT 1)
         UNION ALL
         (SELECT er.from_currency, er.to_currency, er.rate_date, er.rate
            FROM exchange_rates er
           WHERE ((er.from_currency = w.from_currency AND er.to_currency = w.to_currency)
               OR (er.from_currency = w.to_currency AND er.to_currency = w.from_currency))
             AND er.rate_date > $3::date
           ORDER BY er.rate_date ASC
           LIMIT 1)
       ) r`,
    [wanted.map((p) => p.from), wanted.map((p) => p.to), date],
  );

  const candidates = new Map<string, DatedObservation[]>();
  for (const row of rows) {
    const key = `${row.stored_from}->${row.stored_to}`;
    const point = {
      date: row.rate_date.slice(0, 10),
      value: Number(row.rate),
    };
    // Zero and negative are absent, not applicable -- the same reading
    // `convertWithRateLookup` gives them.
    if (!Number.isFinite(point.value) || point.value <= 0) continue;
    const existing = candidates.get(key);
    if (existing) existing.push(point);
    else candidates.set(key, [point]);
  }

  // Each direction is reduced on its own, then the wanted pair takes whichever
  // direction observed the date more closely: two stored directions of one pair
  // are two observations of it, and the report converts with the nearer.
  const perDirection = new Map<string, DatedObservation>();
  for (const [key, points] of candidates) {
    const point = nearestObservation(points, date);
    if (point) perDirection.set(key, point);
  }

  const nearest = new Map<string, DatedObservation>();
  for (const pair of wanted) {
    const direct = perDirection.get(`${pair.from}->${pair.to}`);
    const reverse = perDirection.get(`${pair.to}->${pair.from}`);
    const chosen = nearestObservation(
      [direct, reverse].filter((p): p is DatedObservation => p != null),
      date,
    );
    if (!chosen) continue;
    const key =
      direct && chosen.date === direct.date && chosen.value === direct.value
        ? `${pair.from}->${pair.to}`
        : `${pair.to}->${pair.from}`;
    nearest.set(key, chosen);
  }
  return nearest;
}
