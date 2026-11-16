/**
 * Whether the prices behind a portfolio movement are evidence for the period
 * being measured, or a close that arrived late
 * (`docs/specs/portfolio-movement-notifications.md`, INV-PORTMOVE-008).
 *
 * Valuation legitimately carries a close forward: a position whose latest
 * accepted close is a month old is still worth that close today, and a manually
 * priced holding depends on exactly that (`docs/time-series-contract.md` section
 * 2.1, second exception). A **movement** is a different question. It is a
 * difference of two dated observations, and a position carried at an old close
 * contributes the same figure to both ends -- until the run in which a new close
 * arrives, which would book the whole catch-up since that old close as one
 * period's market move. That is the 94% "movement" in kenlasko/monize#1391.
 *
 * So the baseline records, per held security, the close that valued it and the
 * date that close was struck on. When a close that was already older than the
 * tolerance at the baseline is replaced, the jump between the two closes is a
 * late price: the baseline is restated at the new close (the jump is removed
 * from the movement and named), and the baseline still advances. Nothing is
 * withheld on account of a carried close, so a holding priced by hand never
 * silences the alert (kenlasko/monize#1435).
 */
import { addDaysYMD } from "../common/date-utils";
import { roundMoney, sumMoney } from "../common/round.util";

/** Below this a quantity is a rounding artefact, not a position. */
const QUANTITY_EPSILON = 0.00000001;

/**
 * How many calendar days old a close may be at the baseline and still count as
 * current. A feed that routinely runs a session behind (a fund's NAV published
 * the next morning, a Monday run whose latest close is Friday's, a one-day
 * holiday) stays inside it, so its moves are the period's own. A close older
 * than this at the baseline was carried, and its replacement is a late price.
 */
export const LATE_PRICE_TOLERANCE_DAYS = 4;

/** One held security as the baseline recorded it, in its own currency. */
export interface BaselinePosition {
  securityId: string;
  /** Total quantity held across the user's accounts. */
  quantity: number;
  /** The close that valued the position, in `currency`. */
  close: number;
  /** `YYYY-MM-DD` the close was struck on. */
  priceDate: string;
  /** The security's own currency (the close's). */
  currency: string;
}

/** A held position as `getPortfolioSummary().holdings` reports one. */
export interface HeldPosition {
  securityId: string;
  currencyCode: string;
  quantity: number;
}

/** A dated close, as `PortfolioService.getLatestPriceObservations` returns one. */
export interface PriceObservation {
  close: number;
  date: string;
}

/**
 * The positions to store with a new baseline: every security held in a non-zero
 * quantity, summed across accounts, with the observation that priced it.
 *
 * Returns `null` when a held position has no observation, because a snapshot
 * missing a position cannot restate that position later. The producer only
 * stores a baseline on a complete valuation, where every held position is
 * priced, so `null` there is a disagreement between the two reads and the
 * snapshot is left unknown (the next run replaces it) rather than guessed.
 */
export function snapshotPositions(
  holdings: readonly HeldPosition[],
  observationFor: (securityId: string) => PriceObservation | null,
): BaselinePosition[] | null {
  const bySecurity = new Map<string, { quantity: number; currency: string }>();
  for (const { securityId, currencyCode, quantity } of holdings) {
    const prior = bySecurity.get(securityId);
    bySecurity.set(securityId, {
      quantity: (prior?.quantity ?? 0) + quantity,
      currency: currencyCode,
    });
  }

  const positions: BaselinePosition[] = [];
  for (const [securityId, { quantity, currency }] of bySecurity) {
    if (Math.abs(quantity) < QUANTITY_EPSILON) continue;
    const observation = observationFor(securityId);
    if (observation === null) return null;
    positions.push({
      securityId,
      quantity,
      close: observation.close,
      priceDate: observation.date,
      currency,
    });
  }
  return positions.sort((a, b) => a.securityId.localeCompare(b.securityId));
}

/**
 * Read a stored snapshot back, or `null` when it is absent or not the shape this
 * module writes. `null` means "no snapshot": the producer replaces the baseline
 * rather than comparing against one it cannot restate.
 */
export function parseBaselinePositions(
  value: unknown,
): BaselinePosition[] | null {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(parsed)) return null;
  const positions: BaselinePosition[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null;
    const row = item as Record<string, unknown>;
    if (
      typeof row.securityId !== "string" ||
      typeof row.quantity !== "number" ||
      !Number.isFinite(row.quantity) ||
      typeof row.close !== "number" ||
      !Number.isFinite(row.close) ||
      typeof row.priceDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.priceDate) ||
      typeof row.currency !== "string"
    ) {
      return null;
    }
    positions.push({
      securityId: row.securityId,
      quantity: row.quantity,
      close: row.close,
      priceDate: row.priceDate,
      currency: row.currency,
    });
  }
  return positions;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** One late close, removed from the movement and named in the alert. */
export interface LatePrice {
  securityId: string;
  /** The date of the close the baseline was valued at. */
  fromDate: string;
  /** The date of the close that replaced it. */
  toDate: string;
  /**
   * The baseline quantity times the jump between the two closes, in the
   * reporting currency at today's rate.
   */
  value: number;
}

export interface LatePriceAdjustment {
  /**
   * False when a late close could not be put into the reporting currency (or
   * the security has no observation at all any more); `missing` names which.
   */
  complete: boolean;
  /** The sum of `items[].value`, in the reporting currency. */
  total: number;
  items: LatePrice[];
  /** Security ids whose late close could not be valued. */
  missing: string[];
}

/**
 * The late closes since `baselineDate`, and what they add to the baseline.
 *
 * A baseline position is late when its close was struck more than
 * `LATE_PRICE_TOLERANCE_DAYS` before the baseline date AND the security's latest
 * observation is now a different one (a new date or a corrected close). Its
 * adjustment is `quantity x (newClose - oldClose)` at today's rate
 * `rateFor(currency)`: the baseline restated at the close that arrived. The FX
 * move on the old close over the period is left in the movement, because the
 * rate is the period's own evidence.
 *
 * A position the user has sold since is adjusted too, from the latest
 * observation, since its proceeds are in today's cash at the new price.
 */
export function latePriceAdjustment(
  positions: readonly BaselinePosition[],
  baselineDate: string,
  latestFor: (securityId: string) => PriceObservation | null,
  rateFor: (currency: string) => number | null,
): LatePriceAdjustment {
  const cutoff = addDaysYMD(baselineDate, -LATE_PRICE_TOLERANCE_DAYS);
  const items: LatePrice[] = [];
  const missing: string[] = [];

  for (const position of positions) {
    if (position.priceDate >= cutoff) continue;
    const latest = latestFor(position.securityId);
    if (latest === null) {
      missing.push(position.securityId);
      continue;
    }
    if (latest.date === position.priceDate && latest.close === position.close) {
      continue;
    }
    const rate = rateFor(position.currency);
    if (rate === null) {
      missing.push(position.securityId);
      continue;
    }
    const value = roundMoney(
      position.quantity * (latest.close - position.close) * rate,
    );
    if (value === 0) continue;
    items.push({
      securityId: position.securityId,
      fromDate: position.priceDate,
      toDate: latest.date,
      value,
    });
  }

  return {
    complete: missing.length === 0,
    total: sumMoney(items.map((item) => item.value)),
    items,
    missing: missing.sort(),
  };
}
