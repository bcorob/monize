import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import { useTaggedFlowBucket } from './useTaggedFlowBucket';
import type { IncomeExpenseTagBucket } from '@/types/built-in-reports';

const period = (p: string, inflows: number) => ({
  period: p,
  periodStart: `${p}-01`,
  periodEnd: `${p}-28`,
  income: 0,
  expenses: 0,
  net: 0,
  taggedInflows: inflows,
  taggedOutflows: 0,
});
const totals = { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 };
const bucket = (value: string, isUntagged: boolean, inflows: number): IncomeExpenseTagBucket => ({
  value,
  isUntagged,
  data: [period('2024-01', inflows)],
  totals,
  taggedInflows: inflows,
  taggedOutflows: 0,
  missingCurrencies: [],
  excludedCount: 0,
});

const response = {
  tagKey: 'scope',
  buckets: [bucket('household', false, 7), bucket('__untagged__', true, 0)],
};

describe('useTaggedFlowBucket', () => {
  it('has no bucket without a tag key', () => {
    const { result } = renderHook(() => useTaggedFlowBucket({ buckets: response.buckets }, ''));
    expect(result.current.activeBucket).toBeUndefined();
    expect(result.current.flowBucket).toBeUndefined();
    expect(result.current.flowsByPeriod.size).toBe(0);
  });

  it('has no bucket without a response', () => {
    const { result } = renderHook(() => useTaggedFlowBucket(null, ''));
    expect(result.current.activeBucket).toBeUndefined();
  });

  it('falls back to the first bucket for an unknown value, like the breakdown card', () => {
    const { result } = renderHook(() => useTaggedFlowBucket(response, 'nope'));
    expect(result.current.activeBucket?.value).toBe('household');
    expect(result.current.flowBucket?.value).toBe('household');
    expect(result.current.flowsByPeriod.get('2024-01')?.taggedInflows).toBe(7);
  });

  it('keeps the untagged bucket active but draws no flows for it', () => {
    const { result } = renderHook(() => useTaggedFlowBucket(response, '__untagged__'));
    expect(result.current.activeBucket?.isUntagged).toBe(true);
    expect(result.current.flowBucket).toBeUndefined();
    expect(result.current.flowsByPeriod.size).toBe(0);
  });
});
