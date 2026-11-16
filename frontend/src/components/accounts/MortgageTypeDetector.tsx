'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { accountsApi } from '@/lib/accounts';
import { getCurrencySymbol } from '@/lib/format';
import { createLogger } from '@/lib/logger';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type {
  DetectMortgageTypeData,
  MortgagePaymentFrequency,
  MortgageType,
  MortgageTypeDetection,
  MortgageTypeSample,
} from '@/types/account';
import { MortgageTypeSuggestion } from './MortgageTypeSuggestion';

const logger = createLogger('MortgageTypeDetector');

/** Two or three consecutive installments decide a type (spec section 10). */
const ROW_COUNT = 3;

interface SampleRow {
  principal: number | undefined;
  interest: number | undefined;
  balanceBefore: number | undefined;
}

const EMPTY_ROW: SampleRow = {
  principal: undefined,
  interest: undefined,
  balanceBefore: undefined,
};

const emptyRows = (): SampleRow[] => Array.from({ length: ROW_COUNT }, () => EMPTY_ROW);

const isBlank = (row: SampleRow) =>
  row.principal === undefined && row.interest === undefined && row.balanceBefore === undefined;

/** A row that carries something but not both halves of an installment. */
const isIncomplete = (row: SampleRow) =>
  !isBlank(row) && (row.principal === undefined || row.interest === undefined);

/**
 * The answer kept with the request that produced it, so a suggestion is shown
 * only while the inputs it was read from are still the ones on screen.
 */
interface Answer {
  requestKey: string;
  detection: MortgageTypeDetection | null;
  failed: boolean;
}

interface MortgageTypeDetectorProps {
  /** The quoted annual rate on the form, a percentage; unknown when not entered. */
  interestRate: number | undefined;
  /** The cadence on the form; the request needs one. */
  paymentFrequency: MortgagePaymentFrequency | undefined;
  currencyCode: string;
  /** Applies a confirmed suggestion to the form's Mortgage Type select. */
  onUse: (type: MortgageType) => void;
}

/**
 * "Not sure? Enter a few installments": two or three installments typed from
 * a statement, sent with the form's quoted rate and frequency to the
 * detection endpoint, which answers a suggested type and the reason. Nothing
 * is computed here and nothing changes on the form until the person presses
 * "Use this type" (docs/specs/mortgage-types.md, section 10).
 */
export function MortgageTypeDetector({
  interestRate,
  paymentFrequency,
  currencyCode,
  onUse,
}: MortgageTypeDetectorProps) {
  const t = useTranslations('accounts');
  const { formatPercentTrimmed } = useNumberFormat();
  const [isOpen, setIsOpen] = useState(false);
  const [rows, setRows] = useState<SampleRow[]>(emptyRows);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);

  const currencySymbol = getCurrencySymbol(currencyCode);
  const samples: MortgageTypeSample[] = rows
    .filter((row) => row.principal !== undefined && row.interest !== undefined)
    .map((row) => ({
      principal: row.principal as number,
      interest: row.interest as number,
      ...(row.balanceBefore !== undefined ? { balanceBefore: row.balanceBefore } : {}),
    }));
  const request: DetectMortgageTypeData | null = paymentFrequency
    ? { samples, interestRate: interestRate ?? null, paymentFrequency }
    : null;
  const requestKey = request ? JSON.stringify(request) : null;
  const currentAnswer = answer && answer.requestKey === requestKey ? answer : null;
  const hasIncompleteRow = rows.some(isIncomplete);
  const suggestedType = currentAnswer?.detection?.type ?? null;

  const updateRow = (index: number, field: keyof SampleRow, value: number | undefined) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  };

  const close = () => {
    setIsOpen(false);
    setRows(emptyRows());
    setAnswer(null);
  };

  const detect = async () => {
    if (!request || !requestKey) return;
    setIsDetecting(true);
    try {
      const detection = await accountsApi.detectMortgageType(request);
      setAnswer({ requestKey, detection, failed: false });
    } catch (error) {
      logger.error('Failed to detect the mortgage type:', error);
      setAnswer({ requestKey, detection: null, failed: true });
    } finally {
      setIsDetecting(false);
    }
  };

  const accept = (type: MortgageType) => {
    onUse(type);
    close();
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-expanded={false}
        className="mt-1 text-xs font-medium underline text-purple-700 dark:text-purple-400 hover:text-purple-900 dark:hover:text-purple-200"
      >
        {t('mortgageFields.detect.toggle')}
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('mortgageFields.detect.title')}
      className="mt-2 space-y-3 p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
    >
      <div>
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('mortgageFields.detect.title')}
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('mortgageFields.detect.intro')}
        </p>
      </div>

      {rows.map((row, index) => (
        <fieldset key={index}>
          <legend className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('mortgageFields.detect.installment', { number: index + 1 })}
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <CurrencyInput
              id={`mortgage-detect-principal-${index}`}
              label={t('mortgageFields.detect.principal')}
              prefix={currencySymbol}
              allowNegative={false}
              value={row.principal}
              onChange={(value) => updateRow(index, 'principal', value)}
            />
            <CurrencyInput
              id={`mortgage-detect-interest-${index}`}
              label={t('mortgageFields.detect.interest')}
              prefix={currencySymbol}
              allowNegative={false}
              value={row.interest}
              onChange={(value) => updateRow(index, 'interest', value)}
            />
            <CurrencyInput
              id={`mortgage-detect-balance-${index}`}
              label={t('mortgageFields.detect.balance')}
              prefix={currencySymbol}
              allowNegative={false}
              value={row.balanceBefore}
              onChange={(value) => updateRow(index, 'balanceBefore', value)}
            />
          </div>
          {isIncomplete(row) && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1">
              {t('mortgageFields.detect.rowIncomplete')}
            </p>
          )}
        </fieldset>
      ))}

      <p className="text-xs text-gray-500 dark:text-gray-400">
        {interestRate != null
          ? t('mortgageFields.detect.rate', { rate: formatPercentTrimmed(interestRate) })
          : t('mortgageFields.detect.noRate')}
      </p>
      {!paymentFrequency && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t('mortgageFields.detect.needsFrequency')}
        </p>
      )}

      {currentAnswer?.failed && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('mortgageFields.detect.failed')}
        </p>
      )}
      {currentAnswer?.detection && (
        <MortgageTypeSuggestion detection={currentAnswer.detection} />
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={close}>
          {t('mortgageFields.detect.close')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={detect}
          disabled={!request || hasIncompleteRow}
          isLoading={isDetecting}
        >
          {t('mortgageFields.detect.submit')}
        </Button>
        {suggestedType && (
          <Button type="button" size="sm" onClick={() => accept(suggestedType)}>
            {t('mortgageFields.detect.use')}
          </Button>
        )}
      </div>
    </div>
  );
}
