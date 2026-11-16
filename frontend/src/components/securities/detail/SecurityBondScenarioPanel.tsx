'use client';

import {
  activateOnKey,
  INTERACTIVE_ROW_FOCUS_CLASS,
} from '@/components/ui/interactive-row';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { NumericInput } from '@/components/ui/NumericInput';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLongPress } from '@/hooks/useLongPress';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { BondScenario, SecurityBondScenarios } from '@/types/bond';
import { benchmarkLabel } from './bond-labels';

/** The assumed values every reader sees, as fractions (0%, 2.5%, 5%, 8%). */
export const BOND_SCENARIO_PRESETS = ['0', '0.025', '0.05', '0.08'] as const;

/** The bounds the server accepts, in percent. */
const MIN_PERCENT = -50;
const MAX_PERCENT = 100;

interface SecurityBondScenarioPanelProps {
  securityId: string;
  benchmarkId: string;
  /** True when the rule reads a price index, so the wording says inflation. */
  inflation: boolean;
  currency: string;
  /** The card's valuation date: the scenarios value the lots held on this day. */
  asOf: string;
  /** The value the valuation currently assumes (a fraction), or null for the default. */
  selected: string | null;
  /** A scenario row was chosen; null returns to the engine's default assumption. */
  onSelect: (value: string | null) => void;
}

/** A typed percent as the fraction string the API takes, to 4 decimal places. */
export function percentToFraction(percent: number): string {
  return (Math.round(percent * 100) / 10000).toFixed(4);
}

const sameValue = (a: string, b: string) => Number(a) === Number(b);

/**
 * What the lots are worth if every period that has not started follows an
 * assumed benchmark value (spec 13.3): the presets and one value the reader
 * types, valued in one request. Every figure is a projection. The payload is
 * kept with the request key that produced it, and an unknown figure is said to
 * be unknown, never shown as zero. Clicking a row makes the valuation (and with
 * it the per-period table and the chart) follow that assumption.
 */
