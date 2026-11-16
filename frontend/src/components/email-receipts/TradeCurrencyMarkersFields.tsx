'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PlusIcon } from '@heroicons/react/24/outline';
import { tradeCurrencyOptions } from '@/components/email-receipts/TradeAccountRulesFields';
import { moveRow, TradeRowButtons } from '@/components/email-receipts/TradeRowButtons';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  newTradeCurrencyMarker,
  type ParserFormChange,
  type ParserFormState,
  type TradeCurrencyMarkerRow,
} from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS } from '@/types/email-receipts';

interface TradeCurrencyMarkersFieldsProps {
  form: ParserFormState;
  /** The codes to offer, the base currency first (`tradeCurrencyChoices`). */
  currencies: readonly string[];
  baseCurrency: string;
  onChange: ParserFormChange;
}

/**
 * Text that names the trade's currency when its amounts do not ("Amounts in
 * U.S. dollars", a bare `$` beside it): each marker is a glob tested against
 * every line of the email, and the first marker, in order, that matches a line
 * names the currency. It is asked only when the amount names none, and before
 * the security's own currency.
 */
export function TradeCurrencyMarkersFields({ form, currencies, baseCurrency, onChange }: TradeCurrencyMarkersFieldsProps) {
  const t = useTranslations('emailReceipts.editor.trade');
  const markers = form.tradeCurrencyMarkers;
  const atMax = markers.length >= RECEIPT_PARSER_LIMITS.maxTradeCurrencyMarkers;
  const currencyOptions = useMemo(
    () => tradeCurrencyOptions(currencies, baseCurrency, { value: '', label: t('currencyPlaceholder') }, t),
    [currencies, baseCurrency, t],
  );

  const update = (id: string, changes: Partial<TradeCurrencyMarkerRow>) =>
    onChange((current) => ({
      tradeCurrencyMarkers: current.tradeCurrencyMarkers.map((marker) => (marker.id === id ? { ...marker, ...changes } : marker)),
    }));
  const move = (id: string, by: -1 | 1) =>
    onChange((current) => ({
      tradeCurrencyMarkers: moveRow(
        current.tradeCurrencyMarkers,
        current.tradeCurrencyMarkers.findIndex((marker) => marker.id === id),
        by,
      ),
    }));
  const remove = (id: string) =>
    onChange((current) => ({ tradeCurrencyMarkers: current.tradeCurrencyMarkers.filter((marker) => marker.id !== id) }));
  const add = () =>
    onChange((current) =>
      current.tradeCurrencyMarkers.length >= RECEIPT_PARSER_LIMITS.maxTradeCurrencyMarkers
        ? {}
        : { tradeCurrencyMarkers: [...current.tradeCurrencyMarkers, newTradeCurrencyMarker()] },
    );

  return (
    <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('markersHeading')}</legend>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('markersHelp', { star: '*' })}</p>

      {markers.length > 0 && (
        <ol className="space-y-2">
          {markers.map((marker, index) => {
            const number = index + 1;
            return (
              <li key={marker.id} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                <Input
                  id={`parser-trade-marker-${marker.id}-match`}
                  aria-label={t('markerMatchLabel', { marker: number })}
                  placeholder={t('markerMatchPlaceholder')}
                  value={marker.match}
                  maxLength={RECEIPT_PARSER_LIMITS.maxPatternLength}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(e) => update(marker.id, { match: e.target.value })}
                />
                <Select
                  id={`parser-trade-marker-${marker.id}-currency`}
                  aria-label={t('markerCurrencyLabel', { marker: number })}
                  value={marker.currency}
                  options={currencyOptions}
                  onChange={(e) => update(marker.id, { currency: e.target.value })}
                />
                <TradeRowButtons
                  index={index}
                  count={markers.length}
                  labels={{
                    up: t('markerMoveUp', { marker: number }),
                    down: t('markerMoveDown', { marker: number }),
                    remove: t('markerRemove', { marker: number }),
                  }}
                  onMove={(by) => move(marker.id, by)}
                  onRemove={() => remove(marker.id)}
                />
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={atMax} className="gap-1.5">
          <PlusIcon className="h-4 w-4" aria-hidden />
          {t('markerAdd')}
        </Button>
        {atMax && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('markersMax', { max: RECEIPT_PARSER_LIMITS.maxTradeCurrencyMarkers })}
          </span>
        )}
      </div>
    </fieldset>
  );
}
