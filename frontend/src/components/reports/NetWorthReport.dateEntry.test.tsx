import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@/test/render';
import { NetWorthReport } from './NetWorthReport';

/**
 * The defect in issue #1201, at the level it was reported: typing a custom
 * range into this report was impossible, because every keystroke that
 * completed a date started a reload, the report answered the reload by
 * returning a skeleton instead of its usual tree, and React unmounted the date
 * field the user was typing into. Focus went with it -- after two characters,
 * every time, in both fields.
 *
 * So this file renders the real `DateRangeSelector` and the real `DateInput`
 * (the rest of the suite stubs the selector out) and asserts on what the user
 * experiences: the field they are typing into is still the focused field once
 * the reload lands, and a partial date typed into it becomes a real one.
 */

vi.mock('recharts', async () => ({
  // The shared stand-in plus the two marks only this report draws.
  ...(await import('@/test/recharts-mock')).rechartsMock(),
  LabelList: () => null,
  ReferenceDot: () => null,
}));

vi.mock('@/lib/pdf-export', () => ({ exportToPdf: vi.fn().mockResolvedValue(undefined) }));

const getMonthly = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getMonthly: (...args: unknown[]) => getMonthly(...args),
    recalculate: vi.fn().mockResolvedValue(undefined),
  },
}));

// The user's preference is the browser default, which resolves to this
// locale's arrangement -- pinned so the test does not depend on where it runs.
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
    dateFormat: 'browser',
    datePattern: 'MM/DD/YYYY',
  }),
}));

const MONTHS = [
  { month: '2025-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
  { month: '2025-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
];

/** A fetch the test can hold open, so the loading state is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function renderReport() {
  getMonthly.mockResolvedValue(MONTHS);
  await act(async () => {
    render(<NetWorthReport />);
  });
  await act(async () => { fireEvent.click(screen.getByText('Custom')); });
}

describe('NetWorthReport custom date entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 3)); // 2026-09-03
  });

  it('keeps focus in the start date field across the reload the date change causes', async () => {
    vi.useRealTimers();
    await renderReport();

    const startDate = screen.getByLabelText('Start Date') as HTMLInputElement;
    startDate.focus();
    expect(document.activeElement).toBe(startDate);

    const pending = deferred<typeof MONTHS>();
    getMonthly.mockReturnValueOnce(pending.promise);

    // A complete date: this is the keystroke that starts a reload.
    await act(async () => {
      fireEvent.change(startDate, { target: { value: '06/01/2025' } });
    });

    // Mid-flight -- the report is loading, and the field is still the one the
    // user is typing into. This is where it used to be unmounted.
    expect(document.activeElement).toBe(startDate);

    await act(async () => {
      pending.resolve(MONTHS);
      await pending.promise;
    });

    expect(document.activeElement).toBe(startDate);
    expect(screen.getByLabelText('Start Date')).toBe(startDate);
  });

  it('keeps focus while a partial date is being typed, and completes it on blur', async () => {
    vi.useRealTimers();
    await renderReport();

    const startDate = screen.getByLabelText('Start Date') as HTMLInputElement;
    startDate.focus();

    // "9", "9-", "9-1", "9-14": none of these is a complete date, so none of
    // them may reach the report as one.
    for (const text of ['9', '9-', '9-1', '9-14']) {
      await act(async () => { fireEvent.change(startDate, { target: { value: text } }); });
      expect(document.activeElement).toBe(startDate);
    }

    await act(async () => { fireEvent.blur(startDate); });

    await waitFor(() => {
      expect((screen.getByLabelText('Start Date') as HTMLInputElement).value)
        .toBe('09/14/2026');
    });
  });

  it('shows the report again once the reload lands, with the controls never having gone', async () => {
    vi.useRealTimers();
    await renderReport();

    const startDate = screen.getByLabelText('Start Date') as HTMLInputElement;
    const pending = deferred<typeof MONTHS>();
    getMonthly.mockReturnValueOnce(pending.promise);

    await act(async () => {
      fireEvent.change(startDate, { target: { value: '06/01/2025' } });
    });
    // The custom range's two fields are still on screen while it loads.
    expect(screen.getByLabelText('Start Date')).toBeInTheDocument();
    expect(screen.getByLabelText('End Date')).toBeInTheDocument();

    await act(async () => {
      pending.resolve(MONTHS);
      await pending.promise;
    });
    expect(screen.getByLabelText('Start Date')).toBeInTheDocument();
  });
});
