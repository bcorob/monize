'use client';

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

interface UnknownAmountProps {
  /**
   * Why this figure is unknown, as a catalog key under `common.unknownAmount`.
   * Defaults to the scheduled-occurrence case (issue #1247): the server could
   * not resolve the current settlement exchange rate.
   *
   * `displayFx` is the other half of the same story and a different fix: the
   * component's own amount is known, in a currency with no rate into the one this
   * figure is reported in. Telling the reader to check the security's currency
   * when what is missing is a display rate sends them to the wrong screen.
   *
   * `noPrice` is a third cause with a third fix and no exchange rate in it at
   * all: the quantity is known, and the security has no quoted price to value it
   * at. Naming a currency pair here would send the reader to the Currencies page
   * over a rate that is already there.
   *
   * `noBaseline` is the fourth, and the only one with NO fix: the figure is a
   * comparison and there is nothing earlier to compare against -- the first day
   * a scope held anything. Nothing is missing and nothing can be added, so the
   * copy sends the reader nowhere. Reaching for one of the three above here
   * would invent an errand out of a boundary.
   *
   * `staleQuote` is the fifth: the figure is a day's move, and the security's
   * most recent price is older than the last trading session, so there is no
   * current day to have moved over. Reaching for `noPrice` here would send the
   * reader looking for a price that is already stored -- what is missing is a
   * *recent* one.
   *
   * `unknownCurrency` is the sixth, and the only one where the NUMBER is known
   * and its unit is not: an investment row naming no security has no security
   * currency, and its price and total are denominated in that currency. No rate
   * is missing, so `displayFx` would send the reader to the Currencies page over
   * a conversion nobody asked for; what is missing is the security on the row.
   */
  reason?:
    | 'scheduledFx'
    | 'displayFx'
    | 'noPrice'
    | 'noBaseline'
    | 'staleQuote'
    | 'noCashBalance'
    | 'unknownCurrency';
  /**
   * A tooltip the caller composed from its own catalog, for a cause that has no
   * entry under `common.unknownAmount`. Wins over `reason`.
   */
  reasonText?: string;
  /** Extra classes for the wrapper, so a table cell can keep its alignment. */
  className?: string;
}

/**
 * A single money figure the server could not work out, drawn as such.
 *
 * The two wrong answers are a stale number and a zero: a scheduled investment
 * whose settlement currency pair no longer resolves has an amount nobody knows,
 * and printing either the persisted snapshot or `0.00` reads as a measurement
 * (issue #1247). `PartialTotal` is the sibling for an aggregate that is missing
 * components; this is for the one value that is missing entirely.
 *
 * The marker is a visible glyph plus a tooltip that says why, never colour
 * alone, and the reason is available to assistive technology.
 */
export function UnknownAmount({ reason = 'scheduledFx', reasonText, className }: UnknownAmountProps) {
  const t = useTranslations('common');

  return (
    <span
      className={`inline-flex items-baseline gap-1 ${className ?? ''}`}
      data-testid="unknown-amount"
    >
      <span className="text-gray-500 dark:text-gray-400" aria-hidden="true">
        {t('unknownAmount.marker')}
      </span>
      <span className="sr-only">{t('unknownAmount.srLabel')}</span>
      <InfoTooltip placement="top" text={reasonText ?? t(`unknownAmount.${reason}`)} usePortal />
    </span>
  );
}
