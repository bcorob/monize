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
   */
  reason?: 'scheduledFx' | 'displayFx';
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
export function UnknownAmount({ reason = 'scheduledFx', className }: UnknownAmountProps) {
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
      <InfoTooltip placement="top" text={t(`unknownAmount.${reason}`)} usePortal />
    </span>
  );
}
