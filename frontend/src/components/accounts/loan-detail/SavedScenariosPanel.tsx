'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { CAPTION_CLASS, CellLabel, Th } from '@/components/ui/Table';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { OverpaymentPlan, ScenarioComparison, effectiveOverpaymentMode } from '@/lib/loan-schedule';
import { loanScenariosApi, planToScenarioData, scenarioToPlan } from '@/lib/loan-scenarios';
import {
  BaselineOutcome,
  ScenarioComparisonChart,
  ScenarioChartOutcome,
} from '@/components/accounts/loan-detail/ScenarioComparisonChart';
import { LoanScenario } from '@/types/loan-scenario';
import { getErrorMessage } from '@/lib/errors';
import { createScenarioLabels } from '@/components/accounts/loan-detail/loan-scenario-labels';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

interface SavedScenariosPanelProps {
  accountId: string;
  scenarios: LoanScenario[];
  /** Each scenario's outcome vs the baseline, keyed by scenario id, so the
   *  list shows a comparison table. Null for a scenario that can't project. */
  comparisons: Map<string, ScenarioComparison | null>;
  currencyCode: string;
  /** The simulator's current plan; enables saving when non-null */
  activePlan: OverpaymentPlan | null;
  /** Outcomes for the comparison chart; the chart toggle only shows when
   *  there are at least two (comparing one scenario has nothing to say). */
  chartOutcomes?: ScenarioChartOutcome[];
  /** Scenarios left out of the chart because their interest saving is unknown
   *  (a schedule that stopped at the projection horizon). The chart's arc height
   *  IS the saving, so they cannot be drawn -- but a chart quietly missing rows,
   *  or a toggle that disappeared since yesterday, has to say why. */
  chartExcludedCount?: number;
  /** No-overpayment baseline for the comparison chart's context marker */
  chartBaseline?: BaselineOutcome | null;
  onLoad: (plan: OverpaymentPlan | null, scenario: LoanScenario) => void;
  onScenariosChanged: () => void;
}

/**
 * Saved what-if scenarios for a loan: save the simulator's current inputs
 * under a name, load one back into the simulator, rename, or delete.
 */
