'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export type ChartView = 'pie' | 'bar' | 'stacked' | 'line' | 'area' | 'sankey' | 'table';

interface ChartViewToggleProps {
  value: ChartView;
  onChange: (view: ChartView) => void;
  options?: ChartView[];
  activeColour?: string;
  className?: string;
}

const CHART_ICON_PATHS: Record<ChartView, string> = {
  pie: 'M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z',
  bar: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  stacked: 'M5 4 H10 V20 H5 Z M5 12 H10 M14 4 H19 V20 H14 Z M14 9 H19',
  line: 'M3 17l4-4 4 4 4-8 4 4',
  area: 'M3 17l4-4 4 4 4-8 4 4V21H3z',
  sankey: 'M3 5h4c6 0 6 6 14 6M3 5v4M3 19h4c6 0 6-8 14-8M3 15v4',
  table: 'M3 10h18M3 14h18M3 6h18M3 18h18',
};

/**
 * One chart view's icon, for a switcher that draws its own chrome (a widget
 * header's `WidgetSegmentedControl`) but should show the same pictures as this
 * toggle.
 */
export function ChartViewIcon({ view, className = 'h-5 w-5' }: { view: ChartView; className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CHART_ICON_PATHS[view]} />
    </svg>
  );
}

export function ChartViewToggle({
  value,
  onChange,
  options = ['pie', 'bar'],
  activeColour = 'bg-blue-600',
  className,
}: ChartViewToggleProps) {
  const t = useTranslations('common');
  const inactiveClasses = 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300';

  const chartTitles: Record<ChartView, string> = {
    pie: t('chartViewToggle.pieChart'),
    bar: t('chartViewToggle.barChart'),
    stacked: t('chartViewToggle.stackedChart'),
    line: t('chartViewToggle.lineChart'),
    area: t('chartViewToggle.areaChart'),
    sankey: t('chartViewToggle.sankeyChart'),
    table: t('chartViewToggle.table'),
  };

  return (
    <div className={cn('flex gap-2', className)}>
      {options.map((view) => (
        <button
          key={view}
          onClick={() => onChange(view)}
          className={cn(
            'p-2 rounded-md transition-colors',
            value === view ? `${activeColour} text-white` : inactiveClasses
          )}
          title={chartTitles[view]}
        >
          <ChartViewIcon view={view} />
        </button>
      ))}
    </div>
  );
}
