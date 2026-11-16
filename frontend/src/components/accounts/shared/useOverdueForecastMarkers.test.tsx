import { describe, expect, it } from 'vitest';
import { renderHook } from '@/test/render';
import {
  EMPTY_BALANCE_FORECAST_STATE,
  type BalanceForecastState,
} from './balance-forecast-state';
import { useOverdueForecastMarkers } from './useOverdueForecastMarkers';

const withOverdue = (
  overdue: BalanceForecastState['overdue'],
  points: BalanceForecastState['points'] = [],
): BalanceForecastState => ({ ...EMPTY_BALANCE_FORECAST_STATE, overdue, points });

describe('useOverdueForecastMarkers (discussion #1784)', () => {
  it('marks the first projected day with how many bills were overdue', () => {
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 2, amount: -300 })),
    );
    expect(result.current).toEqual([
      { date: '2026-03-02', direction: 'out', label: 'Includes 2 overdue scheduled transactions' },
    ]);
  });

  it('points the marker up when the overdue occurrences net to money in on a day that does not move', () => {
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 1, amount: 120 })),
    );
    expect(result.current).toEqual([
      { date: '2026-03-02', direction: 'in', label: 'Includes 1 overdue scheduled transaction' },
    ]);
  });

  it("takes the colour from the day's move, not from the overdue net", () => {
    // An overdue +120 deposit and a -900 bill due today land on the same day,
    // which falls by 780.
    const points = [
      { date: '2026-03-01', balance: 2000 },
      { date: '2026-03-02', balance: 1220 },
    ];
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 1, amount: 120 }, points)),
    );
    expect(result.current).toEqual([
      { date: '2026-03-02', direction: 'out', label: 'Includes 1 overdue scheduled transaction' },
    ]);
  });

  it("does not borrow a later day's move when the overdue day has no point of its own", () => {
    // The series only has points where the balance changes: a later -900 bill
    // must not colour a day whose overdue occurrences net to money in.
    const points = [
      { date: '2026-03-01', balance: 2000 },
      { date: '2026-03-10', balance: 1100 },
    ];
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 1, amount: 120 }, points)),
    );
    expect(result.current[0].direction).toBe('in');
  });

  it('draws nothing when nothing is overdue', () => {
    const { result } = renderHook(() => useOverdueForecastMarkers(withOverdue(null)));
    expect(result.current).toEqual([]);
  });

  it('still marks the day when the overdue occurrences net to zero, as the summary note counts them', () => {
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 2, amount: 0 })),
    );
    expect(result.current).toEqual([
      { date: '2026-03-02', direction: 'in', label: 'Includes 2 overdue scheduled transactions' },
    ]);
  });
});
