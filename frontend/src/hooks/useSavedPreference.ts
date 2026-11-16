'use client';

import { useCallback, useState } from 'react';
import type { UpdatePreferencesData } from '@/types/auth';

/**
 * A preference field that persists the moment it changes.
 *
 * Returns the value and a setter that writes it optimistically: local state
 * moves first, the request goes out, and a failure puts back the value the
 * field held before the change. The revert closes over the value of THAT
 * change, not over whatever the field holds when the response lands -- which is
 * the distinction a shared "previous" variable would lose.
 *
 * `commit` is passed in rather than called directly so one component owns the
 * request, the toast and the store update for every field it hosts.
 *
 * A change to the value the field already holds writes nothing: a `<select>`
 * re-emitting its own value, or a control re-rendered with an identical prop,
 * is not an edit, and a request per non-edit is a toast per non-edit too.
 * Compared with `Object.is`, so an array field (`preferredExchanges`) whose
 * caller rebuilds the array on every keystroke still saves -- rebuilding it IS
 * the edit there.
 */
export function useSavedPreference<
  K extends keyof UpdatePreferencesData,
  T extends NonNullable<UpdatePreferencesData[K]> = NonNullable<
    UpdatePreferencesData[K]
  >,
>(
  key: K,
  initial: T,
  commit: (patch: UpdatePreferencesData, revert: () => void) => void,
): { value: T; set: (next: T) => void } {
  const [value, setValue] = useState<T>(initial);

  const set = useCallback(
    (next: T) => {
      if (Object.is(value, next)) return;
      setValue(next);
      commit({ [key]: next } as UpdatePreferencesData, () => setValue(value));
    },
    [commit, key, value],
  );

  return { value, set };
}
