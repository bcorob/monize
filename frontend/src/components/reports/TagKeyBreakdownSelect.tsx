'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

interface TagKeyBreakdownSelectProps {
  /** Distinct KEY:VALUE tag keys in the user's tags (`collectTagKeys`). */
  tagKeys: string[];
  /** The selected key, or '' for "None" (no breakdown). */
  value: string;
  onChange: (value: string) => void;
}

/**
 * "Break down by tag key" control for a report's controls card
 * (`docs/specs/report-tag-key-breakdown.md` section 6, the
 * `CategoryTagBreakdownPanel` precedent). Hidden entirely when the user has no
 * `KEY:VALUE` tags. The default option, "None", sends no `tagKey` and renders
 * today's report unchanged.
 */
export function TagKeyBreakdownSelect({
  tagKeys,
  value,
  onChange,
}: TagKeyBreakdownSelectProps) {
  const t = useTranslations('reports');

  const options = useMemo(
    () => [
      { value: '', label: t('tagBreakdown.none') },
      ...tagKeys.map((key) => ({ value: key, label: key })),
    ],
    [tagKeys, t],
  );

  if (tagKeys.length === 0) return null;

  return (
    <div
      className="w-48 shrink-0"
      {...tourAnchor(TOUR_ANCHORS.reportTagBreakdownSelect)}
    >
      <Select
        aria-label={t('tagBreakdown.label')}
        options={options}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
