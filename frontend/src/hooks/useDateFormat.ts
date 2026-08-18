import { useCallback, useMemo } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { resolveDateFormatPattern } from '@/lib/date-parse';
import {
  formatDate as formatDateUtil,
  formatMonth as formatMonthUtil,
  formatDatetimeLocal,
  isoToDatetimeLocal,
  resolveTimezone,
} from '@/lib/utils';

/**
 * Hook to format dates according to user preferences.
 * Returns a formatDate function that uses the user's preferred date format,
 * plus a formatMonth function for year-month (YYYY-MM) values.
 * When dateFormat is 'browser', the user's UI language is used as the locale
 * (so freshly defaulted users see dates in the same locale as their UI).
 */
export function useDateFormat() {
  // Subscribe directly to dateFormat to ensure reactivity when it changes
  const dateFormat = usePreferencesStore((state) => state.preferences?.dateFormat) || 'browser';
  const language = usePreferencesStore((state) => state.preferences?.language);
  const timeFormat = usePreferencesStore((state) => state.preferences?.timeFormat) || '24h';
  const timezone = usePreferencesStore((state) => state.preferences?.timezone);

  /**
   * The user's format as a concrete pattern, with `browser` already resolved
   * against their UI language. Anything that has to *read* what someone typed
   * needs the arrangement of day, month and year spelled out -- `browser` says
   * only that the locale decides, and a parser cannot ask a sentinel whether
   * `7/8` is July or August.
   */
  const datePattern = useMemo(() => {
    const locale =
      language && language !== 'xx' && language !== 'browser' ? language : undefined;
    return resolveDateFormatPattern(dateFormat, locale);
  }, [dateFormat, language]);

  const formatDate = useCallback(
    (date: Date | string): string => {
      const locale =
        language && language !== 'xx' && language !== 'browser' ? language : undefined;
      return formatDateUtil(date, dateFormat, locale);
    },
    [dateFormat, language]
  );

  const formatMonth = useCallback(
    (month: string): string => {
      const locale =
        language && language !== 'xx' && language !== 'browser' ? language : undefined;
      return formatMonthUtil(month, dateFormat, locale);
    },
    [dateFormat, language]
  );

  /**
   * An instant as date and time of day, in the timezone the user chose in
   * Preferences rather than the browser's.
   *
   * `formatDate` deliberately does not do this: it takes calendar dates
   * (`2026-07-30`), which have no instant to convert and would shift a day if
   * treated as one. Use this only for values that really are timestamps.
   */
  const formatDateTime = useCallback(
    (isoInstant: string): string => {
      try {
        const local = isoToDatetimeLocal(isoInstant, resolveTimezone(timezone));
        return formatDatetimeLocal(local, dateFormat, timeFormat);
      } catch {
        // An unparseable instant is worth less than the date beside it; the
        // caller already has that, so say nothing rather than "Invalid Date".
        return '';
      }
    },
    [dateFormat, timeFormat, timezone],
  );

  /**
   * The short zone name for the user's timezone at a given instant, e.g. "EDT".
   * Named at the instant because it changes across a daylight-saving boundary.
   */
  const formatTimeZoneAbbrev = useCallback(
    (at: Date = new Date()): string => {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: resolveTimezone(timezone),
          timeZoneName: 'short',
        }).formatToParts(at);
        return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      } catch {
        return '';
      }
    },
    [timezone],
  );

  return {
    formatDate,
    formatMonth,
    formatDateTime,
    formatTimeZoneAbbrev,
    dateFormat,
    datePattern,
    timeFormat,
    timezone,
  };
}
