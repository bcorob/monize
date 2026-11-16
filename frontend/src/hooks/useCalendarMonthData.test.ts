import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import {
  CALENDAR_MAX_PER_SCHEDULE,
  CALENDAR_MAX_ROWS,
  calendarRequestKey,
  useCalendarMonthData,
} from './useCalendarMonthData';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import type { ScheduledOccurrence } from '@/types/scheduled-transaction';

const mockGetAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getAllPages: (...args: unknown[]) => mockGetAllPages(...args) },
}));

const mockGetOccurrences = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getOccurrences: (...args: unknown[]) => mockGetOccurrences(...args),
  },
}));

function transaction(id: string): Transaction {
  return {
    id,
    accountId: 'chequing-1',
    transactionDate: '2026-06-10',
    amount: -25,
    currencyCode: 'CAD',
    status: TransactionStatus.CLEARED,
  } as Transaction;
}

function occurrence(dueDate: string, scheduleId = 'st-1'): ScheduledOccurrence {
  return {
    scheduledTransactionId: scheduleId,
    originalDate: dueDate,
    dueDate,
    amount: -10,
    amountComplete: true,
    directionAmount: -10,
    currencyCode: 'CAD',
    overrideId: null,
    moved: false,
    accountId: 'chequing-1',
    transferAccountId: null,
    isTransfer: false,
  };
}

describe('calendarRequestKey', () => {
  it('is the same key for the same question asked twice', () => {
    expect(calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['a', 'b'] })).toBe(
      calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['a', 'b'] }),
    );
  });

  it('ignores the order the caller happened to hold a filter in', () => {
    expect(calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['b', 'a'] })).toBe(
      calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['a', 'b'] })
    );
  });

  it('reads an empty filter as no filter, so opening the panel is not a new question', () => {
    expect(
      calendarRequestKey('2026-06-01', '2026-06-30', {
        accountIds: ['a'],
        categoryIds: [],
        search: '',
        tagKey: undefined,
      }),
    ).toBe(calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['a'] }));
  });

  it('changes when the range or a filter changes', () => {
    const base = calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['a'] });
    expect(calendarRequestKey('2026-07-01', '2026-07-31', { accountIds: ['a'] })).not.toBe(base);
    expect(calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['b'] })).not.toBe(base);
    expect(
      calendarRequestKey('2026-06-01', '2026-06-30', { accountIds: ['a'], search: 'rent' }),
    ).not.toBe(base);
  });
});

describe('useCalendarMonthData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllPages.mockResolvedValue([]);
    mockGetOccurrences.mockResolvedValue([]);
  });

  it('asks both endpoints for the grid range', async () => {
    const { result } = renderHook(() =>
      useCalendarMonthData('2026-05-31', '2026-07-04', { accountIds: ['a'] }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(mockGetAllPages).toHaveBeenCalledWith({
      accountIds: ['a'],
      startDate: '2026-05-31',
      endDate: '2026-07-04',
    });
    expect(mockGetOccurrences).toHaveBeenCalledWith({
      through: '2026-07-04',
      maxPerSchedule: CALENDAR_MAX_PER_SCHEDULE,
    });
  });

  it('drops an occurrence the endpoint returned from before the grid starts', async () => {
    // The endpoint has no lower bound, so it answers from each schedule's next
    // due date -- which is also how an overdue occurrence inside the grid
    // arrives, and that one is kept.
    mockGetOccurrences.mockResolvedValue([
      occurrence('2026-05-01'),
      occurrence('2026-06-02'),
    ]);

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-05-31', '2026-07-04', {}),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data!.occurrences.map((o) => o.dueDate)).toEqual(['2026-06-02']);
  });

  it('reports a month past the row cap as withheld, with its count', async () => {
    mockGetAllPages.mockResolvedValue(
      Array.from({ length: CALENDAR_MAX_ROWS + 1 }, (_, i) => transaction(`tx-${i}`)),
    );

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-05-31', '2026-07-04', {}),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data!.withheld).toBe(true);
    expect(result.current.data!.rowCount).toBe(CALENDAR_MAX_ROWS + 1);
  });

  it('draws a month exactly at the cap', async () => {
    mockGetAllPages.mockResolvedValue(
      Array.from({ length: CALENDAR_MAX_ROWS }, (_, i) => transaction(`tx-${i}`)),
    );

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-05-31', '2026-07-04', {}),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data!.withheld).toBe(false);
  });

  it('keeps a failure a failure, never an empty month', async () => {
    mockGetAllPages.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-05-31', '2026-07-04', {}),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
  });

  it('stamps the payload with the request it answers', async () => {
    mockGetAllPages.mockResolvedValue([transaction('tx-1')]);

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-05-31', '2026-07-04', { accountIds: ['a'] }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.dataKey).toBe(result.current.requestKey);
    expect(result.current.isStale).toBe(false);
  });

  it('refetches on a refresh signal without calling it a different question', async () => {
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useCalendarMonthData('2026-05-31', '2026-07-04', {}, refreshKey),
      { initialProps: { refreshKey: 0 } },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const key = result.current.requestKey;

    rerender({ refreshKey: 1 });

    await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(2));
    expect(result.current.requestKey).toBe(key);
  });
});

