import type { LoanScenario } from '@/types/loan-scenario';
import type {
  OverpaymentFrequency,
  OverpaymentMode,
  ScenarioComparison,
} from '@/lib/loan-schedule';
import { effectiveOverpaymentMode } from '@/lib/loan-schedule';
import { scenarioToPlan } from '@/lib/loan-scenarios';

/** i18n key for each overpayment frequency's label, shared across the scenario
 *  summaries, table, chart and PDF so a saved cadence reads the same way. */
export const FREQUENCY_LABEL_KEY: Record<OverpaymentFrequency, string> = {
  ONE_OFF: 'loanDetail.simulator.frequencyOneOff',
  WEEKLY: 'loanDetail.simulator.frequencyWeekly',
  BIWEEKLY: 'loanDetail.simulator.frequencyBiweekly',
  MONTHLY: 'loanDetail.simulator.frequencyMonthly',
  QUARTERLY: 'loanDetail.simulator.frequencyQuarterly',
  ANNUALLY: 'loanDetail.simulator.frequencyAnnually',
};

/**
 * The catalog key for a saved cadence, or `null` when the stored value is not a
 * cadence this app knows.
 *
 * `loan_scenarios.recurring_extra_frequency` is an unconstrained VARCHAR whose
 * only enforcement is `@IsIn` at write time, so a legacy row or a restored
 * backup can carry anything -- which is why `recurringOccurrencesDue` contributes
 * zero for an unrecognised value rather than guessing. Indexing
 * `FREQUENCY_LABEL_KEY` directly gave `undefined`, and next-intl throws on a
 * non-string key: the schedule engine survived the row and the label took the
 * whole loan detail view down with it. A label is the cheapest thing on the
 * page; it degrades.
 */
export function frequencyLabelKey(
  frequency: string | null | undefined,
): string | null {
  if (!frequency) return null;
  return (
    (FREQUENCY_LABEL_KEY as Record<string, string | undefined>)[frequency] ??
    null
  );
}

/**
 * Formatting hooks the labels need, passed in by the caller so the same
 * wording renders in the SavedScenariosPanel table and in the loan page's
 * PDF export. Method syntax keeps `t` assignable from next-intl's narrower
 * translator type.
 */
export interface ScenarioLabelDeps {
  t(key: string, values?: Record<string, string | number>): string;
  formatCurrency(amount: number, currency?: string): string;
  formatChartDate(date: string, format: string): string;
  currencyCode: string;
}

