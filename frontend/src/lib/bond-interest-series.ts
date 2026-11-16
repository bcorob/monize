import type { BondRateScheduleEntry } from '@/types/bond';

/** One period end of a lot: the interest earned so far, for the whole holding. */
export interface BondInterestPoint {
  index: number;
  /** The period end, YYYY-MM-DD. */
  end: string;
  /** The period's rate is a projection, not a known or announced one. */
  projected: boolean;
  /** Cumulative interest by what earned it, in currency units. */
  fixed: number;
  margin: number;
  inflation: number;
  announced: number;
}

export interface BondInterestSeries {
  /** The periods whose interest is known, up to the first that is not. */
  points: BondInterestPoint[];
  /** The first period whose interest is unknown; the series stops before it. */
  unknownFromPeriod: number | null;
  /** Some period's interest was announced, so the chart has that series. */
  hasAnnounced: boolean;
}

const TEN_THOUSANDTHS = 10000;

/**
 * A per-bond part as whole ten-thousandths of the holding: the part times the
 * quantity, rounded once, so a running total is a sum of integers (AGENTS.md,
 * financial math) and is divided once on the way out.
 */
function holdingUnits(part: string, quantity: number): number {
  return Math.round(Number(part) * quantity * TEN_THOUSANDTHS);
}

/**
 * The cumulative interest of a lot at each period end (spec 13.4), summed from
 * the per-period parts the server attributed (13.2) and never recomputed from a
 * rate. A period with an unknown part ends the series: a later total would be a
 * subtotal under a total's name, and `null` is not zero.
 */
export function buildBondInterestSeries(
  schedule: readonly BondRateScheduleEntry[],
  quantity: number,
): BondInterestSeries {
  const points: BondInterestPoint[] = [];
  let fixed = 0;
  let margin = 0;
  let inflation = 0;
  let announced = 0;
  let hasAnnounced = false;
  for (const entry of schedule) {
    if (
      entry.fixedPart === null ||
      entry.addendPart === null ||
      entry.benchmarkPart === null ||
      entry.announcedPart === null
    ) {
      return { points, unknownFromPeriod: entry.index, hasAnnounced };
    }
    fixed += holdingUnits(entry.fixedPart, quantity);
    margin += holdingUnits(entry.addendPart, quantity);
    inflation += holdingUnits(entry.benchmarkPart, quantity);
    const announcedNow = holdingUnits(entry.announcedPart, quantity);
    announced += announcedNow;
    if (announcedNow !== 0) hasAnnounced = true;
    points.push({
      index: entry.index,
      end: entry.end,
      projected: entry.rateSource === 'PROJECTED',
      fixed: fixed / TEN_THOUSANDTHS,
      margin: margin / TEN_THOUSANDTHS,
      inflation: inflation / TEN_THOUSANDTHS,
      announced: announced / TEN_THOUSANDTHS,
    });
  }
  return { points, unknownFromPeriod: null, hasAnnounced };
}
