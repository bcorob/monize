import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@/test/render';
import { useCalendarDayNotes } from './useCalendarDayNotes';
import type { DayNote } from '@/types/calendar';

const mockList = vi.fn();
const mockUpsert = vi.fn();
const mockRemove = vi.fn();
vi.mock('@/lib/calendar-day-notes', () => ({
  calendarDayNotesApi: {
    list: (...args: unknown[]) => mockList(...args),
    upsert: (...args: unknown[]) => mockUpsert(...args),
    remove: (...args: unknown[]) => mockRemove(...args),
  },
}));

function note(startDate: string, body = 'Call the landlord', endDate = startDate): DayNote {
  return { startDate, endDate, body, updatedAt: '2026-06-09T12:00:00.000Z' };
}

function renderNotes(enabled = true) {
  return renderHook(() =>
    useCalendarDayNotes({ startDate: '2026-05-31', endDate: '2026-07-04', enabled }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([note('2026-06-10')]);
  mockUpsert.mockResolvedValue(note('2026-06-10', 'Saved'));
  mockRemove.mockResolvedValue(undefined);
});

describe('useCalendarDayNotes', () => {
  it('asks for the grid range once, keyed by nothing else', async () => {
    const { result } = renderNotes();

    await waitFor(() => expect(result.current.byDay.size).toBe(1));
    expect(mockList).toHaveBeenCalledWith({ startDate: '2026-05-31', endDate: '2026-07-04' });
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(result.current.byDay.get('2026-06-10')?.body).toBe('Call the landlord');
  });

  it('asks nothing in an acting-delegate session', async () => {
    const { result } = renderNotes(false);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockList).not.toHaveBeenCalled();
    expect(result.current.byDay.size).toBe(0);
  });

  it('refetches the range after its own write', async () => {
    const { result } = renderNotes();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.save('2026-06-10', {
        body: 'Saved',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
      });
    });

    expect(mockUpsert).toHaveBeenCalledWith('2026-06-10', {
      body: 'Saved',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
    });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('refetches the range after a delete', async () => {
    const { result } = renderNotes();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.remove('2026-06-10');
    });

    expect(mockRemove).toHaveBeenCalledWith('2026-06-10');
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('keeps a failed list a failure, with the notes simply absent', async () => {
    mockList.mockRejectedValue(new Error('offline'));
    const { result } = renderNotes();

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.byDay.size).toBe(0);
    // An empty map is what a failure and an empty range have in common, so it
    // cannot be what a caller reads before offering to write one.
    expect(result.current.loaded).toBe(false);
  });

  it('separates a range that holds no note from a list it does not have', async () => {
    mockList.mockResolvedValue([]);
    const { result } = renderNotes();

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.byDay.size).toBe(0);
  });

  it('reports no list in an acting-delegate session, not an empty one', async () => {
    const { result } = renderNotes(false);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loaded).toBe(false);
  });

  describe('leaving a day with a draft', () => {
    it('runs the change straight away when there is nothing to lose', async () => {
      const { result } = renderNotes();
      await waitFor(() => expect(result.current.byDay.size).toBe(1));

      const action = vi.fn();
      act(() => result.current.requestChange(action));

      expect(action).toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(false);
    });

    it('asks first when a draft is open, and keeps it on cancel', async () => {
      const { result } = renderNotes();
      await waitFor(() => expect(result.current.byDay.size).toBe(1));

      act(() => result.current.setDraftDirty(true));
      const action = vi.fn();
      act(() => result.current.requestChange(action));

      expect(action).not.toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(true);

      act(() => result.current.confirmDiscard.onCancel());
      expect(action).not.toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(false);
    });

    it('runs the change once the reader confirms the draft goes', async () => {
      const { result } = renderNotes();
      await waitFor(() => expect(result.current.byDay.size).toBe(1));

      act(() => result.current.setDraftDirty(true));
      const action = vi.fn();
      act(() => result.current.requestChange(action));
      act(() => result.current.confirmDiscard.onConfirm());

      expect(action).toHaveBeenCalled();
      expect(result.current.confirmDiscard.isOpen).toBe(false);
    });
  });

  describe('a note that covers a run of days', () => {
    it('answers for every day the span touches, with the same note', async () => {
      // One row, nine days. The panel asks "the note for this day" and gets the
      // vacation back from any of them, which is what makes it editable from
      // all of them.
      mockList.mockResolvedValue([note('2026-06-14', 'Away in Lisbon', '2026-06-18')]);
      const { result } = renderNotes();

      await waitFor(() => expect(result.current.byDay.size).toBe(5));
      for (const day of ['2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18']) {
        expect(result.current.byDay.get(day)?.body).toBe('Away in Lisbon');
      }
      expect(result.current.byDay.get('2026-06-19')).toBeUndefined();
      expect(result.current.byDay.get('2026-06-13')).toBeUndefined();
    });

    it('marks only the days of a run that this grid actually holds', async () => {
      // A note running from before the grid to after it covers every day on
      // screen -- and nothing off it, so the map stays the size of the grid
      // rather than the size of the span.
      mockList.mockResolvedValue([note('2026-01-01', 'Sabbatical', '2026-12-31')]);
      const { result } = renderNotes();

      await waitFor(() => expect(result.current.byDay.size).toBeGreaterThan(0));
      expect(result.current.byDay.get('2026-05-31')?.body).toBe('Sabbatical');
      expect(result.current.byDay.get('2026-07-04')?.body).toBe('Sabbatical');
      // 2026-05-31 through 2026-07-04 inclusive.
      expect(result.current.byDay.size).toBe(35);
      expect(result.current.byDay.get('2026-07-05')).toBeUndefined();
    });
  });
});
