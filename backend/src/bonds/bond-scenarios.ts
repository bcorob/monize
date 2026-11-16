import { BondLotsRefusal } from "./bond-lots";
import { ExactDecimal } from "./domain/exact-decimal";
import { BondValuation, RateScheduleEntry } from "./engine/bond-engine";

/** One assumed benchmark value and the figures it gives over the open lots (spec 13.3). */
export interface BondScenario {
  /** The assumed value as given, a fraction. */
  readonly value: string;
  readonly maturityValue: string | null;
  readonly totalInterest: string | null;
  readonly fixedInterest: string | null;
  readonly benchmarkInterest: string | null;
  readonly addendInterest: string | null;
  readonly announcedInterest: string | null;
}

export interface BondScenarios {
  readonly securityId: string;
  readonly benchmarkId: string;
  readonly asOf: string;
  /** Set when the lots cannot be derived; every figure is then null. */
  readonly refusal: BondLotsRefusal | null;
  readonly scenarios: readonly BondScenario[];
}

type PartOf = (entry: RateScheduleEntry) => string | null;

/** Per bond over every period of the lot; null when any period's part is unknown. */
function perBondSum(
  valuation: BondValuation,
  part: PartOf,
): ExactDecimal | null {
  let total = ExactDecimal.ZERO;
  for (const entry of valuation.rateSchedule) {
    const figure = part(entry);
    if (figure === null) return null;
    total = total.add(ExactDecimal.parse(figure));
  }
  return total;
}

/**
 * The sum over the lots of a per-lot figure, each lot rounded to `places` only
 * at the end of its own sum; null when any lot has no figure. No lots is zero.
 */
function overLots(
  lots: readonly BondValuation[],
  places: number,
  figure: (lot: BondValuation) => ExactDecimal | null,
): string | null {
  let total = ExactDecimal.ZERO;
  for (const lot of lots) {
    const perLot = figure(lot);
    if (perLot === null) return null;
    total = total.add(perLot.roundHalfUp(places));
  }
  return total.toFixed(places);
}

/**
 * The figures of one scenario from the lots valued under it (spec 13.3).
 *
 * Each part of the interest is the per-bond sum over the periods (a coupon bond's
 * periods are the coupons as paid, rounded per bond; a compounding bond's are the
 * exact accrual) times the quantity, rounded once per lot. `totalInterest` is the
 * sum of the four rounded parts, so the parts always add up to it.
 */
export function scenarioOf(
  value: string,
  lots: readonly BondValuation[],
  places: number,
): BondScenario {
  const interest = (part: PartOf) =>
    overLots(lots, places, (lot) => {
      const perBond = perBondSum(lot, part);
      return perBond === null
        ? null
        : perBond.mul(ExactDecimal.fromInt(lot.quantity));
    });
  const fixedInterest = interest((e) => e.fixedPart);
  const benchmarkInterest = interest((e) => e.benchmarkPart);
  const addendInterest = interest((e) => e.addendPart);
  const announcedInterest = interest((e) => e.announcedPart);
  const parts = [
    fixedInterest,
    benchmarkInterest,
    addendInterest,
    announcedInterest,
  ];
  const totalInterest = parts.some((part) => part === null)
    ? null
    : parts
        .reduce(
          (sum, part) => sum.add(ExactDecimal.parse(part as string)),
          ExactDecimal.ZERO,
        )
        .toFixed(places);
  return {
    value,
    maturityValue: overLots(lots, places, (lot) => {
      const maturity = lot.maturityValueKnown ?? lot.maturityValueProjected;
      return maturity === null ? null : ExactDecimal.parse(maturity);
    }),
    totalInterest,
    fixedInterest,
    benchmarkInterest,
    addendInterest,
    announcedInterest,
  };
}

/** Every figure null: the lots cannot be derived. */
export function unknownScenario(value: string): BondScenario {
  return {
    value,
    maturityValue: null,
    totalInterest: null,
    fixedInterest: null,
    benchmarkInterest: null,
    addendInterest: null,
    announcedInterest: null,
  };
}
