import { describe, it, expect } from 'vitest';

/**
 * One financial calendar, and every loan projection surface asks it.
 *
 * "Is this installment overdue", "which rate is in effect", "where does an
 * unanchored row 1 fall" are calendar-day questions, and the backend answers
 * them for the same loan against `todayYMD()` -- the user's stored timezone,
 * falling back to the browser zone the axios interceptor sends. A frontend that
 * answers them against `new Date().toISOString()` is on a third calendar that
 * agrees with neither, for two hours after local midnight at UTC+2, fourteen at
 * UTC+14, and the mirror window before midnight west of Greenwich. Inside that
 * window the amortization report accepted an anchor the bill had already
 * marked overdue and projected from a balance the ledger no longer held.
 *
 * `todayYmd` is therefore an argument, defaulted rather than required so the
 * compiler cannot police it -- so this does. Same shape as
 * `loan-projection-anchor.guard.test.ts`, which enumerates the other half of
 * the same call: which boundary a surface prices at.
 */
/** The repo's file-scan idiom -- Vite resolves this, no fs walk needed. */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The module that owns the decision; its own default is the thing scanned. */
const OWNER = '/src/lib/loan-history.ts';

/**
 * The banned spelling: a UTC instant sliced into a calendar day.
 *
 * Written as a pattern rather than as prose because prose describing it is
 * exactly what a raw-text scan would trip on -- hence `stripComments` below,
 * tested in both directions.
 */
const UTC_DAY = /toISOString\(\)\s*\.\s*(slice|split)\s*\(/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * The argument list of every call to `fn`, by balanced parentheses rather than
 * a bounded lookahead -- a file that calls the projection twice has to satisfy
 * this at BOTH sites, and a regex that stops at the first match would let the
 * second one through. Arguments here are identifiers and object literals; a
 * parenthesis inside a string literal would confuse it, and there are none.
 */
function callArguments(source: string, fn: string): string[] {
  const calls: string[] = [];
  const opening = new RegExp(`\\b${fn}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    calls.push(source.slice(start, i - 1));
  }
  return calls;
}

const PROJECTION_ENTRY_POINTS = [
  'buildLoanProjectionInput',
  'resolveCurrentLoanTerms',
];

function callSites(): [string, string][] {
  return Object.entries(sources)
    .filter(([path]) => !/\.test\.tsx?$/.test(path) && path !== OWNER)
    .map(([path, content]) => [path, stripComments(content)] as [string, string])
    .filter(([, content]) =>
      PROJECTION_ENTRY_POINTS.some((fn) => callArguments(content, fn).length > 0),
    );
}

describe('loan projection calendar day', () => {
  it('blanks comments while preserving line numbers', () => {
    const stripped = stripComments('a\n// x.toISOString().slice(0, 10)\nb');
    expect(stripped.split('\n')).toHaveLength(3);
    expect(UTC_DAY.test(stripped)).toBe(false);
    // The other direction: a real occurrence still trips the scan, so a
    // stripper that blanked too much would not read as compliance.
    expect(UTC_DAY.test(stripComments('const d = x.toISOString().slice(0, 10);'))).toBe(
      true,
    );
  });

  it('finds the call sites it is meant to police', () => {
    // A rename that made the scan match nothing would look like compliance.
    expect(callSites().length).toBeGreaterThanOrEqual(4);
  });

  it('every projection call states the day it is made on', () => {
    const offenders: string[] = [];
    for (const [path, content] of callSites()) {
      for (const fn of PROJECTION_ENTRY_POINTS) {
        for (const args of callArguments(content, fn)) {
          if (!/\btodayYmd\b/.test(args)) offenders.push(`${path}: ${fn}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and resolves that day from the user timezone, not the clock', () => {
    // `useFinancialToday()` reads the stored preference and falls back to the
    // browser zone -- the backend's own resolution order. A local `todayYmd`
    // built some other way would satisfy the argument check above and
    // reintroduce the defect, so the source of the value is checked too.
    const offenders = callSites()
      .filter(
        ([, content]) => !/\b(useFinancialToday|financialTodayYmd)\b/.test(content),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('no loan projection source derives a calendar day from a UTC instant', () => {
    const scanned = [OWNER, ...callSites().map(([path]) => path)];
    const offenders = scanned.filter((path) =>
      UTC_DAY.test(stripComments(sources[path])),
    );
    expect(offenders).toEqual([]);
  });
});
