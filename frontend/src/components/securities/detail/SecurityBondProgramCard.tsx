'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Card } from '@/components/ui/Card';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { programFacts, type HeldSeries } from '@/lib/bond-series';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';
import type { BondOffer } from '@/types/bond';
import { rateRuleLines } from './bond-labels';

interface SecurityBondProgramCardProps {
  security: Security;
  programCode: string;
  /** The issuing country of the program. */
  countryCode: string;
  /** The series the reader holds, the fallback source of the terms. */
  held: HeldSeries[];
  /** The switch as the server last reported it. */
  autoFetch: boolean;
  /** Bumped by the page when a price refresh completes: re-reads in place. */
  refreshVersion?: number;
}

/**
 * "The program" (spec `bond-program-securities.md` 3.4): how the product pays,
 * how long it runs, how it capitalizes, what an early redemption costs (read
 * from its newest series, which the card names), and the switch that has new
 * series of the program fetched automatically.
 *
 * The switch is optimistic: it moves at once, and goes back with the server's
 * message when the save fails.
 */
export function SecurityBondProgramCard({
  security,
  programCode,
  countryCode,
  held,
  autoFetch,
  refreshVersion = 0,
}: SecurityBondProgramCardProps) {
  const t = useTranslations('securityDetail');
  const tBonds = useTranslations('bonds');
  const tSec = useTranslations('securities');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();

  // The newest series on sale carries the complete terms; a failed read leaves
  // the held series to answer, never an empty program.
  const offer = useReportData<BondOffer>(
    () => investmentsApi.getBondOffer(countryCode),
    [countryCode, refreshVersion],
  );
  const facts = programFacts(offer.data?.series ?? [], held, programCode);

  const [checked, setChecked] = useState(autoFetch);
  const [prevAutoFetch, setPrevAutoFetch] = useState(autoFetch);
  if (autoFetch !== prevAutoFetch) {
    setPrevAutoFetch(autoFetch);
    setChecked(autoFetch);
  }
  const [isSaving, setIsSaving] = useState(false);
  // Set synchronously, so two clicks in one tick cannot both send.
  const inFlight = useRef(false);

  const handleToggle = async (next: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const previous = checked;
    setChecked(next);
    setIsSaving(true);
    try {
      await investmentsApi.updateSecurity(security.id, { bondAutoFetch: next });
    } catch (err) {
      setChecked(previous);
      toast.error(getErrorMessage(err, t('bond.program.autoFetchFailed')));
    } finally {
      inFlight.current = false;
      setIsSaving(false);
    }
  };

  // Rates are fractions; the formatter takes percent units.
  const pct = (fraction: string) => formatPercentTrimmed(Number(fraction) * 100);
  const redemptionLines = (): string[] => {
    if (facts === null) return [];
    const lines: string[] = [];
    if (facts.fee !== null) {
      lines.push(
        t('bond.redemption.fixedFee', {
          amount: formatCurrency(Number(facts.fee), security.currencyCode),
        }),
      );
    }
    if (facts.floor !== null) {
      lines.push(
        t(
          facts.floor === 'ALL_PERIODS'
            ? 'bond.redemption.floorAllPeriods'
            : 'bond.redemption.floorFirstPeriod',
        ),
      );
    }
    return lines;
  };

  const term = (label: string, value: ReactNode) => (
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="space-y-0.5 text-sm text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );

  return (
    <Card padding="sm" aria-label={t('bond.program.title')} as="section">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('bond.program.title')}
      </h3>
      {facts === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('bond.program.noTerms')}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('bond.program.newest', { series: facts.seriesCode })}
          </p>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {term(
              tBonds('offer.columns.rule'),
              rateRuleLines(t, facts.rateRule, pct).map((line) => <p key={line}>{line}</p>),
            )}
            {facts.lengthMonths !== null &&
              term(
                tBonds('offer.columns.length'),
                tBonds('offer.lengthValue', { months: facts.lengthMonths }),
              )}
            {facts.capitalization !== null &&
              term(
                tBonds('offer.columns.capitalization'),
                tBonds(`offer.capitalization.${facts.capitalization}`),
              )}
            {term(
              tBonds('offer.columns.redemption'),
              facts.redeemableAtMaturityOnly ? (
                tBonds('offer.redemption.none')
              ) : redemptionLines().length === 0 ? (
                tBonds('history.none')
              ) : (
                redemptionLines().map((line) => <p key={line}>{line}</p>)
              ),
            )}
          </dl>
        </div>
      )}
      <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
        <label className="flex w-fit cursor-pointer items-center gap-2">
          <ToggleSwitch
            checked={checked}
            onChange={handleToggle}
            disabled={isSaving}
            label={tSec('form.bondAutoFetchLabel')}
          />
          <span className="text-sm text-gray-900 dark:text-gray-100">
            {tSec('form.bondAutoFetchLabel')}
          </span>
        </label>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {tSec('form.bondAutoFetchHelp')}
        </p>
      </div>
    </Card>
  );
}
