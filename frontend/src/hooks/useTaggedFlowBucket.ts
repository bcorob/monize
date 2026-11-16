'use client';

import { useMemo } from 'react';
import type {
  IncomeExpenseTagBucket,
  IncomeExpenseTagPeriodItem,
} from '@/types/built-in-reports';

interface TagBreakdownResponse {
  tagKey?: string;
  buckets?: IncomeExpenseTagBucket[];
}

export interface TaggedFlowBucket {
  /** The bucket the breakdown card shows (the first when the value is unknown). */
  activeBucket: IncomeExpenseTagBucket | undefined;
  /**
   * The active bucket when it carries tagged flows to draw. The untagged bucket
   * has none (an untagged transfer appears nowhere), so it adds no series.
   */
  flowBucket: IncomeExpenseTagBucket | undefined;
  /** The flow bucket's per-period rows by `period`, for aligning with the main series. */
  flowsByPeriod: ReadonlyMap<string, IncomeExpenseTagPeriodItem>;
}

const NO_FLOWS: ReadonlyMap<string, IncomeExpenseTagPeriodItem> = new Map();

/**
 * "Which bucket does the main chart follow, and what are its per-period
 * flows" for every report that shows a tag-key breakdown beside its chart
 * (Income vs Expenses, Cash Flow). The breakdown card falls back to the first
 * bucket for a value it does not have; this does the same so the card and the
 * chart cannot disagree (`docs/specs/report-tag-key-breakdown.md` section 10).
 */
export function useTaggedFlowBucket(
  response: TagBreakdownResponse | null | undefined,
  activeValue: string,
): TaggedFlowBucket {
  const activeBucket = useMemo(
    () =>
      response?.tagKey && response.buckets
        ? (response.buckets.find((b) => b.value === activeValue) ?? response.buckets[0])
        : undefined,
    [response, activeValue],
  );
  const flowBucket = activeBucket && !activeBucket.isUntagged ? activeBucket : undefined;
  const flowsByPeriod = useMemo(
    () => (flowBucket ? new Map(flowBucket.data.map((d) => [d.period, d])) : NO_FLOWS),
    [flowBucket],
  );
  return { activeBucket, flowBucket, flowsByPeriod };
}
