import { getDateStringInTimezone, resolveTimezone } from '@/lib/utils';

/**
 * The calendar day a financial decision is made on, in the user's own
 * timezone -- the client-side spelling of the backend's `todayYMD()`.
 *
 * "Is this installment overdue", "which rate is in effect now", "what date does
 * the next projected row fall on" are calendar-day questions, and the calendar
 * they are asked against is the user's, not UTC's and not the server's. The two
 * layers must answer them identically: the backend prices the bill against
 * `todayYMD()` and the frontend projects the same installment beside it, so a
 * disagreement about which day it is becomes a disagreement about money.
 *
 * The resolution order is the backend's, term for term:
 *
 *   1. `user_preferences.timezone` when it names a real IANA zone -- what
 *      `RequestContextInterceptor` prefers;
 *   2. otherwise the browser's detected zone -- which is exactly what the axios
 *      interceptor sends as `X-Client-Timezone`, the interceptor's own
 *      fallback. `resolveTimezone` maps the stored `browser` sentinel (and an
 *      absent preference) onto it.
 *
 * `new Date().toISOString().slice(0, 10)` is the pattern this replaces, and it
 * is a third calendar that belongs to neither layer: east of Greenwich it is
 * still yesterday for the first hours after local midnight (up to fourteen at
 * UTC+14), and west of it it is already tomorrow through the evening. An
 * overdue-installment guard written against it accepts a stale anchor for that
 * whole window on one side and rejects a live one on the other.
 *
 * `now` is injectable so a boundary case is a pinned instant rather than a test
 * that only fails in the wrong timezone.
 */
export function financialTodayYmd(
  timezonePref: string | undefined,
  now: Date = new Date(),
): string {
  return getDateStringInTimezone(resolveTimezone(timezonePref), now);
}
