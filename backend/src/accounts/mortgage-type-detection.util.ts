import {
  getMortgagePeriodsPerYear,
  getPeriodicRate,
  MortgagePaymentFrequency,
} from "./mortgage-amortization.util";
import { isAcceleratedFrequency } from "./mortgage-installment.util";
import { MortgageType } from "./mortgage-type.util";

/**
 * One posted installment: its principal and interest as positive amounts, and
 * the debt it was priced on when the caller knows it.
 */
export interface MortgageTypeSample {
  principal: number;
  interest: number;
  balanceBefore?: number | null;
}

/**
 * Why the detector answered as it did (docs/specs/mortgage-types.md, table
 * 10). A code rather than prose, so the client words it in the reader's
 * language; every `null` answer carries one naming what was missing.
 */
export const MORTGAGE_TYPE_DETECTION_REASONS = [
  "TOO_FEW_SAMPLES",
  "INVALID_SAMPLE",
  "NO_PAYMENT",
  "AMBIGUOUS_CONSTANT_PRINCIPAL_AND_INSTALLMENT",
  "ACCELERATED_FREQUENCY",
  "NO_RULE_FITS",
  "ZERO_PRINCIPAL",
  "ZERO_PRINCIPAL_RATE_MISMATCH",
  "CONSTANT_PRINCIPAL",
  "CONSTANT_PRINCIPAL_RATE_MISMATCH",
  "CONSTANT_INSTALLMENT_SEMI_ANNUAL",
  "CONSTANT_INSTALLMENT_NOMINAL",
  "CONSTANT_INSTALLMENT_RATE_UNCHECKED",
  "CONSTANT_INSTALLMENT_COMPOUNDING_AMBIGUOUS",
  "CONSTANT_INSTALLMENT_RATE_MISMATCH",
] as const;
export type MortgageTypeDetectionReason =
  (typeof MORTGAGE_TYPE_DETECTION_REASONS)[number];

export interface MortgageTypeDetection {
  /** The suggested type, or null when the samples do not decide one. */
  type: MortgageType | null;
  confidence: "high" | "low";
  reason: MortgageTypeDetectionReason;
}

/** The tolerance per sample: posted figures are rounded to the cent. */
const CENT = 0.01;
/** Absorbs binary representation error in a cent comparison. */
const FLOAT_SLACK = 1e-9;

export const MIN_DETECTION_SAMPLES = 2;

function withinCent(a: number, b: number): boolean {
  return Math.abs(a - b) <= CENT + FLOAT_SLACK;
}

function allWithinCentOfFirst(values: readonly number[]): boolean {
  return values.every((value) => withinCent(value, values[0]));
}

function isValidSample(sample: MortgageTypeSample): boolean {
  const { principal, interest, balanceBefore } = sample;
  if (!Number.isFinite(principal) || principal < 0) return false;
  if (!Number.isFinite(interest) || interest < 0) return false;
  if (balanceBefore == null) return true;
  return Number.isFinite(balanceBefore) && balanceBefore > 0;
}

/**
 * Whether every sample that carries a balance books the interest `type`'s
 * periodic rate charges on it, within a cent: `null` when no sample carries a
 * balance or the rate or frequency is unknown, so the check could not run.
 */
function interestMatchesRate(
  samples: readonly MortgageTypeSample[],
  annualRate: number | null,
  frequency: MortgagePaymentFrequency | null,
  type: MortgageType,
): boolean | null {
  if (annualRate === null || !Number.isFinite(annualRate)) return null;
  if (frequency === null) return null;
  const priced = samples.filter((s) => s.balanceBefore != null);
  if (priced.length === 0) return null;
  const periodicRate = getPeriodicRate(
    annualRate,
    getMortgagePeriodsPerYear(frequency),
    type,
  );
  return priced.every((s) =>
    withinCent(s.interest, s.balanceBefore! * periodicRate),
  );
}

/**
 * Suggest a mortgage's type from consecutive installments, oldest first, and
 * the quoted annual rate (a percentage) at the payment frequency
 * (docs/specs/mortgage-types.md, section 10). A suggestion only: it reads
 * nothing and writes nothing, and the person confirms the type.
 *
 * The rules, in order, each with a tolerance of one cent per sample:
 * - fewer than two samples, or one that is negative or not a number: no type;
 * - principal 0 on every sample: `INTEREST_ONLY`;
 * - principal and installment both constant (a 0% loan, or interest too small
 *   to move by a cent): no type, since `LINEAR` and `ANNUITY` both fit;
 * - principal constant, installment falling: `LINEAR`;
 * - installment constant, principal not falling: the annuity family, with the
 *   interest-to-balance ratio deciding the compounding where a balance and
 *   the rate are known (at 6% monthly, 0.4939% for `CANADIAN_FIXED` against
 *   0.5000% for `ANNUITY`);
 * - anything else: no type.
 *
 * `LINEAR` and `INTEREST_ONLY` refuse an accelerated frequency (spec section
 * 5.1), so a sample shaped like either at one is answered with no type rather
 * than a type the account could not hold.
 *
 * Confidence is `high` when the shape decides the type and the interest
 * agrees with the quoted rate wherever it could be checked; a `LINEAR` or
 * `INTEREST_ONLY` shape stays `high` without a balance, because each method
 * has one compounding. An annuity is `CANADIAN_FIXED` only on a positive
 * check, and `ANNUITY` is `high` only when the nominal rate fits and the
 * semi-annual one does not.
 */
