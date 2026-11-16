import { useCallback } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';

/**
 * Steps from largest to smallest, with the number of seconds in each. `week` is
 * left out deliberately: "3 weeks ago" is a worse reading than "20 days ago" for
 * a news list, and most locales agree.
 */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/**
 * A locale-aware "44 minutes ago" formatter.
 *
 * `Intl.RelativeTimeFormat` rather than catalog strings: it already knows every
 * locale's wording and plural rules, so a headline list needs no
 * "{n}m ago" key per language and cannot get Polish plurals wrong. It is the
 * one relative-time formatter: the English-only `formatRelativeTime` that
 * `lib/format.ts` used to carry was removed.
 *
 * Resolves the locale the same way `useDateFormat` does: an explicit language
 * wins, and the pseudo-locale or "browser" hands off to the runtime default.
 */
export function useRelativeTime() {
  const language = usePreferencesStore((state) => state.preferences?.language);

  return useCallback(
    (value: string | Date | null | undefined): string => {
      if (!value) return '';
      const then = value instanceof Date ? value : new Date(value);
      const ms = then.getTime();
      if (!isFinite(ms)) return '';

      const locale =
        language && language !== 'xx' && language !== 'browser'
          ? language
          : undefined;
      const formatter = new Intl.RelativeTimeFormat(locale, {
        numeric: 'auto',
      });

      const seconds = Math.round((ms - Date.now()) / 1000);
      const magnitude = Math.abs(seconds);
      for (const [unit, unitSeconds] of UNITS) {
        if (magnitude >= unitSeconds) {
          return formatter.format(Math.round(seconds / unitSeconds), unit);
        }
      }
      // Under a minute. `numeric: 'auto'` turns this into "now" rather than
      // "in 0 seconds", which is what a freshly published headline should read as.
      return formatter.format(0, 'minute');
    },
    [language],
  );
}
