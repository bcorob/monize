'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { CategoryGlyph } from '@/components/categories/CategoryGlyph';
import { useLongPress } from '@/hooks/useLongPress';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { SubcategoryShare } from '@/lib/categoryUtils';
import type { Category } from '@/types/category';

interface CategorySubcategoriesTabProps {
  /** The category whose children are listed. */
  category: Category;
  /** The user's full category list, for the children's own colours. */
  categories: Category[];
  /**
   * Direct-child buckets from `rollupToDirectChildren` (all-time). A child
   * with no transactions anywhere in its subtree has no bucket, and its
   * figures render as em dashes rather than as measured zeros -- "never used"
   * and "nets to zero" are different answers.
   */
  shares: SubcategoryShare[];
  currencyCode: string;
  /** Open a child category's own detail page. */
  onSelectChild: (categoryId: string) => void;
}

/**
 * The category's direct children, each with its subtree's all-time total and
 * transaction count, ordered largest first. A row click opens the child's own
 * detail page -- the same convention as every other list in the app.
 */
export function CategorySubcategoriesTab({
  category,
  categories,
  shares,
  currencyCode,
  onSelectChild,
}: CategorySubcategoriesTabProps) {
  const t = useTranslations('categoryDetail');
  const { formatCurrency, formatNumber } = useNumberFormat();

  const { getRowHandlers } = useLongPress<Category>({
    onClick: (child) => onSelectChild(child.id),
    // No row action sheet here -- the row has one action, so a long press
    // does the same thing a click does rather than nothing.
    onLongPress: (child) => onSelectChild(child.id),
  });

  const rows = useMemo(() => {
    const shareById = new Map(shares.map((share) => [share.id, share]));
    const children = categories
      .filter((c) => c.parentId === category.id)
      .map((child) => ({ child, share: shareById.get(child.id) ?? null }));
    // Largest subtree first, never-used children (no bucket) at the end by name.
    return children.sort((a, b) => {
      const totalA = a.share ? Math.abs(a.share.total) : -1;
      const totalB = b.share ? Math.abs(b.share.total) : -1;
      if (totalA !== totalB) return totalB - totalA;
      return a.child.name.localeCompare(b.child.name);
    });
  }, [categories, category.id, shares]);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
        <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('subcategoriesTab.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead>
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('subcategoriesTab.name')}
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('subcategoriesTab.total')}
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('subcategoriesTab.transactions')}
            </th>
            <th className="w-10 px-4 py-3" aria-hidden="true" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map(({ child, share }) => {
            const swatchColor = child.effectiveColor ?? child.color;
            const glyphIcon = child.effectiveIcon ?? child.icon;
            return (
              <tr
                key={child.id}
                {...getRowHandlers(child)}
                className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <CategoryGlyph
                      icon={glyphIcon}
                      color={swatchColor}
                      inherited={!child.icon && !child.color}
                      size={14}
                    />
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {child.name}
                    </span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                  {share ? formatCurrency(Math.abs(share.total), currencyCode) : '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                  {share ? formatNumber(share.count, 0) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <ChevronRightIcon
                    className="ml-auto h-4 w-4 text-gray-400"
                    aria-hidden="true"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
