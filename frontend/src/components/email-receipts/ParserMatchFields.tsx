'use client';

import { useTranslations } from 'next-intl';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { PatternArea } from '@/components/email-receipts/ParserPatternFields';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { NumericInput } from '@/components/ui/NumericInput';
import { matchByAfterReferenceChange, type ParserFormChange, type ParserFormState } from '@/lib/receipt-parser-form';
import {
  DEFAULT_MATCH_DAYS_AFTER,
  DEFAULT_MATCH_DAYS_BEFORE,
  RECEIPT_MATCH_STRATEGIES,
  RECEIPT_MATCH_TEXT_FIELDS,
  RECEIPT_PARSER_LIMITS,
  type ReceiptMatchStrategy,
  type ReceiptMatchTextField,
} from '@/types/email-receipts';

interface ParserMatchFieldsProps {
  form: ParserFormState;
  onChange: ParserFormChange;
}

const CHECKBOX_CLASS =
  'h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600';

/**
 * "Identifying the transaction is the profile's job": the identifier the shop or
 * gateway puts into the bank operation (`reference`), the strategies tried in
 * order, where a reference is looked for, the days either side of the purchase and
 * how far the bank amount may differ. Every control writes the simple form of the
 * `match` section; what equals the default is left out of the definition, so a
 * profile that changes nothing here sends nothing.
 *
 * The form shows the effective matching the server answers (the defaults filled
 * in); the default order is the reference first when the profile has a reference
 * pattern, then the order number, the amount with the payee, the amount with the date.
 *
 * The strategies that are on are listed in the order they are tried, then the ones
 * that are off. At least one stays on: the server refuses an empty list.
 */
