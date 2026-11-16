import { useCallback, useMemo, useRef, useState } from 'react';
import { useReportData } from '@/hooks/useReportData';
import { calendarDayNotesApi } from '@/lib/calendar-day-notes';
import { dayNotesByDay } from '@/lib/day-note-span';
import type { DayNote } from '@/types/calendar';

/**
 * The reader's notes for the days one calendar grid covers.
 *
 * Keyed by the range and nothing else: a note belongs to the day, not to the
 * accounts a page is filtered to or the layers that happen to be on, so the
 * same note is on both calendars and switching a filter does not re-ask for it.
 *
 * A note covers a run of consecutive days, so `byDay` holds one entry per day
 * the note touches and every one of them is the SAME note object -- which is
 * what lets the panel open the editor for a vacation from any day of it.
 *
 * A note is owner-only and the routes are not delegate-reachable, so an acting
 * delegate asks for nothing (`enabled: false`) rather than asking and rendering
 * the 403 as an empty day.
 */
export interface CalendarDayNotesState {
  /**
   * The note covering each day of the range, by day.
   *
   * A multi-day note appears under every day it covers. The server refuses
   * overlapping spans for one user, so no day has two.
   */
  byDay: ReadonlyMap<string, DayNote>;
  /**
   * The range's notes are actually in hand.
   *
   * False means the list is ABSENT -- not yet asked for, still in flight, failed,
   * or belonging to a range the reader has left -- which is a different thing
   * from a range that holds no note. A caller that offers to write a note reads
   * this first: "this day has none" is a claim only a loaded list can make, and
   * the write is a whole-body upsert that would replace a note the client never
   * saw.
   */
  loaded: boolean;
  isLoading: boolean;
  /** The list could not be loaded; the other layers are unaffected. */
  error: Error | null;
  isStale: boolean;
  reload: () => void;
  /**
   * Write the note the reader had open on `anchorDate`, span and all, then
   * refetch the range. The anchor is the day the panel was showing, which need
   * not be the span's first day.
   */
  save: (
    anchorDate: string,
    note: { body: string; startDate: string; endDate: string },
  ) => Promise<DayNote>;
  /**
   * Remove the note covering `anchorDate`, however many days it covers, then
   * refetch the range. Idempotent on the server.
   */
  remove: (anchorDate: string) => Promise<void>;
  /** Told by the editor whether there is an unsaved draft. */
  setDraftDirty: (dirty: boolean) => void;
  /**
   * Do something that would take the draft off screen -- open another day, step
   * the month, close the panel -- asking first when there is one to lose.
   */
  requestChange: (action: () => void) => void;
  /** Spread onto a `ConfirmDialog`; open only while a change is being asked about. */
  confirmDiscard: {
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  };
}

export function useCalendarDayNotes(params: {
  startDate: string;
  endDate: string;
  enabled: boolean;
}): CalendarDayNotesState {
  const { startDate, endDate, enabled } = params;
  const requestKey = `${enabled ? 'on' : 'off'}:${startDate}:${endDate}`;

  const result = useReportData<DayNote[] | null>(
    async () => {
      if (!enabled) return null;
      return calendarDayNotesApi.list({ startDate, endDate });
    },
    [requestKey],
    { requestKey },
  );

  const byDay = useMemo(
    () => dayNotesByDay(result.data ?? [], startDate, endDate),
    [result.data, startDate, endDate],
  );

  const { reload } = result;

  const save = useCallback(
    async (
      anchorDate: string,
      note: { body: string; startDate: string; endDate: string },
    ) => {
      // The client's own write drops its `calendar:day-notes:` entries; the
      // refetch is what puts the stored note, with the server's `updatedAt` and
      // the span it actually kept, on screen.
      const saved = await calendarDayNotesApi.upsert(anchorDate, note);
      reload();
      return saved;
    },
    [reload],
  );

  const remove = useCallback(
    async (anchorDate: string) => {
      await calendarDayNotesApi.remove(anchorDate);
      reload();
    },
    [reload],
  );

  // A ref rather than state: the guard is read inside a callback at the moment
  // of the change, and re-rendering every cell because a character was typed
  // into the note would be a cost paid on every keystroke.
  const isDirtyRef = useRef(false);
  const [pending, setPending] = useState<{ run: () => void } | null>(null);

  const setDraftDirty = useCallback((dirty: boolean) => {
    isDirtyRef.current = dirty;
  }, []);

  const requestChange = useCallback((action: () => void) => {
    if (!isDirtyRef.current) {
      action();
      return;
    }
    setPending({ run: action });
  }, []);

  const confirmDiscard = useMemo(
    () => ({
      isOpen: pending !== null,
      onConfirm: () => {
        isDirtyRef.current = false;
        pending?.run();
        setPending(null);
      },
      // The draft survives a cancel: the change the reader asked for is the
      // thing dropped, not the text they were writing.
      onCancel: () => setPending(null),
    }),
    [pending],
  );

  const isStale = result.data !== null && result.dataKey !== requestKey;
  const loaded = result.data !== null && !isStale;

  return useMemo(
    () => ({
      byDay,
      loaded,
      isLoading: result.isLoading,
      error: result.error,
      isStale,
      reload,
      save,
      remove,
      setDraftDirty,
      requestChange,
      confirmDiscard,
    }),
    [
      byDay,
      loaded,
      result.isLoading,
      result.error,
      isStale,
      reload,
      save,
      remove,
      setDraftDirty,
      requestChange,
      confirmDiscard,
    ],
  );
}
