import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { useBondRefreshProgress } from './useBondRefreshProgress';

const mockGetProgress = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getBondRefreshProgress: (...args: unknown[]) => mockGetProgress(...args),
  },
}));

const NOW = new Date('2026-10-11T12:00:00.000Z');

const payload = (startedAt: string | null, done = 1) => ({
  startedAt,
  phase: 'series' as const,
  done,
  total: 8,
  seriesCode: 'EDO0136',
  finishedAt: null,
});

describe('useBondRefreshProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockGetProgress.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = async (ms = 1500) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('polls every 1.5 s while active and stops when it turns inactive', async () => {
    mockGetProgress.mockResolvedValue(payload(NOW.toISOString()));
    const { result, rerender } = renderHook(
      ({ active }) => useBondRefreshProgress('prog-1', active),
      { initialProps: { active: true } },
    );
    expect(mockGetProgress).not.toHaveBeenCalled();

    await tick();
    expect(mockGetProgress).toHaveBeenCalledTimes(1);
    expect(mockGetProgress).toHaveBeenCalledWith('prog-1');
    expect(result.current?.done).toBe(1);

    await tick();
    expect(mockGetProgress).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    await tick(5000);
    expect(mockGetProgress).toHaveBeenCalledTimes(2);
  });

  it('stops polling on unmount', async () => {
    mockGetProgress.mockResolvedValue(payload(NOW.toISOString()));
    const { unmount } = renderHook(() => useBondRefreshProgress('prog-1', true));
    await tick();
    unmount();
    await tick(5000);
    expect(mockGetProgress).toHaveBeenCalledTimes(1);
  });

  it('does not poll without a program', async () => {
    renderHook(() => useBondRefreshProgress(null, true));
    await tick(5000);
    expect(mockGetProgress).not.toHaveBeenCalled();
  });

  it('ignores progress of a previous refresh and accepts one within the skew', async () => {
    mockGetProgress.mockResolvedValueOnce(payload('2026-10-11T11:59:50.000Z'));
    const { result } = renderHook(() => useBondRefreshProgress('prog-1', true));
    await tick();
    expect(result.current).toBeNull();

    // 3 s before polling began: inside the 5 s skew.
    mockGetProgress.mockResolvedValueOnce(payload('2026-10-11T11:59:57.000Z', 3));
    await tick();
    expect(result.current?.done).toBe(3);
  });

  it('ignores a payload with no startedAt', async () => {
    mockGetProgress.mockResolvedValue(payload(null));
    const { result } = renderHook(() => useBondRefreshProgress('prog-1', true));
    await tick();
    expect(result.current).toBeNull();
  });

  it('keeps the last state when a poll fails', async () => {
    mockGetProgress.mockResolvedValueOnce(payload(NOW.toISOString(), 2));
    const { result } = renderHook(() => useBondRefreshProgress('prog-1', true));
    await tick();
    expect(result.current?.done).toBe(2);

    mockGetProgress.mockRejectedValueOnce(new Error('offline'));
    await tick();
    expect(mockGetProgress).toHaveBeenCalledTimes(2);
    expect(result.current?.done).toBe(2);
  });

  it('starts a new run from nothing received', async () => {
    mockGetProgress.mockResolvedValue(payload(NOW.toISOString(), 4));
    const { result, rerender } = renderHook(
      ({ active }) => useBondRefreshProgress('prog-1', active),
      { initialProps: { active: true } },
    );
    await tick();
    expect(result.current?.done).toBe(4);
    rerender({ active: false });
    rerender({ active: true });
    expect(result.current).toBeNull();
  });
});