export function ParserMatchFields({ form, onChange }: ParserMatchFieldsProps) {
  const t = useTranslations('emailReceipts.editor.matching');
  const enabled = form.matchBy;
  const rows: ReceiptMatchStrategy[] = [
    ...enabled,
    ...RECEIPT_MATCH_STRATEGIES.filter((strategy) => !enabled.includes(strategy)),
  ];

  const toggleStrategy = (strategy: ReceiptMatchStrategy, on: boolean) =>
    onChange((current) => {
      if (on) return current.matchBy.includes(strategy) ? {} : { matchBy: [...current.matchBy, strategy] };
      // The last one stays on.
      return current.matchBy.length <= 1 ? {} : { matchBy: current.matchBy.filter((s) => s !== strategy) };
    });

  const move = (strategy: ReceiptMatchStrategy, by: -1 | 1) =>
    onChange((current) => {
      const index = current.matchBy.indexOf(strategy);
      const target = index + by;
      if (index === -1 || target < 0 || target >= current.matchBy.length) return {};
      const next = [...current.matchBy];
      [next[index], next[target]] = [next[target], next[index]];
      return { matchBy: next };
    });

  const toggleField = (field: ReceiptMatchTextField, on: boolean) =>
    onChange((current) => {
      const has = current.matchReferenceIn.includes(field);
      if (on && !has) {
        // Keep the fields in their one canonical order.
        return {
          matchReferenceIn: RECEIPT_MATCH_TEXT_FIELDS.filter(
            (candidate) => candidate === field || current.matchReferenceIn.includes(candidate),
          ),
        };
      }
      if (!on && has && current.matchReferenceIn.length > 1) {
        return { matchReferenceIn: current.matchReferenceIn.filter((candidate) => candidate !== field) };
      }
      return {};
    });

  return (
    <fieldset className="space-y-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('heading')}</legend>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('help')}</p>
      <p className="rounded-md bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-900/20 dark:text-blue-100">
        {t('instruction')}
      </p>

      <PatternArea
        id="parser-reference"
        label={t('referenceLabel')}
        hint={t('referenceHint', { capture: '{reference}' })}
        value={form.reference}
        rows={2}
        onChange={(reference) =>
          onChange((current) => ({
            reference,
            // The first reference pattern puts the reference strategy first (and the last one's removal takes it out) while the order is the default one.
            matchBy: matchByAfterReferenceChange(current.matchBy, current.reference.trim() !== '', reference.trim() !== ''),
          }))
        }
      />

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span id="parser-match-by-label" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('strategiesLabel')}
          </span>
          <InfoTooltip text={t('strategiesHelp')} placement="top" usePortal />
        </div>
        <ol aria-labelledby="parser-match-by-label" className="space-y-1">
          {rows.map((strategy) => {
            const on = enabled.includes(strategy);
            const position = enabled.indexOf(strategy);
            return (
              <li key={strategy} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={on && enabled.length <= 1}
                    onChange={(e) => toggleStrategy(strategy, e.target.checked)}
                    className={CHECKBOX_CLASS}
                  />
                  <span>
                    {on ? t('strategyPosition', { position: position + 1, name: t(`strategies.${strategy}`) }) : t(`strategies.${strategy}`)}
                  </span>
                </label>
                {on && (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(strategy, -1)}
                      disabled={position === 0}
                      aria-label={t('moveUp', { name: t(`strategies.${strategy}`) })}
                      className={`rounded p-1 text-gray-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 ${HOVER_ROW_ON_CARD}`}
                    >
                      <ArrowUpIcon className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(strategy, 1)}
                      disabled={position === enabled.length - 1}
                      aria-label={t('moveDown', { name: t(`strategies.${strategy}`) })}
                      className={`rounded p-1 text-gray-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 ${HOVER_ROW_ON_CARD}`}
                    >
                      <ArrowDownIcon className="h-4 w-4" aria-hidden />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {enabled.includes('reference') && form.reference.trim() === '' && (
          <p role="note" className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {t('referenceNeeded')}
          </p>
        )}
      </div>

      <div>
        <span id="parser-match-in-label" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('referenceInLabel')}
        </span>
        <div role="group" aria-labelledby="parser-match-in-label" className="flex flex-wrap gap-x-4 gap-y-1">
          {RECEIPT_MATCH_TEXT_FIELDS.map((field) => (
            <label key={field} className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input
                type="checkbox"
                checked={form.matchReferenceIn.includes(field)}
                disabled={form.matchReferenceIn.includes(field) && form.matchReferenceIn.length <= 1}
                onChange={(e) => toggleField(field, e.target.checked)}
                className={CHECKBOX_CLASS}
              />
              {t(`referenceIn.${field}`)}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('referenceInHint')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <NumericInput
            id="parser-match-days-before"
            label={t('daysBeforeLabel')}
            value={form.matchDaysBefore ?? undefined}
            decimalPlaces={0}
            min={0}
            max={RECEIPT_PARSER_LIMITS.maxDaysBefore}
            placeholder={String(DEFAULT_MATCH_DAYS_BEFORE)}
            onChange={(value) => onChange({ matchDaysBefore: value ?? null })}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('daysHint', { default: DEFAULT_MATCH_DAYS_BEFORE, max: RECEIPT_PARSER_LIMITS.maxDaysBefore })}
          </p>
        </div>
        <div>
          <NumericInput
            id="parser-match-days-after"
            label={t('daysAfterLabel')}
            value={form.matchDaysAfter ?? undefined}
            decimalPlaces={0}
            min={0}
            max={RECEIPT_PARSER_LIMITS.maxDaysAfter}
            placeholder={String(DEFAULT_MATCH_DAYS_AFTER)}
            onChange={(value) => onChange({ matchDaysAfter: value ?? null })}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('daysHint', { default: DEFAULT_MATCH_DAYS_AFTER, max: RECEIPT_PARSER_LIMITS.maxDaysAfter })}
          </p>
        </div>
        <div>
          <NumericInput
            id="parser-match-tolerance"
            label={t('toleranceLabel')}
            value={form.matchTolerance ?? undefined}
            decimalPlaces={2}
            min={0}
            max={RECEIPT_PARSER_LIMITS.maxAmountTolerance}
            placeholder="0"
            onChange={(value) => onChange({ matchTolerance: value ?? null })}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('toleranceHint', { max: RECEIPT_PARSER_LIMITS.maxAmountTolerance })}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
