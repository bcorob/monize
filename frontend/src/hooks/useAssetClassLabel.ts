import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { isAssetClassKey } from '@/lib/asset-classes';

/** The fields of an asset-class rollup bucket that name it. */
export interface AssetClassName {
  assetClass: string;
  assetClassKey?: string | null;
}

/**
 * The reader's name for an asset-class bucket: a canonical class in their
 * language, a class the user typed on their own security as typed. One hook so
 * the Investments allocation chart and the dashboard widget name the classes
 * the same way.
 */
export function useAssetClassLabel(): (item: AssetClassName) => string {
  const t = useTranslations('investments');
  return useCallback(
    (item: AssetClassName) =>
      isAssetClassKey(item.assetClassKey)
        ? t(`assetClasses.${item.assetClassKey}`)
        : item.assetClass,
    [t],
  );
}
