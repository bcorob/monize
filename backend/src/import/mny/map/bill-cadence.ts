import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { FREQUENCY_CYCLE_DAYS } from "../../../common/recurrence";

/**
 * A bill series' cadence read from its own instance dates.
 *
 * `BILL` is an accumulation of instances -- one row per occurrence -- so a
 * series carries its own answer to "how often": the spacing between
 * consecutive `dt` values. That is evidence from the file in front of us,
 * where `BILL.frq` is a code this repository has never been able to observe
 * (`MNY_FREQUENCY` explains what is known and how). Issue #1150 is what the
 * difference costs: a table entry taken on trust turned yearly bills into
 * bimonthly ones, and every one of those files said "365 days apart" in data
 * nothing was reading.
 *
 * So the mapper asks the dates first and the code second. Where the two agree
 * this changes nothing; where they disagree the dates win, because a code
 * table is a claim about Money and the dates are the user's bill.
 */

/**
 * Mean days in one cycle of each frequency.
 *
 * An alias for `FREQUENCY_CYCLE_DAYS`, not a copy: `map-bills.ts` derives its
 * activity horizon from it, `mny-model.ts` matches Money's recurrence codes
 * against it, and this module matches observed instance spacing against it --
 * three readers, one list of cycle lengths.
 */
export const CADENCE_DAYS: Record<FrequencyType, number> = FREQUENCY_CYCLE_DAYS;

/**
 * How far an observed gap may sit from a cadence and still be read as it.
 *
 * Matching is by ratio rather than by difference so the short periods are not
 * swallowed by the long ones: 12% of a week is a day, 12% of a year is six
 * weeks. The pairs this has to keep apart are the close ones -- 28 days versus
 * a calendar month (9%), a fortnight versus twice a month (9%) -- so the
 * nearest match wins and the tolerance only decides whether *anything*
 * matches.
 */
const CADENCE_TOLERANCE = 1.12;

/**
 * Instances read back from the newest end of a series. A series can run for
 * decades, and a bill whose frequency the user changed should be imported as
 * what it is now, not as the average of its history.
 */
const MAX_SAMPLED_INSTANCES = 13;

/** Minimum gaps -- two instances is a coincidence, three is a cadence. */
const MIN_GAPS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two `YYYY-MM-DD` dates, or null if either is unusable. */
function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.round((end - start) / MS_PER_DAY);
}

/** The frequency whose cycle is closest to `days`, by ratio, or null. */
export function cadenceForGap(days: number): FrequencyType | null {
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }

  let best: FrequencyType | null = null;
  let bestRatio = Number.POSITIVE_INFINITY;
  for (const [frequency, cycle] of Object.entries(CADENCE_DAYS)) {
    if (cycle <= 0) {
      continue;
    }
    const ratio = days > cycle ? days / cycle : cycle / days;
    if (ratio < bestRatio) {
      best = frequency as FrequencyType;
      bestRatio = ratio;
    }
  }
  return bestRatio <= CADENCE_TOLERANCE ? best : null;
}

/**
 * The cadence a series' instance dates agree on, or null when they do not.
 *
 * A strict majority of the sampled gaps has to read as the same frequency.
 * That is what makes a skipped occurrence harmless -- it produces one doubled
 * gap, which either matches a different frequency or matches nothing -- while
 * still refusing to answer for a series whose dates are simply irregular.
 * Refusing is not a failure here: the caller falls back to `BILL.frq`.
 */
export function inferFrequencyFromDueDates(
  dates: readonly (string | null)[],
): FrequencyType | null {
  const sampled = [...new Set(dates.filter((date): date is string => !!date))]
    .sort()
    .slice(-MAX_SAMPLED_INSTANCES);

  const gaps = sampled
    .slice(1)
    .map((date, index) => daysBetween(sampled[index], date))
    .filter((days): days is number => days !== null);
  if (gaps.length < MIN_GAPS) {
    return null;
  }

  const votes = new Map<FrequencyType, number>();
  for (const gap of gaps) {
    const cadence = cadenceForGap(gap);
    if (cadence !== null) {
      votes.set(cadence, (votes.get(cadence) ?? 0) + 1);
    }
  }

  const [winner, count] = [...votes.entries()].reduce<
    [FrequencyType | null, number]
  >((best, entry) => (entry[1] > best[1] ? entry : best), [null, 0]);
  return count * 2 > gaps.length ? winner : null;
}
