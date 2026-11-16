import apiClient from './api';
import { DayNote } from '@/types/calendar';
import { dedupe, invalidateCache } from './apiCache';

/**
 * The calendar's day notes.
 *
 * `calendar:` is its own cache family and is deliberately NOT dropped by
 * `invalidateBalanceCaches()`: a note moves no money, so a transaction write
 * cannot change one. Its own writes drop it, which is what the two functions
 * below do before returning.
 *
 * Keyed by range rather than by account scope or filters: a note belongs to the
 * day, not to what the reader is looking at on it. The range asks for every
 * note whose span TOUCHES it, so a vacation that began before the month shows
 * on the days of it the month holds.
 */
export const calendarDayNotesApi = {
  list: async (params: { startDate: string; endDate: string }): Promise<DayNote[]> => {
    const cacheKey = `calendar:day-notes:${params.startDate}:${params.endDate}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<DayNote[]>('/calendar/day-notes', { params });
        return response.data;
      },
      30_000,
    );
  },

  /**
   * Write the note the reader had open on `anchorDate`, whole.
   *
   * `anchorDate` is the day the panel was showing, not the span's first day:
   * the server resolves the note covering it, so a five-day note is edited from
   * its third day and the same request may move either end of the span. One
   * write, so there is no window where the note does not exist.
   *
   * The response is the STORED note -- adopt that, not the text that was sent,
   * so `updatedAt` is the server's and the span is the one it kept.
   */
  upsert: async (
    anchorDate: string,
    note: { body: string; startDate: string; endDate: string },
  ): Promise<DayNote> => {
    const response = await apiClient.put<DayNote>(
      `/calendar/day-notes/${anchorDate}`,
      note,
    );
    invalidateCache('calendar:day-notes:');
    return response.data;
  },

  /**
   * Remove the note covering `anchorDate`, however many days it covers.
   * Idempotent: removing a day that holds no note succeeds.
   */
  remove: async (anchorDate: string): Promise<void> => {
    await apiClient.delete(`/calendar/day-notes/${anchorDate}`);
    invalidateCache('calendar:day-notes:');
  },
};
