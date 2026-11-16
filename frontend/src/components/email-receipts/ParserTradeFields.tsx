'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PatternArea, ParserSourceField } from '@/components/email-receipts/ParserPatternFields';
import { TradeAccountRulesFields } from '@/components/email-receipts/TradeAccountRulesFields';
import { TradeCurrencyMarkersFields } from '@/components/email-receipts/TradeCurrencyMarkersFields';
import type { ReceiptParserAccountOption } from '@/hooks/useReceiptParserLookups';
import { preferredCurrency } from '@/lib/default-currency';
import {
  GUARD_FIELDS,
  tradeCurrencyChoices,
  type ParserFormChange,
  type ParserFormState,
  type TradePatternFormField,
} from '@/lib/receipt-parser-form';
import { usePreferencesStore } from '@/store/preferencesStore';

interface ParserTradeFieldsProps {
  form: ParserFormState;
  accounts: readonly ReceiptParserAccountOption[];
  /** The user's active currency codes. */
  currencyCodes: readonly string[];
  onChange: ParserFormChange;
}

/** Each trade field, the capture its patterns must hold and an example line. */
const TRADE_FIELDS: ReadonlyArray<{ field: TradePatternFormField; id: string; capture: string; example: string }> = [
  { field: 'tradeAction', id: 'parser-trade-action', capture: '{action}', example: 'Order type: {action}' },
  { field: 'tradeSymbol', id: 'parser-trade-symbol', capture: '{symbol}', example: 'Symbol: {symbol}' },
  { field: 'tradeQuantity', id: 'parser-trade-quantity', capture: '{quantity}', example: 'Quantity: {quantity} shares' },
  { field: 'tradeTotal', id: 'parser-trade-total', capture: '{amount}', example: 'Total cost: {amount}' },
  { field: 'tradePrice', id: 'parser-trade-price', capture: '{amount}', example: 'Average price: {amount}' },
  { field: 'tradeCommission', id: 'parser-trade-commission', capture: '{amount}', example: 'Commission: {amount}' },
  { field: 'tradeDate', id: 'parser-trade-date', capture: '{date}', example: 'Filled on {date}' },
  { field: 'tradeAccount', id: 'parser-trade-account', capture: '{account}', example: 'Account: {account}' },
];

const GUARD_IDS: Record<(typeof GUARD_FIELDS)[number], string> = {
  requireLine: 'parser-require-line',
  skipIfLine: 'parser-skip-if-line',
  waitIfLine: 'parser-wait-if-line',
};

/**
 * The form of a brokerage trade profile: the lines source and the line guards
 * (the only receipt keys a trade profile keeps), the pattern lists the trade is
 * read from, which account it books to, and what names its currency. The
 * receipt's payee, amounts, items, categories, matching and tag do not apply:
 * the email becomes one investment transaction, not a purchase matched to a bank
 * transaction.
 */
export function ParserTradeFields({ form, accounts, currencyCodes, onChange }: ParserTradeFieldsProps) {
  const t = useTranslations('emailReceipts.editor.trade');
  const baseCurrency = preferredCurrency(usePreferencesStore((state) => state.preferences?.defaultCurrency));
  // A code a rule or a marker already holds stays offered, even when it is not an active currency.
  const currencies = useMemo(
    () =>
      tradeCurrencyChoices(baseCurrency, currencyCodes, [
        ...form.tradeAccountRules.map((rule) => rule.currency),
        ...form.tradeCurrencyMarkers.map((marker) => marker.currency),
      ]),
    [baseCurrency, currencyCodes, form.tradeAccountRules, form.tradeCurrencyMarkers],
  );

  const area = ({ field, id, capture, example }: (typeof TRADE_FIELDS)[number], rows = 2) => (
    <PatternArea
      key={field}
      id={id}
      label={t(`fields.${field}`)}
      hint={t('fieldHint', { capture, example })}
      value={form[field]}
      rows={rows}
      onChange={(value) => onChange({ [field]: value })}
    />
  );
  const [action, symbol, quantity, total, price, commission, date, account] = TRADE_FIELDS;

  return (
    <div className="space-y-4">
      <ParserSourceField form={form} onChange={onChange} />

      <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('guardsHeading')}</legend>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('guardsHelp')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {GUARD_FIELDS.map((field) => (
            <PatternArea
              key={field}
              id={GUARD_IDS[field]}
              label={t(`guards.${field}`)}
              hint={t(`guards.${field}Hint`)}
              value={form[field]}
              rows={2}
              onChange={(value) => onChange({ [field]: value })}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('fieldsHeading')}</legend>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('fieldsHelp')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {area(action)}
          {area(symbol)}
          {area(quantity)}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {area(total)}
          {area(price)}
          {area(commission)}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('amountsHelp')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {area(date)}
          {area(account)}
        </div>
      </fieldset>

      <TradeAccountRulesFields
        form={form}
        accounts={accounts}
        currencies={currencies}
        baseCurrency={baseCurrency}
        onChange={onChange}
      />
      <TradeCurrencyMarkersFields form={form} currencies={currencies} baseCurrency={baseCurrency} onChange={onChange} />
    </div>
  );
}
