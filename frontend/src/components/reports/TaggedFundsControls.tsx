'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { TagKeyBreakdownSelect } from '@/components/reports/TagKeyBreakdownSelect';
import { IncludeTaggedTransfersToggle } from '@/components/reports/IncludeTaggedTransfersToggle';
import type { TaggedFundsFilter } from '@/hooks/useTaggedFundsFilter';

interface TaggedFundsControlsProps {
  filter: TaggedFundsFilter;
}

/**
 * The tag key, tag value and "Include tagged transfers" controls of the funding
 * view (`docs/specs/report-tag-key-breakdown.md` section 11.2). Renders three
 * siblings for the report's own toolbar row, and nothing at all when the user
 * has no `KEY:VALUE` tags. The value select offers the values of the chosen key
 * and never an "untagged" choice (F6); the switch appears only once a key and a
 * value are chosen (F7).
 */
export function TaggedFundsControls({ filter }: TaggedFundsControlsProps) {
  const t = useTranslations('reports');
  const { tagKeys, tagKey, setTagKey, tagValues, tagValue, setTagValue } = filter;

  const valueOptions = useMemo(
    () => [
      // Where the value only picks whose transfers to show, the empty choice
      // shows nothing, so it must not read as "all of them" (spec 11.2).
      {
        value: '',
        label: filter.valueRequired
          ? t('tagBreakdown.selectValue')
          : t('tagBreakdown.allValues'),
      },
      ...tagValues.map((value) => ({ value, label: value })),
    ],
    [tagValues, t, filter.valueRequired],
  );

  if (tagKeys.length === 0) return null;

  return (
    <>
      <TagKeyBreakdownSelect tagKeys={tagKeys} value={tagKey} onChange={setTagKey} />
      {tagKey !== '' && (
        <div className="w-48 shrink-0">
          <Select
            aria-label={t('tagBreakdown.valueLabel')}
            options={valueOptions}
            value={tagValue}
            onChange={(event) => setTagValue(event.target.value)}
          />
        </div>
      )}
      {filter.active && (
        <IncludeTaggedTransfersToggle
          checked={filter.includePref}
          onChange={filter.setIncludePref}
        />
      )}
    </>
  );
}
