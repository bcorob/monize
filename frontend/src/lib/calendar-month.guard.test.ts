import { describe, it, expect } from 'vitest';

/**
 * The calendar's days are calendar days, so nothing on its path builds a
 * `Date` from one.
 *
 * A `Date` constructed from a calendar date is an instant in the browser's
 * zone, so the 1st of a month is the last day of the previous one for a reader
 * west of UTC, and a grid built from it loses or repeats a day at the month
 * boundary. Reading the clock is the same rule's other half: which day is
 * "today" is the server's answer (design I2), never the browser's.
 *
 * This is a scan rather than a paragraph because CI runs in UTC and the
 * frontend suite pins no timezone, so restoring the mistake breaks nothing any
 * existing test can see. `loan-projection-today.guard.test.ts` is the pattern.
 */

/** The repo's file-scan idiom -- Vite resolves this, no fs walk needed. */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * The modules that turn a month into days and draw them. Their tests are not
 * scanned: pinning a clock is exactly what a test is allowed to do.
 */
const CALENDAR_DAY_MODULES = [
  '/src/lib/calendar-month.ts',
  '/src/components/ui/MonthGrid.tsx',
  // Steps and counts calendar days for a note's span; the same rule applies for
  // the same reason.
  '/src/lib/day-note-span.ts',
  // Reads a typed month, and the year a partial entry leaves out comes from the
  // month on screen -- never from the clock.
  '/src/lib/month-input.ts',
];

/**
 * Written as a pattern because prose describing it is what a raw-text scan
 * would trip on -- `calendar-month.ts` explains the defect by spelling the
 * banned call out, which is why `stripComments` exists and is checked below.
 */
const BUILDS_A_DATE = /\bnew Date\s*\(|\bDate\s*\.\s*(parse|UTC|now)\s*\(/;

/** Blank comments in place, so a reported line number still points at code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function offendingLines(source: string): number[] {
  return stripComments(source)
    .split('\n')
    .map((line, index) => (BUILDS_A_DATE.test(line) ? index + 1 : 0))
    .filter((line) => line > 0);
}

describe('the calendar builds no Date from a calendar day', () => {
  it('finds every module it is meant to police, so the rule cannot pass on an empty set', () => {
    for (const path of CALENDAR_DAY_MODULES) {
      expect(sources[path], `${path} is not in the scan -- renamed or moved?`).toBeDefined();
    }
  });

  it.each(CALENDAR_DAY_MODULES)('builds no Date and reads no clock in %s', (path) => {
    expect(
      offendingLines(sources[path]),
      `${path} builds a Date or reads the clock. A calendar date is a string: ` +
        'step it with the helpers in lib/calendar-month.ts, and take today from ' +
        'the server through the `today` argument.',
    ).toEqual([]);
  });

  it('reads the banned call in code but not one named in a comment', () => {
    // Both directions, because the cheap way past this guard is to weaken the
    // explanation rather than the code -- and that is the opposite of the point.
    expect(BUILDS_A_DATE.test(sources['/src/lib/calendar-month.ts'])).toBe(true);
    expect(offendingLines(sources['/src/lib/calendar-month.ts'])).toEqual([]);

    expect(offendingLines('const d = new Date(iso);')).toEqual([1]);
    expect(offendingLines('const t = Date.now();')).toEqual([1]);
    expect(offendingLines('// never write new Date(iso) here')).toEqual([]);
    expect(offendingLines('/* new Date(iso) is the defect */')).toEqual([]);
  });
});
