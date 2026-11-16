'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { GroupToggleButton } from '@/components/ui/GroupToggleButton';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { toSafeExternalUrl } from '@/lib/external-url';
import type { HistorySeries } from '@/types/bond';

/** Group key of a series whose terms carry no sale window. */
const UNKNOWN_YEAR = 'unknown';

interface YearGroup {
  key: string;
  series: HistorySeries[];
}

/**
 * The stored series by the year their sale window opened, newest year first and
 * newest series first inside it; series without a window come last. One series
 * is sold per month and kind, so there is no month level.
 */
function groupSeriesByYear(series: readonly HistorySeries[]): YearGroup[] {
  const sorted = [...series].sort((a, b) =>
    (b.saleWindow?.from ?? '').localeCompare(a.saleWindow?.from ?? ''),
  );
  const groups = new Map<string, HistorySeries[]>();
  for (const s of sorted) {
    const key = s.saleWindow === null ? UNKNOWN_YEAR : s.saleWindow.from.slice(0, 4);
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, series: rows }));
}

interface BondHistorySeriesTableProps {
  series: readonly HistorySeries[];
  /** The currency the product issues in; null when the catalog does not say. */
  currency: string | null;
  /** Series codes the reader holds: highlighted and badged. */
  heldSeries?: readonly string[];
}

/**
 * Every stored series of a product, in collapsible year groups like the price
 * history of other securities. The newest year starts open.
 */
export function BondHistorySeriesTable({
  series,
  currency,
  heldSeries = [],
}: BondHistorySeriesTableProps) {
  const t = useTranslations('bonds');
  const tSec = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber, formatPercentTrimmed } = useNumberFormat();
  const groups = groupSeriesByYear(series);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set(groups[0] ? [groups[0].key] : []),
  );

  const toggle = (key: string) =>
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">{tSec('bond.unknown')}</span>
  );
  const rate = (fraction: string | null): ReactNode =>
    fraction === null ? unknown : formatPercentTrimmed(Number(fraction) * 100);
  const feeText = (amount: number) =>
    currency === null ? formatNumber(amount) : formatCurrency(amount, currency);
  const termsSource = (s: HistorySeries): ReactNode => {
    const label = tSec('bond.termsSource', { document: s.termsSource.document });
    return toSafeExternalUrl(s.termsSource.url) ? (
      <a
        href={s.termsSource.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        {label}
      </a>
    ) : (
      label
    );
  };

  return (
    <div className="space-y-2">
      {groups.map((group) => {
        const open = openGroups.has(group.key);
        return (
          <div
            key={group.key}
            className="rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <GroupToggleButton
              open={open}
              onToggle={() => toggle(group.key)}
              label={group.key === UNKNOWN_YEAR ? t('history.unknownYear') : group.key}
              detail={t('history.groupCount', { count: group.series.length })}
            />
            {open && (
              <div className="overflow-x-auto scrollbar-slim border-t border-gray-200 px-2 pb-2 pt-1 dark:border-gray-700">
                <table className={TABLE_CLASS}>
                  <thead>
                    <tr>
                      <Th>{t('history.columns.series')}</Th>
                      <Th>{t('history.columns.saleWindow')}</Th>
                      <Th align="right">{t('history.columns.rate')}</Th>
                      <Th align="right" className="hidden sm:table-cell">
                        {t('history.columns.addend')}
                      </Th>
                      <Th align="right" className="hidden sm:table-cell">
                        {t('history.columns.fee')}
                      </Th>
                      <Th className="hidden md:table-cell">{t('history.columns.floor')}</Th>
                      <Th align="right" className="hidden lg:table-cell">
                        {t('history.columns.version')}
                      </Th>
                      <Th className="hidden sm:table-cell">{t('history.columns.source')}</Th>
                    </tr>
                  </thead>
                  <tbody className={TABLE_BODY_CLASS}>
                    {group.series.map((s) => {
                      const held = heldSeries.includes(s.seriesCode);
                      return (
                        <tr
                          key={s.seriesCode}
                          aria-current={held ? 'true' : undefined}
                          className={held ? 'bg-blue-50 dark:bg-blue-900/20' : undefined}
                        >
                          <Td className="whitespace-nowrap font-medium">
                            {s.seriesCode}
                            {held && (
                              <Badge variant="blue" className="ml-2">
                                {t('history.held')}
                              </Badge>
                            )}
                          </Td>
                          <Td>
                            {s.saleWindow === null
                              ? tSec('bond.unknown')
                              : t('offer.saleWindowValue', {
                                  from: formatDate(s.saleWindow.from),
                                  to: formatDate(s.saleWindow.to),
                                })}
                          </Td>
                          <Td align="right" className="whitespace-nowrap">
                            {rate(s.firstPeriodRate ?? s.annualRate)}
                          </Td>
                          <Td align="right" className="whitespace-nowrap hidden sm:table-cell">
                            {s.addend === null ? t('history.none') : rate(s.addend)}
                          </Td>
                          <Td align="right" className="whitespace-nowrap hidden sm:table-cell">
                            {s.fee === null ? t('history.none') : feeText(Number(s.fee))}
                          </Td>
                          <Td className="hidden md:table-cell">
                            {s.proceedsFloor === null
                              ? t('history.none')
                              : t(`history.floor.${s.proceedsFloor}`)}
                          </Td>
                          <Td align="right" className="hidden lg:table-cell">
                            {s.termsVersion}
                          </Td>
                          <Td className="hidden sm:table-cell">{termsSource(s)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
