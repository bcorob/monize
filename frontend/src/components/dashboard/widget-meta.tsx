'use client';

import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  ArrowPathIcon,
  ArrowTrendingUpIcon,
  ArrowsUpDownIcon,
  BanknotesIcon,
  BookmarkIcon,
  BriefcaseIcon,
  BuildingLibraryIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  CalendarIcon,
  ChartBarIcon,
  ChartPieIcon,
  ClipboardDocumentCheckIcon,
  CreditCardIcon,
  GlobeAltIcon,
  LightBulbIcon,
  PresentationChartLineIcon,
  RectangleGroupIcon,
  ScaleIcon,
  StarIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
// Type-only import: erased at compile time, so no runtime cycle with the
// registry (which imports the widgets, which import WidgetCard, which
// imports this file).
import type { DashboardWidgetId } from './widget-registry';

type WidgetIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Per-widget icon for the dashboard card headers. Distinct per widget on
 * purpose -- the registry's `iconType` (bar/line/pie/table/list) is about the
 * visualization kind and repeats five glyphs across 22 widgets, which is no
 * differentiation at all. `widget-meta.test.tsx` holds "every registered
 * widget has an icon".
 */
export const WIDGET_ICONS: Record<DashboardWidgetId, WidgetIconComponent> = {
  'favourite-accounts': BuildingLibraryIcon,
  'upcoming-bills': CalendarDaysIcon,
  'top-movers': ArrowTrendingUpIcon,
  'favourite-securities': StarIcon,
  'portfolio-value': PresentationChartLineIcon,
  'net-worth': ScaleIcon,
  'assets-liabilities': BanknotesIcon,
  'expenses-pie': ChartPieIcon,
  'income-expenses': ArrowsUpDownIcon,
  'budget-status': ClipboardDocumentCheckIcon,
  insights: LightBulbIcon,
  'favourite-reports': BookmarkIcon,
  'spending-by-payee': UsersIcon,
  'monthly-spending-trend': ChartBarIcon,
  'income-by-source': BriefcaseIcon,
  'credit-utilization-accounts': CreditCardIcon,
  'credit-utilization-total': CreditCardIcon,
  'sector-weightings': BuildingOffice2Icon,
  'security-type-allocation': RectangleGroupIcon,
  'geographic-allocation': GlobeAltIcon,
  'recurring-expenses': ArrowPathIcon,
  'weekend-weekday': CalendarIcon,
};

/**
 * The tinted icon puck before a widget title. Blue ramp only, so every
 * colour theme re-tints it through its own accent.
 */
export function WidgetIconPuck({ id }: { id: DashboardWidgetId }) {
  const Icon = WIDGET_ICONS[id];
  if (!Icon) return null;
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300"
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

const TITLE_CLASS = 'text-lg font-semibold text-gray-900 dark:text-gray-100';

/**
 * Icon puck + title for the widgets that draw their own card header (the
 * core widgets predating `WidgetCard`). With `onClick` the title is the
 * usual navigate-button; without, a plain heading.
 */
export function WidgetHeading({
  id,
  onClick,
  className = '',
  children,
}: {
  id: DashboardWidgetId;
  onClick?: () => void;
  /** Extra classes on the wrapper (e.g. `mb-4` where the heading stands alone). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${className}`}>
      <WidgetIconPuck id={id} />
      {onClick ? (
        <button
          onClick={onClick}
          className={`${TITLE_CLASS} truncate text-left hover:text-blue-600 dark:hover:text-blue-400 transition-colors`}
        >
          {children}
        </button>
      ) : (
        <h3 className={`${TITLE_CLASS} truncate`}>{children}</h3>
      )}
    </div>
  );
}