/** The saved-scenario labels used by the comparison table and exports. */
export function createScenarioLabels({
  t,
  formatCurrency,
  formatChartDate,
  currencyCode,
}: ScenarioLabelDeps) {
  const describeScenario = (scenario: LoanScenario): string => {
    if (scenario.targetMonthlyPayment && scenario.targetMonthlyPayment > 0) {
      return t('loanDetail.scenarios.budgetSummary', {
        amount: formatCurrency(scenario.targetMonthlyPayment, currencyCode),
      });
    }
    const parts: string[] = [];
    if (scenario.recurringExtraAmount && scenario.recurringExtraAmount > 0) {
      // Through `frequencyLabelKey`, not the table: the column is an
      // unconstrained VARCHAR, and `t(undefined)` throws.
      const freqKey = frequencyLabelKey(scenario.recurringExtraFrequency);
      parts.push(
        freqKey && scenario.recurringExtraFrequency !== 'MONTHLY'
          ? t('loanDetail.scenarios.overpaymentWithFrequency', {
              amount: formatCurrency(scenario.recurringExtraAmount, currencyCode),
              frequency: t(freqKey),
            })
          : t('loanDetail.scenarios.recurringSummary', {
              amount: formatCurrency(scenario.recurringExtraAmount, currencyCode),
            }),
      );
    }
    if (scenario.lumpSums.length > 0) {
      parts.push(
        t('loanDetail.scenarios.lumpSumSummary', { count: scenario.lumpSums.length }),
      );
    }
    return parts.join(' + ') || t('loanDetail.scenarios.emptyScenario');
  };

  // The saved recurring overpayment with its cadence (e.g. "$300.00
  // (Quarterly)"); a plain amount for a monthly/legacy cadence.
  const overpaymentLabel = (scenario: LoanScenario): string => {
    if (scenario.targetMonthlyPayment && scenario.targetMonthlyPayment > 0) {
      return formatCurrency(scenario.targetMonthlyPayment, currencyCode);
    }
    if (!scenario.recurringExtraAmount || scenario.recurringExtraAmount <= 0) return '—';
    const amount = formatCurrency(scenario.recurringExtraAmount, currencyCode);
    const freqKey = frequencyLabelKey(scenario.recurringExtraFrequency);
    return freqKey && scenario.recurringExtraFrequency !== 'MONTHLY'
      ? t('loanDetail.scenarios.overpaymentWithFrequency', {
          amount,
          frequency: t(freqKey),
        })
      : amount;
  };

  const payoffLabel = (comparison: ScenarioComparison | null): string =>
    comparison
      ? comparison.scenario.payoffDate
        ? formatChartDate(comparison.scenario.payoffDate, 'MMM yyyy')
        : t('loanDetail.comparison.beyondProjection')
      : '—';

  /**
   * `mode` comes from the saved scenario when the caller has it: reading the mode
   * off `installmentReduction` fails exactly when that value is null (a schedule
   * truncated at the projection horizon), which would offer "time saved" for a
   * plan that holds the end date fixed.
   */
  const timeSavedLabel = (
    comparison: ScenarioComparison | null,
    mode?: OverpaymentMode | null,
  ): string => {
    if (!comparison) return '—';
    const isLowerInstallment =
      mode != null
        ? mode === 'LOWER_INSTALLMENT'
        : (comparison.installmentReduction ?? 0) > 0.005;
    if (isLowerInstallment) {
      if (comparison.installmentReduction == null) return '—';
      return t('loanDetail.comparison.installmentDrop', {
        payment: formatCurrency(comparison.scenario.finalPaymentAmount, currencyCode),
        reduction: formatCurrency(comparison.installmentReduction, currencyCode),
      });
    }
    // Unknown when either schedule stopped at the projection horizon; the em
    // dash is the same rendering a missing comparison gets, since to a reader
    // both mean "this cannot be shown".
    if (comparison.monthsSaved == null || comparison.paymentsSaved == null) {
      return '—';
    }
    return comparison.monthsSaved > 0
      ? t('loanDetail.comparison.monthsSaved', { count: comparison.monthsSaved })
      : t('loanDetail.comparison.paymentsSaved', {
          count: Math.max(comparison.paymentsSaved, 0),
        });
  };

  // No comparison at all and an unknown saving read the same to a user: the
  // number cannot be shown. Both render the em dash rather than a zero.
  const interestSavedLabel = (comparison: ScenarioComparison | null): string =>
    comparison && comparison.interestSaved != null
      ? formatCurrency(Math.max(0, comparison.interestSaved), currencyCode)
      : '—';

  /** The comparison table exactly as the panel displays it. */
  const comparisonTable = (
    scenarios: LoanScenario[],
    comparisons: Map<string, ScenarioComparison | null>,
  ): { headers: string[]; rows: string[][] } => ({
    headers: [
      t('loanDetail.scenarios.nameLabel'),
      t('loanDetail.scenarios.colOverpayment'),
      t('loanDetail.scenarios.colDetails'),
      t('loanDetail.comparison.newPayoff'),
      t('loanDetail.comparison.timeSaved'),
      t('loanDetail.comparison.interestSaved'),
    ],
    rows: scenarios.map((scenario) => {
      const comparison = comparisons.get(scenario.id) ?? null;
      return [
        scenario.name,
        overpaymentLabel(scenario),
        describeScenario(scenario),
        payoffLabel(comparison),
        timeSavedLabel(comparison, effectiveOverpaymentMode(scenarioToPlan(scenario))),
        interestSavedLabel(comparison),
      ];
    }),
  });

  return {
    describeScenario,
    overpaymentLabel,
    payoffLabel,
    timeSavedLabel,
    interestSavedLabel,
    comparisonTable,
  };
}