export function detectMortgageType(
  samples: readonly MortgageTypeSample[],
  quotedAnnualRate: number | null,
  frequency: MortgagePaymentFrequency | null,
): MortgageTypeDetection {
  if (samples.length < MIN_DETECTION_SAMPLES) {
    return refusal("TOO_FEW_SAMPLES");
  }
  if (!samples.every(isValidSample)) {
    return refusal("INVALID_SAMPLE");
  }

  const principals = samples.map((s) => s.principal);
  const installments = samples.map((s) => s.principal + s.interest);
  const accelerated = frequency !== null && isAcceleratedFrequency(frequency);

  if (principals.every((p) => withinCent(p, 0))) {
    if (installments.every((total) => withinCent(total, 0))) {
      return refusal("NO_PAYMENT");
    }
    if (accelerated) return refusal("ACCELERATED_FREQUENCY");
    return byShape(
      "INTEREST_ONLY",
      interestMatchesRate(
        samples,
        quotedAnnualRate,
        frequency,
        "INTEREST_ONLY",
      ),
      "ZERO_PRINCIPAL",
      "ZERO_PRINCIPAL_RATE_MISMATCH",
    );
  }

  const constantPrincipal = allWithinCentOfFirst(principals);
  const constantInstallment = allWithinCentOfFirst(installments);

  if (constantPrincipal && constantInstallment) {
    return refusal("AMBIGUOUS_CONSTANT_PRINCIPAL_AND_INSTALLMENT");
  }

  if (constantPrincipal) {
    if (!isFalling(installments)) return refusal("NO_RULE_FITS");
    if (accelerated) return refusal("ACCELERATED_FREQUENCY");
    return byShape(
      "LINEAR",
      interestMatchesRate(samples, quotedAnnualRate, frequency, "LINEAR"),
      "CONSTANT_PRINCIPAL",
      "CONSTANT_PRINCIPAL_RATE_MISMATCH",
    );
  }

  if (constantInstallment) {
    // An annuity's interest falls with the debt, so its principal rises; a
    // falling principal under a level installment is a rate that rose.
    if (!isNonDecreasing(principals)) return refusal("NO_RULE_FITS");
    return annuityCompounding(
      interestMatchesRate(
        samples,
        quotedAnnualRate,
        frequency,
        "CANADIAN_FIXED",
      ),
      interestMatchesRate(samples, quotedAnnualRate, frequency, "ANNUITY"),
    );
  }

  return refusal("NO_RULE_FITS");
}

function refusal(reason: MortgageTypeDetectionReason): MortgageTypeDetection {
  return { type: null, confidence: "low", reason };
}

function byShape(
  type: MortgageType,
  rateCheck: boolean | null,
  agrees: MortgageTypeDetectionReason,
  disagrees: MortgageTypeDetectionReason,
): MortgageTypeDetection {
  return rateCheck === false
    ? { type, confidence: "low", reason: disagrees }
    : { type, confidence: "high", reason: agrees };
}

function annuityCompounding(
  semiAnnual: boolean | null,
  nominal: boolean | null,
): MortgageTypeDetection {
  if (semiAnnual === null || nominal === null) {
    return {
      type: "ANNUITY",
      confidence: "low",
      reason: "CONSTANT_INSTALLMENT_RATE_UNCHECKED",
    };
  }
  if (semiAnnual && !nominal) {
    return {
      type: "CANADIAN_FIXED",
      confidence: "high",
      reason: "CONSTANT_INSTALLMENT_SEMI_ANNUAL",
    };
  }
  if (nominal && !semiAnnual) {
    return {
      type: "ANNUITY",
      confidence: "high",
      reason: "CONSTANT_INSTALLMENT_NOMINAL",
    };
  }
  return {
    type: "ANNUITY",
    confidence: "low",
    reason: semiAnnual
      ? "CONSTANT_INSTALLMENT_COMPOUNDING_AMBIGUOUS"
      : "CONSTANT_INSTALLMENT_RATE_MISMATCH",
  };
}

/** Each value at most a cent above the one before, and the last below the first. */
function isFalling(values: readonly number[]): boolean {
  const stepsDown = values.every(
    (value, i) => i === 0 || value <= values[i - 1] + CENT + FLOAT_SLACK,
  );
  return stepsDown && values[values.length - 1] < values[0] - CENT;
}

/** No value more than a cent below the one before it. */
function isNonDecreasing(values: readonly number[]): boolean {
  return values.every(
    (value, i) => i === 0 || value >= values[i - 1] - CENT - FLOAT_SLACK,
  );
}
