import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { CalendarDayNote } from './CalendarDayNote';
import calendarNs from '@/i18n/messages/en/calendar.json';
import { CALENDAR_DAY_NOTE_MAX_LENGTH } from '@/lib/calendar-day-note';
import type { DayNote } from '@/types/calendar';

/**
 * The body field, by its own label.
 *
 * The editor holds three text inputs now -- the body and the two ends of the
 * span -- so "the textbox" no longer names one thing.
 */
const noteBody = () => screen.getByLabelText(calendarNs.notes.title);

const onSave = vi.fn();
const onDelete = vi.fn();
const onDirtyChange = vi.fn();

function note(overrides: Partial<DayNote> = {}): DayNote {
  return {
    startDate: '2026-06-10',
    endDate: '2026-06-10',
    body: 'Rent is due, call the landlord',
    updatedAt: '2026-06-09T12:00:00.000Z',
    ...overrides,
  };
}

function renderNote(props: Partial<React.ComponentProps<typeof CalendarDayNote>> = {}) {
  return render(
    <CalendarDayNote
      date="2026-06-10"
      onSave={onSave}
      onDelete={onDelete}
      onDirtyChange={onDirtyChange}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  onSave.mockResolvedValue(note());
  onDelete.mockResolvedValue(undefined);
});

describe('CalendarDayNote', () => {
  describe('a day with no note (table E)', () => {
    it('offers to add one', () => {
      renderNote();

      expect(screen.getByRole('button', { name: calendarNs.notes.add })).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('saves the body the reader typed, for the day it was opened on', async () => {
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(noteBody(), { target: { value: 'Dentist at 9' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      // The span defaults to the day it was opened on: most notes are one day,
      // and one is what the reader asked for by not saying otherwise.
      expect(onSave).toHaveBeenCalledWith('2026-06-10', {
        body: 'Dentist at 9',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
      });
    });

    it('stops the reader at the stored cap rather than letting the save report it', () => {
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      expect(noteBody()).toHaveAttribute(
        'maxLength',
        String(CALENDAR_DAY_NOTE_MAX_LENGTH),
      );
    });

    it('refuses to send a blank body: clearing a note is Delete', () => {
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(noteBody(), { target: { value: '   ' } });

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  describe('a day with a note (table E)', () => {
    it('shows the body, and offers Edit and Delete', () => {
      renderNote({ note: note() });

      expect(screen.getByText(/Rent is due/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('renders a body that looks like markup as the characters that were typed', () => {
      renderNote({ note: note({ body: '<script>alert(1)</script>' }) });

      expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
      expect(document.querySelector('script')).toBeNull();
    });

    it('asks before deleting, and deletes the day it is showing', async () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(screen.getByText(calendarNs.notes.deleteMessage)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
      });

      expect(onDelete).toHaveBeenCalledWith('2026-06-10');
    });

    it('opens the editor on the stored body', () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      expect(noteBody()).toHaveValue('Rent is due, call the landlord');
    });
  });

  describe('a note that covers a run of days', () => {
    const vacation = () =>
      note({ startDate: '2026-06-14', endDate: '2026-06-18', body: 'Away in Lisbon' });

    it('says which days it is about when it is not only this one', () => {
      // Without it, a note reached from the middle of a vacation reads as a
      // note about that single day -- and editing it would look like it had
      // silently spread across the week.
      renderNote({ date: '2026-06-16', note: vacation() });

      expect(screen.getByText(/2026/)).toBeInTheDocument();
      expect(screen.getByText('Away in Lisbon')).toBeInTheDocument();
    });

    it('is edited from any day it covers, and saves the whole span', async () => {
      renderNote({ date: '2026-06-16', note: vacation() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      // Anchored on the day the panel was showing, not on the span's first day:
      // that is what the server resolves the covering row from.
      expect(onSave).toHaveBeenCalledWith('2026-06-16', {
        body: 'Away in Lisbon',
        startDate: '2026-06-14',
        endDate: '2026-06-18',
      });
    });

    it('stretches a one-day note into a run', async () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText(calendarNs.notes.endDate), {
        target: { value: '2026-06-13' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      expect(onSave).toHaveBeenCalledWith('2026-06-10', {
        body: 'Rent is due, call the landlord',
        startDate: '2026-06-10',
        endDate: '2026-06-13',
      });
    });

    it('refuses a span that no longer covers the day it is being written from', () => {
      // The panel is showing the tenth; a span that skips it would store a note
      // the reader is told they just wrote and cannot see.
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText(calendarNs.notes.startDate), {
        target: { value: '2026-06-12' },
      });
      fireEvent.change(screen.getByLabelText(calendarNs.notes.endDate), {
        target: { value: '2026-06-14' },
      });

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(calendarNs.notes.spanMissesDay);
      expect(onSave).not.toHaveBeenCalled();
    });

    it('refuses a span that ends before it starts', () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText(calendarNs.notes.endDate), {
        target: { value: '2026-06-08' },
      });

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(calendarNs.notes.spanBackwards);
    });

    it('counts a span change as a draft to lose, even with the body untouched', () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);

      fireEvent.change(screen.getByLabelText(calendarNs.notes.endDate), {
        target: { value: '2026-06-13' },
      });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });

    it('says the whole run goes when a multi-day note is deleted', () => {
      renderNote({ date: '2026-06-16', note: vacation() });

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      expect(screen.getByText(/5 days/)).toBeInTheDocument();
    });
  });

  describe('a draft belongs to the day it was opened for (I12)', () => {
    it('tells its host when there is a draft to lose, and when there is not', () => {
      renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);

      fireEvent.change(noteBody(), { target: { value: 'Changed' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      // Typing the stored body back is not a change to lose.
      fireEvent.change(noteBody(), {
        target: { value: 'Rent is due, call the landlord' },
      });
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it('drops the editor when the panel moves to another day', () => {
      const { rerender } = renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(noteBody(), { target: { value: 'For the tenth' } });

      rerender(
        <CalendarDayNote
          date="2026-06-11"
          onSave={onSave}
          onDelete={onDelete}
          onDirtyChange={onDirtyChange}
        />,
      );

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it('does not adopt a save that lands after the panel has moved on', async () => {
      let resolveSave: ((value: DayNote) => void) | undefined;
      onSave.mockImplementationOnce(
        () => new Promise<DayNote>((resolve) => { resolveSave = resolve; }),
      );

      const { rerender } = renderNote({ note: note() });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(noteBody(), { target: { value: 'Tenth' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      rerender(
        <CalendarDayNote
          date="2026-06-11"
          note={note({ startDate: '2026-06-11', endDate: '2026-06-11', body: 'Eleventh' })}
          onSave={onSave}
          onDelete={onDelete}
          onDirtyChange={onDirtyChange}
        />,
      );

      await act(async () => {
        resolveSave?.(note({ body: 'Tenth' }));
      });

      // The eleventh's own note is what is on screen; the tenth's response went
      // to the list, not to this panel.
      expect(screen.getByText('Eleventh')).toBeInTheDocument();
      expect(screen.queryByText('Tenth')).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledWith('2026-06-10', {
        body: 'Tenth',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
      });
    });

    it('keeps the draft and shows the error when a save fails', async () => {
      onSave.mockRejectedValue(new Error('offline'));
      renderNote();

      fireEvent.click(screen.getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(noteBody(), { target: { value: 'Keep me' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });

      // `getErrorMessage` prefers what the server said and falls back to the
      // catalog line; either way the reason sits beside the form.
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('offline'));
      expect(noteBody()).toHaveValue('Keep me');
    });
  });
});
