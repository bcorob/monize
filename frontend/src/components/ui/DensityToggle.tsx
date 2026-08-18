'use client';

import { useTranslations } from 'next-intl';
import { useDensityPreference, type DensityView } from '@/store/densityStore';

/**
 * The one row-density control.
 *
 * Eleven surfaces drew this button themselves. Seven of them were byte-for-byte
 * identical and the other four differed only in size and placement -- but each
 * read its label from its own namespace, under five different key shapes
 * (`list.density.title`, `list.density.toggle`, `list.densityToggleTitle`,
 * `page.densityToggleTitle`, `page.density.*`), which is how the *translations*
 * drifted apart without anyone noticing. Fourteen of nineteen locales had at
 * least one string that disagreed with itself across surfaces: in Japanese
 * "Normal" was 標準 on five lists and 通常 on two, and Korean had six different
 * words for "Dense". One component reading one key is what stops that.
 *
 * Density is remembered per view, so the one thing a toggle must be told is
 * which view it belongs to. Everything else is placement.
 */

/**
 * Size is a claim about the toolbar the button lands in, not a taste. `sm` is
 * the bar above a table; `md` matches the `text-sm` controls in the investment
 * register's toolbar (a `sm` button there stands a few pixels short of its
 * neighbours -- see frontend/CLAUDE.md); `chip` is the filled pill used in the
 * Reports filter row, where the neighbours are chips rather than plain buttons.
 */
type DensityToggleSize = 'sm' | 'md' | 'chip';

const SIZE_CLASSES: Record<DensityToggleSize, string> = {
  sm: 'px-2 py-1 text-xs rounded hover:bg-gray-100 dark:hover:bg-gray-700',
  md: 'px-2 py-1.5 text-sm rounded-md hover:bg-gray-100 dark:hover:bg-gray-700',
  chip:
    'gap-2 px-3 py-1.5 text-sm rounded-md bg-gray-100 dark:bg-gray-700 ' +
    'hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors',
};

interface DensityToggleProps {
  /** Which surface's remembered level this button reads and cycles. */
  view: DensityView;
  size?: DensityToggleSize;
  /**
   * Drop the label below `sm`, leaving the icon. For a toolbar that already
   * competes for width on a phone (the transactions register's), not a default:
   * the label is what tells the user which of the three levels they are on.
   */
  hideLabelOnMobile?: boolean;
  /** Positioning only -- `ml-auto`, `flex-shrink-0`. Never colour or padding. */
  className?: string;
}

export function DensityToggle({
  view,
  size = 'sm',
  hideLabelOnMobile = false,
  className = '',
}: DensityToggleProps) {
  const t = useTranslations('common');
  const { density, cycleDensity } = useDensityPreference(view);

  const label =
    density === 'normal'
      ? t('density.normal')
      : density === 'compact'
        ? t('density.compact')
        : t('density.dense');

  return (
    <button
      onClick={cycleDensity}
      className={
        'inline-flex items-center font-medium text-gray-600 dark:text-gray-300 ' +
        `hover:text-gray-900 dark:hover:text-gray-100 ${SIZE_CLASSES[size]} ${className}`
      }
      title={t('density.title')}
    >
      <svg
        className={`w-4 h-4 ${hideLabelOnMobile ? 'sm:mr-1' : 'mr-1'}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 6h16M4 12h16M4 18h16"
        />
      </svg>
      {hideLabelOnMobile ? <span className="hidden sm:inline">{label}</span> : label}
    </button>
  );
}

/**
 * The strip a table hangs its toggle from: right-aligned, on the table's own
 * header ground, ruled off from the rows below. Seven lists repeated it.
 */
export function DensityToggleBar({ view }: { view: DensityView }) {
  return (
    <div className="flex justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      <DensityToggle view={view} />
    </div>
  );
}