describe('useCalendarMonthData scheduled items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the month when only the scheduled half fails', async () => {
    // The register's rows are the calendar's substance. A blank month with a
    // retry button, when those rows arrived, hides what the reader asked for
    // -- and the occurrence endpoint refuses a `through` beyond five years, so
    // the toolbar's own next-month button reaches this.
    mockGetAllPages.mockResolvedValue([transaction('t-1')]);
    mockGetOccurrences.mockRejectedValue(new Error('through must be within 1830 days of today'));

    const { result } = renderHook(() =>
      useCalendarMonthData('2031-06-01', '2031-07-05', {}),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.data?.transactions).toHaveLength(1);
    expect(result.current.data?.occurrences).toEqual([]);
    expect(result.current.data?.occurrencesUnavailable).toBe(true);
  });

  it('reports a schedule the per-schedule cap cut short of the grid', async () => {
    // The cap counts from each schedule's next occurrence, not from the month
    // on screen, so a daily schedule stops arriving a few months out. Drawing
    // that month with nothing on it and saying nothing is the defect.
    mockGetAllPages.mockResolvedValue([]);
    mockGetOccurrences.mockResolvedValue(
      Array.from({ length: CALENDAR_MAX_PER_SCHEDULE }, (_, i) =>
        occurrence(`2026-06-${String((i % 28) + 1).padStart(2, '0')}`),
      ),
    );

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-06-01', '2026-07-05', {}),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.occurrencesTruncated).toBe(true);
  });

  it('reports no truncation when a schedule came back under the cap', async () => {
    mockGetAllPages.mockResolvedValue([]);
    mockGetOccurrences.mockResolvedValue([occurrence('2026-06-10'), occurrence('2026-06-17')]);

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-06-01', '2026-07-05', {}),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.occurrencesTruncated).toBe(false);
    expect(result.current.data?.occurrencesUnavailable).toBe(false);
  });

  it('reports no truncation when a capped schedule already reaches the grid end', async () => {
    // At the cap but the last one lands on the grid's last day: nothing is
    // missing from this month, so the banner must stay quiet.
    mockGetAllPages.mockResolvedValue([]);
    mockGetOccurrences.mockResolvedValue([
      ...Array.from({ length: CALENDAR_MAX_PER_SCHEDULE - 1 }, () => occurrence('2026-06-10')),
      occurrence('2026-07-05'),
    ]);

    const { result } = renderHook(() =>
      useCalendarMonthData('2026-06-01', '2026-07-05', {}),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.occurrencesTruncated).toBe(false);
  });
});
