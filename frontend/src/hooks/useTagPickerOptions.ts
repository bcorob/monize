'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MultiSelectOption } from '@/components/ui/MultiSelect';
import { tagsApi } from '@/lib/tags';
import { buildTagOptions } from '@/lib/tag-options';
import { createLogger } from '@/lib/logger';
import type { Tag, TagUsageMap } from '@/types/tag';

const logger = createLogger('TagPickerOptions');

const NO_USAGE: TagUsageMap = {};

export interface TagPickerOptions {
  /** `tags` recent-first then A-Z (`buildTagOptions`); plain A-Z until usage answers. */
  tagOptions: MultiSelectOption[];
  /** The usage behind the order, for a `SplitEditor` in the same form, so it does not fetch again. */
  tagUsage: TagUsageMap;
}

/**
 * Options for a picker that applies tags to a transaction. Usage is fetched
 * by itself whenever `enabled` turns true, so it never holds up the form's
 * other lookups, and a stale answer from an unmounted form is dropped. Usage
 * only orders the list, so a failed lookup is logged and leaves the picker
 * A-Z rather than failing the form.
 */
export function useTagPickerOptions(tags: Tag[], enabled = true): TagPickerOptions {
  const [tagUsage, setTagUsage] = useState<TagUsageMap>(NO_USAGE);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    tagsApi
      .getUsage()
      .then((usage) => {
        if (live) setTagUsage(usage);
      })
      .catch((error) => {
        logger.error('Tag usage lookup failed; the tag picker stays A-Z:', error);
      });
    return () => {
      live = false;
    };
  }, [enabled]);

  const tagOptions = useMemo(() => buildTagOptions(tags, tagUsage), [tags, tagUsage]);
  return { tagOptions, tagUsage };
}
