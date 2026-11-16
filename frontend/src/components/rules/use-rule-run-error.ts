'use client';

import { useTranslations } from 'next-intl';
import { getErrorCode, getErrorMessage } from '@/lib/errors';
import { readRuleApiError } from '@/lib/rule-errors';

/**
 * The sentence for a failed test, preview or run. The codes the run endpoints
 * answer get the catalog's wording; a draft the server refuses to read says
 * so; anything else shows what the server said, then a generic line.
 */
export function useRuleRunErrorMessage(): (error: unknown, fallbackKey: 'testFailed' | 'previewFailed' | 'runFailed') => string {
  const t = useTranslations('rules.run.errors');

  return (error, fallbackKey) => {
    switch (getErrorCode(error)) {
      case 'PREVIEW_CHANGED':
        return t('PREVIEW_CHANGED');
      case 'RUN_TOO_LARGE':
        return t('RUN_TOO_LARGE');
      case 'INVALID_RULE':
        return t('INVALID_RULE');
      case 'DATE_RANGE_INVALID':
        return t('DATE_RANGE_INVALID');
      default:
        break;
    }
    // A DTO or validation refusal lists what is wrong with the draft itself.
    if (readRuleApiError(error).entries.length > 0) return t('draftInvalid');
    return getErrorMessage(error, t(fallbackKey));
  };
}
