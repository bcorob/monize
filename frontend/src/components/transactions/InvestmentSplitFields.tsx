'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { NumericInput } from '@/components/ui/NumericInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { investmentsApi } from '@/lib/investments';
import {
  EMBEDDED_INVESTMENT_SPLIT_ACTIONS,
  computeInvestmentCashImpact,
} from '@/lib/investmentCashImpact';
import {
  FX_RATE_DISPLAY_DECIMALS,
  roundToDecimals,
  roundFxRate,
  getCurrencySymbol,
} from '@/lib/format';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { InvestmentAction, Security } from '@/types/investment';
import { InvestmentSplitDetails } from '@/types/transaction';
import { baseInvestmentAction } from '@/lib/investment-actions';

interface InvestmentSplitFieldsProps {
  value: InvestmentSplitDetails | undefined;
  onChange: (
    next: InvestmentSplitDetails,
    computedAmount: number,
    // Real intent for the FX rate on this emit (issue #1167 R9): `rateEdited` when
    // the user changed the rate input, `securityChanged` when the selected
    // security (and thus the settlement pair) changed. The parent turns these
    // into the row's `exchangeRateEdited` latch.
    meta: { rateEdited: boolean; securityChanged: boolean },
  ) => void;
  disabled?: boolean;
  currencyCode?: string;
  /**
   * The parent transaction's date (`YYYY-MM-DD`). The rate prefills from the rate
   * for THIS day (INV-FX-001), never the latest; without a date nothing is
   * looked up and the rate stays unresolved until the person types one.
   */
  transactionDate?: string;
  /**
   * The row's `exchangeRateEdited` latch: the person typed this rate, so a pair
   * or date change does not ask again.
   */
  rateEdited?: boolean;
}

const ACTION_LABELS: Record<InvestmentAction, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  INTEREST: 'Interest',
  CAPITAL_GAIN: 'Capital Gain',
  REINVEST: 'Reinvest',
  SPLIT: 'Split',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  ADD_SHARES: 'Add Shares',
  REMOVE_SHARES: 'Remove Shares',
  REINVEST_INTEREST: 'Reinvest Interest',
  REINVEST_CAPITAL_GAIN_SHORT: 'Reinvest Short-Term Cap Gain',
  REINVEST_CAPITAL_GAIN_LONG: 'Reinvest Long-Term Cap Gain',
  CAPITAL_GAIN_SHORT: 'Short-Term Capital Gain',
  CAPITAL_GAIN_LONG: 'Long-Term Capital Gain',
  REDEEM: 'Redeem CD/Bond',
  RETURN_OF_CAPITAL: 'Return of Capital',
};

const ACTIONS_NEEDING_SECURITY: ReadonlySet<InvestmentAction> = new Set([
  'BUY',
  'SELL',
  'REINVEST',
  'DIVIDEND',
  'CAPITAL_GAIN',
  'RETURN_OF_CAPITAL',
]);

const ACTIONS_NEEDING_QUANTITY_PRICE: ReadonlySet<InvestmentAction> = new Set([
  'BUY',
  'SELL',
  'REINVEST',
]);