export function SecurityBondScenarioPanel({
  securityId,
  benchmarkId,
  inflation,
  currency,
  asOf,
  selected,
  onSelect,
}: SecurityBondScenarioPanelProps) {
  const t = useTranslations('securityDetail');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [draft, setDraft] = useState<number | undefined>(undefined);
  const [custom, setCustom] = useState<string | null>(null);

  const values = useMemo(
    () =>
      custom !== null && !BOND_SCENARIO_PRESETS.some((p) => sameValue(p, custom))
        ? [...BOND_SCENARIO_PRESETS, custom]
        : [...BOND_SCENARIO_PRESETS],
    [custom],
  );
  const valuesKey = values.join(',');
  const requestKey = `${securityId}|${benchmarkId}|${valuesKey}|${asOf}`;
  const { data, dataKey, isLoading, error, reload } =
    useReportData<SecurityBondScenarios>(
      () =>
        investmentsApi.getSecurityBondScenarios(securityId, benchmarkId, values, asOf),
      [securityId, benchmarkId, valuesKey, asOf],
      { requestKey },
    );
  // Figures belong to the request that produced them.
  const result = data !== null && dataKey === requestKey ? data : null;

  const { getRowHandlers } = useLongPress<BondScenario>({
    onLongPress: () => undefined,
    onClick: (scenario) => onSelect(scenario.value),
  });

  const benchmark = benchmarkLabel(t, benchmarkId);
  const pct = (fraction: string) =>
    formatPercentTrimmed(Number(fraction) * 100);
  const money = (figure: string | null) =>
    figure === null ? (
      <span className="text-gray-500 dark:text-gray-400">
        {t('bond.unknown')}
      </span>
    ) : (
      formatCurrency(Number(figure), currency)
    );

  const showAnnounced =
    result?.scenarios.some(
      (s) => s.announcedInterest !== null && Number(s.announcedInterest) !== 0,
    ) ?? false;

  const renderTable = (scenarios: SecurityBondScenarios) => (
    <div className="overflow-x-auto scrollbar-slim">
      <table className={TABLE_CLASS}>
        <caption className="sr-only">{t('bond.scenarios.caption')}</caption>
        <thead>
          <tr>
            <Th>{t('bond.scenarios.columns.assumed', { benchmark })}</Th>
            <Th>{t('bond.scenarios.columns.maturityValue')}</Th>
            <Th>{t('bond.scenarios.columns.totalInterest')}</Th>
            <Th>{t('bond.interestParts.fixed')}</Th>
            <Th>{t('bond.interestParts.margin')}</Th>
            <Th>
              {t(
                inflation
                  ? 'bond.interestParts.inflation'
                  : 'bond.interestParts.benchmark',
              )}
            </Th>
            {showAnnounced && <Th>{t('bond.interestParts.announced')}</Th>}
          </tr>
        </thead>
        <tbody className={TABLE_BODY_CLASS}>
          {scenarios.scenarios.map((scenario) => {
            const isSelected =
              selected !== null && sameValue(selected, scenario.value);
            return (
              <tr
                key={scenario.value}
                {...getRowHandlers(scenario)}
                tabIndex={0}
                aria-current={isSelected ? 'true' : undefined}
                onKeyDown={activateOnKey(() => onSelect(scenario.value))}
                className={`cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS} ${
                  isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
              >
                <Td className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <span>{pct(scenario.value)}</span>
                    {isSelected && (
                      <Badge variant="blue">{t('bond.scenarios.selected')}</Badge>
                    )}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">{money(scenario.maturityValue)}</Td>
                <Td className="whitespace-nowrap">{money(scenario.totalInterest)}</Td>
                <Td className="whitespace-nowrap">{money(scenario.fixedInterest)}</Td>
                <Td className="whitespace-nowrap">{money(scenario.addendInterest)}</Td>
                <Td className="whitespace-nowrap">{money(scenario.benchmarkInterest)}</Td>
                {showAnnounced && (
                  <Td className="whitespace-nowrap">
                    {money(scenario.announcedInterest)}
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const renderBody = () => {
    if (error) {
      return (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(error, t('bond.scenarios.loadFailed'))}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t('error.retry')}
          </Button>
        </div>
      );
    }
    if (!result) {
      return (
        <div className="flex justify-center py-4">
          <LoadingSpinner text={t('bond.scenarios.loading')} />
        </div>
      );
    }
    return (
      <div className="space-y-2" aria-busy={isLoading}>
        {result.refusal && (
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {t(`bond.lotsRefusal.${result.refusal.code}`)}
          </p>
        )}
        {renderTable(result)}
      </div>
    );
  };

  return (
    <section
      className="space-y-3"
      aria-label={t(
        inflation ? 'bond.scenarios.title' : 'bond.scenarios.titleBenchmark',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t(inflation ? 'bond.scenarios.title' : 'bond.scenarios.titleBenchmark')}
        </h4>
        <Badge variant="amber">{t('bond.scenarios.projection')}</Badge>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('bond.scenarios.intro', { benchmark })}
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('bond.scenarios.asOfNote', { date: formatDate(result?.asOf ?? asOf) })}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-56">
          <NumericInput
            label={t('bond.scenarios.custom', { benchmark })}
            suffix="%"
            value={draft}
            onChange={setDraft}
            decimalPlaces={2}
            allowNegative
            min={MIN_PERCENT}
            max={MAX_PERCENT}
          />
        </div>
        <Button
          variant="outline"
          disabled={draft === undefined}
          onClick={() => {
            if (draft !== undefined) setCustom(percentToFraction(draft));
          }}
        >
          {t('bond.scenarios.add')}
        </Button>
        {selected !== null && (
          <Button variant="outline" onClick={() => onSelect(null)}>
            {t('bond.scenarios.useDefault')}
          </Button>
        )}
      </div>
      {renderBody()}
    </section>
  );
}
