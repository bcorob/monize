'use client';

import { useMemo, useState } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useTagNames } from '@/hooks/useTagNames';
import { collectTagKeys, collectTagValues } from '@/lib/tag-key-value';

export interface TaggedFundsFilter {
  /** Distinct `KEY:VALUE` keys the user has. Empty hides the controls. */
  tagKeys: string[];
  tagKey: string;
  setTagKey: (key: string) => void;
  /** The values of the chosen key; never an "untagged" choice (spec F6). */
  tagValues: string[];
  tagValue: string;
  setTagValue: (value: string) => void;
  /** A key AND a value are chosen: what the server can filter or fetch by. */
  active: boolean;
  /** The persisted switch, whether or not it applies right now. */
  includePref: boolean;
  setIncludePref: (next: boolean) => void;
  /** The funding view is on: `active` and the switch is on (spec F7). */
  include: boolean;
  /**
   * The value only picks whose tagged transfers the funding view shows, so the
   * report needs one to show anything (spec 11.2): the empty choice reads
   * "Select a value", not "All values", and a key with a single value selects
   * it. False where an empty value means "no tag filter" (Spending by Category).
   */
  valueRequired: boolean;
}

export interface TaggedFundsFilterOptions {
  /** See {@link TaggedFundsFilter.valueRequired}. Default false. */
  valueRequired?: boolean;
}

/**
 * The tag key, value and "Include tagged transfers" switch of a report that
 * shows the funding view (`docs/specs/report-tag-key-breakdown.md` section
 * 11.2). The key and value are session state; the switch is a persisted
 * per-report preference, default off. Changing the key clears the value, which
 * belongs to the old key.
 */
export function useTaggedFundsFilter(
  includeStorageKey: string,
  { valueRequired = false }: TaggedFundsFilterOptions = {},
): TaggedFundsFilter {
  const names = useTagNames();
  const tagKeys = useMemo(() => collectTagKeys(names), [names]);
  const [tagKey, setTagKeyState] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [includeStored, setIncludePref] = useLocalStorage<boolean>(includeStorageKey, false);

  const tagValues = useMemo(
    () => (tagKey ? collectTagValues(names, tagKey) : []),
    [names, tagKey],
  );
  const setTagKey = (key: string) => {
    setTagKeyState(key);
    // A key with one value leaves nothing to choose where a value is required.
    const values = valueRequired && key ? collectTagValues(names, key) : [];
    setTagValue(values.length === 1 ? values[0] : '');
  };

  const active = tagKey !== '' && tagValue !== '';
  const includePref = includeStored === true;
  return {
    tagKeys,
    tagKey,
    setTagKey,
    tagValues,
    tagValue,
    setTagValue,
    active,
    includePref,
    setIncludePref,
    include: active && includePref,
    valueRequired,
  };
}
