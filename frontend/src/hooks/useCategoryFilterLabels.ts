import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SpecialCategoryFilterLabels } from '@/lib/categoryUtils';

/**
 * The translated labels of the category-filter pseudo-ids, for
 * `buildCategoryFilterOptions` and `resolveSelectedCategories`. One hook so
 * the Transactions and Bills & Deposits filters name them the same way.
 */
export function useCategoryFilterLabels(): SpecialCategoryFilterLabels {
  const t = useTranslations('common');
  return useMemo(
    () => ({
      uncategorized: t('categoryFilter.uncategorized'),
      transfer: t('categoryFilter.transfers'),
      income: t('categoryFilter.allIncome'),
      expense: t('categoryFilter.allExpenses'),
    }),
    [t],
  );
}