export function SavedScenariosPanel({
  accountId,
  scenarios,
  comparisons,
  currencyCode,
  activePlan,
  chartOutcomes = [],
  chartExcludedCount = 0,
  chartBaseline = null,
  onLoad,
  onScenariosChanged,
}: SavedScenariosPanelProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();

  const [nameModal, setNameModal] = useState<
    | { mode: 'save' }
    | { mode: 'rename'; scenario: LoanScenario }
    | null
  >(null);
  const [nameInput, setNameInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scenarioToDelete, setScenarioToDelete] = useState<LoanScenario | null>(null);
  const [showChart, setShowChart] = useState(false);

  const chartAvailable = chartOutcomes.length > 0 && chartBaseline !== null;

  const openSave = () => {
    setNameInput('');
    setNameModal({ mode: 'save' });
  };

  const openRename = (scenario: LoanScenario) => {
    setNameInput(scenario.name);
    setNameModal({ mode: 'rename', scenario });
  };

  const submitName = async () => {
    const name = nameInput.trim();
    if (!name || !nameModal) return;
    setIsSubmitting(true);
    try {
      if (nameModal.mode === 'save') {
        await loanScenariosApi.create(accountId, planToScenarioData(activePlan, name));
        toast.success(t('loanDetail.scenarios.savedToast', { name }));
      } else {
        await loanScenariosApi.update(accountId, nameModal.scenario.id, { name });
        toast.success(t('loanDetail.scenarios.renamedToast', { name }));
      }
      setNameModal(null);
      onScenariosChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.scenarios.saveFailed')));
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!scenarioToDelete) return;
    try {
      await loanScenariosApi.delete(accountId, scenarioToDelete.id);
      toast.success(t('loanDetail.scenarios.deletedToast', { name: scenarioToDelete.name }));
      onScenariosChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.scenarios.deleteFailed')));
    } finally {
      setScenarioToDelete(null);
    }
  };

  const {
    describeScenario,
    overpaymentLabel,
    payoffLabel,
    timeSavedLabel,
    interestSavedLabel,
  } = createScenarioLabels({ t, formatCurrency, formatChartDate, currencyCode });

  // A wrapped money cell: no padding on phones (the card's grid spaces the
  // cells), the table cell's own padding and right alignment from `sm` up.
  const moneyCell = 'p-0 text-right text-sm whitespace-nowrap sm:table-cell sm:px-3 sm:py-2';

  return (
    <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {t('loanDetail.scenarios.title')}
        </h4>
        <div className="flex items-center gap-2">
          {chartAvailable && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowChart((v) => !v)}
              aria-expanded={showChart}
            >
              {showChart
                ? t('loanDetail.scenarioChart.hide')
                : t('loanDetail.scenarioChart.show')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={openSave} disabled={!activePlan}>
            {t('loanDetail.scenarios.saveCurrent')}
          </Button>
        </div>
      </div>

      {scenarios.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanDetail.scenarios.empty')}
        </p>
      ) : (
        // Below `sm` the table becomes a block and each row wraps into a
        // two-column grid card so the name, the four figures and the row actions
        // fit a phone without a horizontal scroll; from `sm` up it is the
        // ordinary table. The card is clickable in whole (it loads the
        // scenario), the header is hidden and each figure names its column with
        // a caption.
        <div className="overflow-x-auto">
          <table className="block min-w-full text-sm sm:table">
            <thead className="block sm:table-header-group">
              <tr className="hidden border-b border-gray-200 dark:border-gray-700 text-left sm:table-row">
                <Th className="px-3 py-2">{t('loanDetail.scenarios.nameLabel')}</Th>
                <Th align="right" className="px-3 py-2">
                  {t('loanDetail.scenarios.colOverpayment')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('loanDetail.comparison.newPayoff')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('loanDetail.comparison.timeSaved')}
                </Th>
                <Th align="right" className="px-3 py-2">
                  {t('loanDetail.comparison.interestSaved')}
                </Th>
                <Th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
              {scenarios.map((scenario) => {
                const comparison = comparisons.get(scenario.id) ?? null;
                const load = () => onLoad(scenarioToPlan(scenario), scenario);
                return (
                  <tr
                    key={scenario.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t('loanDetail.scenarios.loadAria', { name: scenario.name })}
                    onClick={load}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        load();
                      }
                    }}
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-3 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset sm:table-row sm:p-0"
                  >
                    <td className="col-span-2 row-start-1 p-0 align-top sm:table-cell sm:px-3 sm:py-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {scenario.name}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {describeScenario(scenario)}
                      </p>
                    </td>
                    <td className={`col-start-1 row-start-2 text-gray-900 dark:text-gray-100 ${moneyCell}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('loanDetail.scenarios.colOverpayment')}</CellLabel>
                      {overpaymentLabel(scenario)}
                    </td>
                    <td className={`col-start-2 row-start-2 text-purple-600 dark:text-purple-400 ${moneyCell}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('loanDetail.comparison.newPayoff')}</CellLabel>
                      {payoffLabel(comparison)}
                    </td>
                    <td className={`col-start-1 row-start-3 text-green-600 dark:text-green-400 ${moneyCell}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('loanDetail.comparison.timeSaved')}</CellLabel>
                      {/* The mode travels with the scenario, as it does in
                          comparisonTable's export -- inferring it from the
                          installment drop made the visible table and its own CSV
                          disagree for the same row. */}
                      {timeSavedLabel(comparison, effectiveOverpaymentMode(scenarioToPlan(scenario)))}
                    </td>
                    <td className={`col-start-2 row-start-3 text-green-600 dark:text-green-400 ${moneyCell}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('loanDetail.comparison.interestSaved')}</CellLabel>
                      {interestSavedLabel(comparison)}
                    </td>
                    <td className="col-span-2 row-start-4 p-0 whitespace-nowrap sm:table-cell sm:px-3 sm:py-2 sm:text-right">
                      {/* Row-level actions stop propagation so they don't also
                          load the scenario (the row's own click, or its tap on a
                          phone, does that). */}
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openRename(scenario);
                          }}
                        >
                          {t('loanDetail.scenarios.rename')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setScenarioToDelete(scenario);
                          }}
                        >
                          {t('loanDetail.scenarios.delete')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {chartAvailable && showChart && chartBaseline && (
        <ScenarioComparisonChart
          outcomes={chartOutcomes}
          baseline={chartBaseline}
          currencyCode={currencyCode}
        />
      )}

      {/* Shown whether or not the chart is open: when too few scenarios are
          drawable the toggle is gone entirely, and that is exactly when the
          reader needs the reason. Two messages, because the two situations are
          different -- naming only the unknown ones while the chart is suppressed
          would say "1 of 2 is missing" when in fact both are. */}
      {chartExcludedCount > 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {chartAvailable
            ? t('loanDetail.scenarios.chartExcludedUnknown', {
                count: chartExcludedCount,
              })
            : t('loanDetail.scenarios.chartNeedsTwoKnown')}
        </p>
      )}

      <Modal
        isOpen={nameModal !== null}
        onClose={() => setNameModal(null)}
        maxWidth="sm"
        className="p-6"
        title={
          nameModal?.mode === 'rename'
            ? t('loanDetail.scenarios.renameTitle')
            : t('loanDetail.scenarios.saveTitle')
        }
      >
        <div>
          <Input
            label={t('loanDetail.scenarios.nameLabel')}
            value={nameInput}
            maxLength={100}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitName();
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setNameModal(null)}>
              {t('loanDetail.scenarios.cancel')}
            </Button>
            <Button
              onClick={submitName}
              disabled={!nameInput.trim()}
              isLoading={isSubmitting}
            >
              {t('loanDetail.scenarios.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={scenarioToDelete !== null}
        title={t('loanDetail.scenarios.deleteTitle')}
        message={t('loanDetail.scenarios.deleteMessage', {
          name: scenarioToDelete?.name ?? '',
        })}
        confirmLabel={t('loanDetail.scenarios.delete')}
        cancelLabel={t('loanDetail.scenarios.cancel')}
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setScenarioToDelete(null)}
      />
    </div>
  );
}
