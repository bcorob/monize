'use client';

import { useTranslations } from 'next-intl';
import type { MortgageTypeDetection } from '@/types/account';

interface MortgageTypeSuggestionProps {
  detection: MortgageTypeDetection;
}

/**
 * A detector's answer in words: the suggested type (or that there is none),
 * the reason the server gave, and a caution when its confidence is low. Shared
 * by the create form's sample entry and Loan Details' history action, so the
 * two word one answer the same way.
 */
export function MortgageTypeSuggestion({ detection }: MortgageTypeSuggestionProps) {
  const t = useTranslations('accounts');
  return (
    <div role="status" className="text-sm space-y-1">
      <p className="font-medium text-gray-900 dark:text-gray-100">
        {detection.type
          ? t('mortgageFields.detect.suggested', {
              type: t(`mortgageFields.type.${detection.type}`),
            })
          : t('mortgageFields.detect.noSuggestion')}
      </p>
      <p className="text-gray-600 dark:text-gray-300">
        {t(`mortgageFields.detect.reason.${detection.reason}`)}
      </p>
      {detection.type && detection.confidence === 'low' && (
        <p className="text-amber-700 dark:text-amber-400">
          {t('mortgageFields.detect.lowConfidence')}
        </p>
      )}
    </div>
  );
}
