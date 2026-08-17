import { describe, it, expect } from 'vitest';
import { advanceByFrequency, isOneTime, monthlyEquivalent } from './frequency';
import { FREQUENCY_VALUES, FrequencyType } from '@/types/scheduled-transaction';

/** `YYYY-MM-DD` for a local-time Date, matching how the callers key dates. */
function ymd(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const from = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const step = (iso: string, frequency: FrequencyType) => ymd(advanceByFrequency(from(iso), frequency));

describe('advanceByFrequency', () => {
  it.each([
    ['DAILY', '2026-05-10', '2026-05-11'],
    ['WEEKLY', '2026-05-10', '2026-05-17'],
    ['BIWEEKLY', '2026-05-10', '2026-05-24'],
    ['EVERY4WEEKS', '2026-05-10', '2026-06-07'],
    ['MONTHLY', '2026-05-10', '2026-06-10'],
    ['EVERY2MONTHS', '2026-05-10', '2026-07-10'],
    ['QUARTERLY', '2026-05-10', '2026-08-10'],
    ['EVERY4MONTHS', '2026-05-10', '2026-09-10'],
    ['SEMIANNUAL', '2026-05-10', '2026-11-10'],
    ['YEARLY', '2026-05-10', '2027-05-10'],
    ['EVERY2YEARS', '2026-05-10', '2028-05-10'],
  ] as [FrequencyType, string, string][])('steps %s from %s to %s', (frequency, start, expected) => {
    expect(step(start, frequency)).toBe(expected);
  });

  it('handles every frequency the type allows, and every one but ONCE moves forward', () => {
    // A recurring frequency that returns the same date is a calendar or a
    // forecast that projects one occurrence over and over -- the SEMIMONTHLY
    // defect this module was extracted to fix.
    for (const frequency of FREQUENCY_VALUES) {
      expect(() => advanceByFrequency(from('2026-05-10'), frequency)).not.toThrow();
      const stepped = step('2026-05-10', frequency);
      if (frequency === 'ONCE') {
        expect(stepped).toBe('2026-05-10');
      } else {
        expect(stepped > '2026-05-10').toBe(true);
      }
    }
  });

  it('never mutates the input date', () => {
    const input = from('2026-05-10');
    advanceByFrequency(input, 'YEARLY');
    expect(ymd(input)).toBe('2026-05-10');
  });

  it('returns an equal date for ONCE, so callers must stop themselves', () => {
    expect(step('2026-05-10', 'ONCE')).toBe('2026-05-10');
    expect(isOneTime('ONCE')).toBe(true);
    expect(isOneTime('MONTHLY')).toBe(false);
  });

  describe('month-end clamping', () => {
    it('clamps a 31st into a 30-day month instead of overflowing', () => {
      // setMonth alone would give 2026-07-01 here.
      expect(step('2026-05-31', 'MONTHLY')).toBe('2026-06-30');
    });

    it('clamps into February, leap and non-leap', () => {
      expect(step('2026-12-31', 'EVERY2MONTHS')).toBe('2027-02-28');
      expect(step('2023-12-31', 'EVERY2MONTHS')).toBe('2024-02-29');
      expect(step('2026-08-31', 'SEMIANNUAL')).toBe('2027-02-28');
    });

    it('clamps Feb 29 to Feb 28 a year later', () => {
      expect(step('2024-02-29', 'YEARLY')).toBe('2025-02-28');
    });
  });

  describe('the two frequencies PR #192 mis-mapped', () => {
    it('EVERY2MONTHS is two months, not two weeks', () => {
      expect(step('2026-05-10', 'EVERY2MONTHS')).toBe('2026-07-10');
      expect(step('2026-05-10', 'EVERY2MONTHS')).not.toBe(step('2026-05-10', 'BIWEEKLY'));
    });

    it('SEMIANNUAL is six months, not a year', () => {
      expect(step('2026-05-10', 'SEMIANNUAL')).toBe('2026-11-10');
      expect(step('2026-05-10', 'SEMIANNUAL')).not.toBe(step('2026-05-10', 'YEARLY'));
    });

    it('six EVERY2MONTHS steps and two SEMIANNUAL steps each cover a year', () => {
      let bimonthly = from('2026-01-15');
      for (let i = 0; i < 6; i++) bimonthly = advanceByFrequency(bimonthly, 'EVERY2MONTHS');
      expect(ymd(bimonthly)).toBe('2027-01-15');

      let semiannual = from('2026-01-15');
      for (let i = 0; i < 2; i++) semiannual = advanceByFrequency(semiannual, 'SEMIANNUAL');
      expect(ymd(semiannual)).toBe('2027-01-15');
    });
  });

  describe('SEMIMONTHLY', () => {
    it('goes from on-or-before the 15th to the end of the month', () => {
      expect(step('2026-05-01', 'SEMIMONTHLY')).toBe('2026-05-31');
      expect(step('2026-05-15', 'SEMIMONTHLY')).toBe('2026-05-31');
    });

    it('goes from the end of the month to the 15th of the next', () => {
      expect(step('2026-05-31', 'SEMIMONTHLY')).toBe('2026-06-15');
      expect(step('2025-02-28', 'SEMIMONTHLY')).toBe('2025-03-15');
    });

    it('always advances, so a calendar loop terminates', () => {
      // Regression: the bills calendar and the upcoming-bills report had no
      // SEMIMONTHLY case, so nextDate never moved and the same day repeated
      // until the iteration cap.
      let date = from('2026-01-10');
      for (let i = 0; i < 8; i++) {
        const next = advanceByFrequency(date, 'SEMIMONTHLY');
        expect(next.getTime()).toBeGreaterThan(date.getTime());
        date = next;
      }
    });
  });
});

describe('monthlyEquivalent', () => {
  it('leaves a monthly amount unchanged', () => {
    expect(monthlyEquivalent(100, 'MONTHLY')).toBe(100);
  });

  it.each([
    ['EVERY2MONTHS', 120, 60],
    ['QUARTERLY', 120, 40],
    ['SEMIANNUAL', 120, 20],
    ['YEARLY', 120, 10],
    ['SEMIMONTHLY', 100, 200],
  ] as [FrequencyType, number, number][])('spreads %s over a month', (frequency, amount, expected) => {
    expect(monthlyEquivalent(amount, frequency)).toBeCloseTo(expected, 6);
  });

  it('treats a one-time entry as no recurring monthly cost', () => {
    expect(monthlyEquivalent(500, 'ONCE')).toBe(0);
  });

  it('uses the real year length for the week-based frequencies', () => {
    expect(monthlyEquivalent(100, 'WEEKLY')).toBeCloseTo((100 * 365.25) / 7 / 12, 6);
    expect(monthlyEquivalent(100, 'BIWEEKLY')).toBeCloseTo((100 * 365.25) / 14 / 12, 6);
    expect(monthlyEquivalent(100, 'EVERY4WEEKS')).toBeCloseTo((100 * 365.25) / 28 / 12, 6);
  });

  it('covers every frequency, so a new one cannot silently count as zero', () => {
    for (const frequency of FREQUENCY_VALUES) {
      if (frequency === 'ONCE') continue;
      expect(monthlyEquivalent(100, frequency)).toBeGreaterThan(0);
    }
  });
});
