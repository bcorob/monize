import { useEffect, useState } from 'react';
import { tagsApi } from '@/lib/tags';
import { createLogger } from '@/lib/logger';

const logger = createLogger('useTagNames');
const NO_NAMES: string[] = [];

/**
 * The names of the user's tags, for a control that derives keys and values from
 * them (`useTaggedFundsFilter`). Empty until the tags load and on a failed
 * load -- a caller hides its control rather than offering one with no options.
 */
export function useTagNames(): string[] {
  const [names, setNames] = useState<string[]>(NO_NAMES);

  useEffect(() => {
    let cancelled = false;
    tagsApi
      .getAll()
      .then((tags) => {
        if (!cancelled) setNames(tags.map((tag) => tag.name));
      })
      .catch((error) => {
        logger.error(error);
        if (!cancelled) setNames(NO_NAMES);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return names;
}
