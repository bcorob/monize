import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveEffectiveLoanTerms } from '@/lib/loan-comparison';
import type { RateTimelineRow } from '@/lib/loan-schedule';

/**
 * The scheduled loan bill and this layer's amortization projection must price
 * an installment at the SAME rate (INV-LOAN-006, issue #1253).
 *
 * They were taught to price the same balance first; the rate stayed split --
 * the backend read `accounts.interest_rate` while this layer read the
 * `loan_rate_changes` timeline, and recording a rate change deliberately does
 * not write that column, so any loan with rate history showed a first
 * projected row disagreeing with its own bill.
 *
 * The two layers cannot import each other, so the rule lives as a shared truth
 * table in the backend and BOTH suites assert it -- the same mechanism
 * `loan-rate-changes.contract.test.ts` uses for the account-type constant. A
 * case added on either side is a case both must satisfy.
 */
const CASES_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'backend',
  'src',
  'accounts',
  'loan-rate-timeline-cases.json',
);

interface RateCase {
  name: string;
  rows: { effectiveDate: string; annualRate: number }[];
  asOfDate: string;
  fallback: number | null;
  expected: number | null;
}

const table = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
const CASES: RateCase[] = table.cases;

describe('loan rate timeline, shared with the backend', () => {
  it('reads the backend truth table', () => {
    expect(CASES.length).toBeGreaterThan(5);
    expect(table.comment).toContain('INV-LOAN-006');
  });

  it.each(CASES)(
    'resolves the same rate as the bill: $name',
    ({ rows, asOfDate, fallback, expected }) => {
      const resolved = resolveEffectiveLoanTerms(
        rows as RateTimelineRow[],
        asOfDate,
        fallback,
      ).annualRate;
      expect(resolved).toBe(expected);
    },
  );
});