export function InvestmentSplitFields({
  value,
  onChange,
  disabled = false,
  currencyCode = 'CAD',
  transactionDate,
  rateEdited = false,
}: InvestmentSplitFieldsProps) {
  const t = useTranslations('transactions');
  const [securities, setSecurities] = useState<Security[]>([]);

  useEffect(() => {
    investmentsApi
      .getSecurities()
      .then(setSecurities)
      .catch(() => {
        /* fail silently - editor stays usable without the dropdown */
      });
  }, []);

  const action: InvestmentAction = value?.action ?? 'BUY';
  const quantity = value?.quantity ?? 0;
  const price = value?.price ?? 0;
  const commission = value?.commission ?? 0;

  /**
   * Quantity, price and commission are all in the SECURITY's currency -- that is
   * how the backend reads them, and `exchangeRate` is what converts the resulting
   * cash impact into the cash account's currency. These inputs used to be
   * labelled with the *account's* symbol, so a USD security bought from a CAD
   * account asked for its price under a CAD sign and got a number the server then
   * read as USD.
   */
  const selectedSecurity = securities.find((s) => s.id === value?.securityId);
  const securityCurrency = selectedSecurity?.currencyCode ?? currencyCode;
  const symbol = getCurrencySymbol(securityCurrency);
  const crossCurrency = securityCurrency !== currencyCode;

  /**
   * The rate the split will be converted at.
   *
   * It used to default to 1 with no input to change it, so a cross-currency
   * investment split recorded the unconverted figure as its cash impact -- and
   * the investment row written beside it used the server-resolved rate, so the
   * two halves of one split described different amounts of money. 1 is only the
   * answer when the two currencies match.
   */
  const statedRate = value?.exchangeRate;
  const effectiveRate = crossCurrency ? (statedRate ?? undefined) : 1;
  const rateUnresolved = crossCurrency && !(Number(effectiveRate) > 0);

  const updateField = <K extends keyof InvestmentSplitDetails>(
    field: K,
    fieldValue: InvestmentSplitDetails[K],
    // A prefilled rate is not the person's edit: it must not latch.
    intent: { prefill?: boolean } = {},
  ) => {
    const securityChanged =
      field === 'securityId' && fieldValue !== value?.securityId;
    const next: InvestmentSplitDetails = {
      action,
      securityId: value?.securityId,
      quantity,
      price,
      commission,
      // Carry the rate in force, so the payload states the conversion the
      // computed amount was derived from rather than leaving the server to
      // resolve a possibly different one.
      exchangeRate: effectiveRate,
      // Preserve the server-recorded currency pair across every field edit
      // (issue #1167 F2): dropping it made an edited rate arrive with no
      // provenance, so the server treated it as unknown and re-resolved -- losing
      // the user's figure. Kept here, an unchanged rate still reads as still-valid
      // and only a genuinely edited one is re-derived (by id, server-side).
      exchangeRateFromCurrency: value?.exchangeRateFromCurrency,
      exchangeRateToCurrency: value?.exchangeRateToCurrency,
      description: value?.description,
      ...(field === 'action' ? { action: fieldValue as InvestmentAction } : {}),
      [field]: fieldValue,
    };

    // A security change moves the settlement pair, so the rate in force (which may
    // be the same-currency 1, or a rate resolved for the *old* pair) must not
    // carry over onto the new pair (issue #1167 R9-F3): a stale 1 blessed as the
    // new pair's rate books the trade unconverted. Leave it unresolved
    // (undefined) for a cross-currency pair, or 1 when the new pair is
    // same-currency; the dated lookup below fills the rate in for the trade date.
    // Clear the recorded pair too, so no stale scalar is blessed for a pair it
    // was not resolved for.
    if (securityChanged) {
      const nextSecurity = securities.find((s) => s.id === next.securityId);
      const nextSecurityCurrency = nextSecurity?.currencyCode ?? currencyCode;
      const nextCross = nextSecurityCurrency !== currencyCode;
      next.exchangeRate = nextCross ? undefined : 1;
      next.exchangeRateFromCurrency = undefined;
      next.exchangeRateToCurrency = undefined;
    }

    const cashImpact = computeInvestmentCashImpact(
      next.action,
      Number(next.quantity ?? 0),
      Number(next.price ?? 0),
      Number(next.commission ?? 0),
    );
    // No rate means the cash impact is unknown, not unconverted: emit 0 so the
    // split cannot balance silently, and the alert below says why.
    //
    // Round to 4dp, not cents: money is decimal(20,4) and the backend validates
    // this amount against `roundMoney(cashImpact * rate)` (4dp) both in
    // `validateSplits` and where the embedded investment row is written. Cents
    // (2dp) here disagreed with that 4dp figure for any rate whose product has a
    // sub-cent digit -- i.e. essentially every real FX rate -- so a legitimate
    // cross-currency split was rejected at commit. This matches the top-level
    // investment form, which already converts at 4dp.
    const rate = Number(next.exchangeRate);
    const amount = rate > 0 ? roundToDecimals(cashImpact * rate, 4) : 0;
    onChange(next, amount, {
      rateEdited: field === 'exchangeRate' && !intent.prefill,
      securityChanged,
    });
  };

  // Prefill the rate for the PARENT'S DATE (INV-FX-001), never the latest. Keyed
  // on pair and day: a change of either asks again unless the person typed the
  // rate (`rateEdited`). A rate the row already carried on load is kept for the
  // pair and day it was committed for. The answer is adopted only while its
  // request is current (the cleanup cancels a superseded one), and a null answer
  // or a failed request leaves the rate unresolved rather than falling back.
  const latest = useRef({ updateField, statedRate });
  useEffect(() => {
    latest.current = { updateField, statedRate };
  });
  const keptRateKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!crossCurrency || rateEdited) return;
    if (!transactionDate || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) return;
    const rateKey = `${securityCurrency}->${currencyCode}@${transactionDate}`;
    if (keptRateKeyRef.current === undefined) {
      const stated = latest.current.statedRate;
      keptRateKeyRef.current = stated !== undefined && stated > 0 ? rateKey : null;
    }
    if (keptRateKeyRef.current === rateKey) return;
    keptRateKeyRef.current = null;
    let cancelled = false;
    // The rate in force answered another pair or day; do not leave it standing
    // while the new one is in flight.
    if (latest.current.statedRate !== undefined) {
      latest.current.updateField('exchangeRate', undefined, { prefill: true });
    }
    exchangeRatesApi
      .getRateForDate(securityCurrency, currencyCode, transactionDate)
      .then((rate) => {
        if (cancelled || rate === null || !(rate > 0)) return;
        latest.current.updateField('exchangeRate', roundFxRate(rate), { prefill: true });
      })
      .catch(() => {
        /* unresolved: the alert below says so */
      });
    return () => {
      cancelled = true;
    };
  }, [crossCurrency, rateEdited, transactionDate, securityCurrency, currencyCode]);

  // Base-normalized so the Money-vocabulary refinements behave as their base.
  const needsSecurity = ACTIONS_NEEDING_SECURITY.has(baseInvestmentAction(action));
  const needsQtyPrice = ACTIONS_NEEDING_QUANTITY_PRICE.has(baseInvestmentAction(action));

  return (
    <div className="space-y-2 p-2 bg-gray-50 dark:bg-gray-800 rounded">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Select
          options={EMBEDDED_INVESTMENT_SPLIT_ACTIONS.map((a) => ({
            value: a,
            label: ACTION_LABELS[a],
          }))}
          value={action}
          onChange={(e) => updateField('action', e.target.value as InvestmentAction)}
          disabled={disabled}
          aria-label={t('investmentSplit.ariaAction')}
        />
        {needsSecurity && (
          <Select
            options={[
              { value: '', label: t('investmentSplit.selectSecurity') },
              ...securities.map((s) => ({
                value: s.id,
                label: `${s.symbol} - ${s.name}`,
              })),
            ]}
            value={value?.securityId ?? ''}
            onChange={(e) => updateField('securityId', e.target.value || undefined)}
            disabled={disabled}
            aria-label={t('investmentSplit.ariaSecurity')}
          />
        )}
      </div>
      {needsQtyPrice && (
        <div className="grid grid-cols-3 gap-2">
          <NumericInput
            value={quantity || undefined}
            onChange={(v) => updateField('quantity', Number(v ?? 0))}
            decimalPlaces={8}
            min={0}
            disabled={disabled}
            placeholder={t('investmentSplit.quantityPlaceholder')}
          />
          <NumericInput
            value={price || undefined}
            onChange={(v) => updateField('price', Number(v ?? 0))}
            decimalPlaces={6}
            min={0}
            disabled={disabled}
            placeholder={t('investmentSplit.pricePlaceholder')}
            prefix={symbol}
          />
          <CurrencyInput
            value={commission || undefined}
            onChange={(v) => updateField('commission', Number(v ?? 0))}
            disabled={disabled}
            placeholder={t('investmentSplit.commissionPlaceholder')}
            prefix={symbol}
            allowNegative={false}
          />
        </div>
      )}
      {!needsQtyPrice && (
        <CurrencyInput
          value={price || undefined}
          onChange={(v) => updateField('price', Number(v ?? 0))}
          disabled={disabled}
          placeholder={t('investmentSplit.amountOnlyPlaceholder')}
          prefix={symbol}
          allowNegative={false}
        />
      )}
      {crossCurrency && (
        <div className="space-y-1">
          <NumericInput
            value={effectiveRate}
            onChange={(v) => {
              const incoming = v !== undefined && v > 0 ? v : undefined;
              // The field shows 6dp but a rate -- market-derived OR stored -- can
              // carry up to 10dp, so a blur on the untouched field re-reports the
              // 6dp rounding of it. `NumericInput` suppresses a no-op only when the
              // re-parsed text equals its value, which a display-truncated >6dp
              // rate never does, so the re-report arrives here. Do not turn it into
              // a user edit: that would latch `rateEdited` and stamp the current
              // settlement pair onto a truncated, possibly stale-pair scalar --
              // reopening the #1167 bug class through a no-typing focus+blur. Ignore
              // any incoming value equal to the effective rate at display precision,
              // whether the rate came from the market or from a stored override.
              if (
                incoming !== undefined &&
                roundToDecimals(Number(effectiveRate) || 0, FX_RATE_DISPLAY_DECIMALS) ===
                  roundToDecimals(incoming, FX_RATE_DISPLAY_DECIMALS)
              ) {
                return;
              }
              updateField('exchangeRate', incoming);
            }}
            decimalPlaces={FX_RATE_DISPLAY_DECIMALS}
            min={0}
            disabled={disabled}
            placeholder={t('investmentSplit.ratePlaceholder', {
              from: securityCurrency,
              to: currencyCode,
            })}
            aria-label={t('investmentSplit.ariaRate', {
              from: securityCurrency,
              to: currencyCode,
            })}
          />
          {rateUnresolved ? (
            <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
              {t('investmentSplit.rateUnresolved', {
                from: securityCurrency,
                to: currencyCode,
              })}
            </p>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('investmentSplit.rateHint', {
                from: securityCurrency,
                to: currencyCode,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
