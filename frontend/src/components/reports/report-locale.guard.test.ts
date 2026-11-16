import { describe, it, expect } from 'vitest';
import { blankComments } from '@/test/blank-comments';

/**
 * Guard for B3: a date or a share count a reader sees in a report goes through
 * the preference seam -- `useDateFormat().formatDate` for the date,
 * `useNumberFormat().formatShareQuantity` for the count.
 *
 * This is the "the fix for one surface is not the fix" shape. One pass migrated
 * `BillPaymentHistoryReport`, `RealizedGainsReport` and
 * `UncategorizedTransactionsReport` onto `formatDate`, and
 * `InvestmentPerformanceReport` / `RealizedGainsReport` off `.toFixed(4)`, and
 * left the investment reports beside them untouched -- so a `de` reader saw
 * `Jan 5, 2026` on one report's table and their own arrangement on the next,
 * and a `decimal(20,4)` share count printed as the raw string `10.0000` with a
 * `.` decimal in every locale. Two scans, one per half:
 *
 *   1. a date-fns `format(...)` call whose pattern names a month by NAME
 *      (`MMM`), which is English here because no locale is ever passed. The
 *      token itself is fine as an argument to `useChartDateFormat()`'s
 *      `formatChartDate`, which localizes the month name -- that is the chart
 *      convention and is deliberately not matched. An ISO pattern
 *      (`yyyy-MM-dd`, `yyyy-MM`) is also not matched: those are machine values
 *      -- query bounds, month keys, CSV cells -- and ISO is what a machine
 *      surface should write.
 *   2. a `.toFixed(...)` rendering a share count, in either of the two forms
 *      this codebase produced it: a receiver that names a quantity at any
 *      precision, and a bare `.toFixed(4)` whatever it is called, because the
 *      alias is how the last one got through.
 *
 * The date scan carries a shrink-only list of reports outside this change that
 * still hold the pattern; its staleness check fails an entry once its file is
 * fixed, so an exemption cannot outlive the defect it records. The quantity
 * scan has no list: after this change, nothing under `src/components/reports/`
 * renders a count that way.
 */

const sources = import.meta.glob('/src/components/reports/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: a test may legitimately spell the pattern it asserts on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/** 1-indexed line number of a character offset, for an offender report. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Every call to the bare `format` (date-fns). The lookbehind keeps
 * `formatChartDate(...)` and a `.format(...)` on an `Intl` formatter out: only
 * an identifier that IS `format`, called directly, counts.
 */
const BARE_FORMAT_CALL = /(?<![A-Za-z0-9_$.])format\(/g;

/** A quoted string naming a month by NAME rather than by number. */
const MONTH_NAME_PATTERN = /^(['"])[^'"]*MMM[^'"]*\1$/;

/**
 * The text between a call's parentheses, read by counting depth rather than by
 * regex.
 *
 * A regex cannot do this correctly and the two ways it gets it wrong are both
 * real here: a bounded wildcard runs past the closing paren and matches the
 * NEXT call's pattern literal (`format(d, 'yyyy-MM-dd')` followed by
 * `formatChartDate(e, 'MMM')` reads as one offender), while a paren-aware
 * alternative misses `format(startOfMonth(new Date(x)), 'MMM')` at the second
 * level of nesting and a pattern on its own line after a trailing comma. This
 * reads the arguments the way the parser does, so neither happens. Returns null
 * for an unbalanced call, which is a truncated file rather than an offender.
 */
function argumentsOf(source: string, openParen: number): string | null {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    const quoted = skipString(source, i);
    if (quoted !== i) {
      i = quoted - 1;
      continue;
    }
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return null;
}

/**
 * The index just past the string literal starting at `i`, or `i` itself when
 * nothing starts there.
 *
 * Both scanners need this and the reason is the pattern itself: `'MMM d, yyyy'`
 * contains a COMMA, so an argument splitter that does not know about strings
 * cuts the pattern in half and reads `yyyy'` as the last argument -- which is
 * how the first draft of this guard reported the directory clean while
 * `DuplicateTransactionReport` held the very call it was written for. A `)` or
 * `(` inside a literal misleads the depth count the same way.
 */
function skipString(source: string, i: number): number {
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return i;
  for (let j = i + 1; j < source.length; j += 1) {
    if (source[j] === '\\') {
      j += 1;
      continue;
    }
    if (source[j] === quote) return j + 1;
    // An unterminated literal (a quote inside blanked-out prose, an apostrophe)
    // must not swallow the rest of the file.
    if (source[j] === '\n' && quote !== '`') return i;
  }
  return i;
}

/**
 * The call's last argument, which is where date-fns takes its pattern. Split at
 * top level only, so neither a nested call's commas nor the pattern's own
 * split it.
 */
function lastArgument(args: string): string {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const quoted = skipString(args, i);
    if (quoted !== i) {
      i = quoted - 1;
      continue;
    }
    const ch = args[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  // A trailing comma leaves an empty final part; the pattern is the one before.
  const meaningful = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  return meaningful[meaningful.length - 1] ?? '';
}

/** Offsets in `content` of a date-fns `format(...)` given an English month name. */
function englishMonthFormatCalls(content: string): number[] {
  const found: number[] = [];
  for (const match of content.matchAll(BARE_FORMAT_CALL)) {
    const openParen = match.index + match[0].length - 1;
    const args = argumentsOf(content, openParen);
    if (args === null) continue;
    if (MONTH_NAME_PATTERN.test(lastArgument(args))) found.push(match.index);
  }
  return found;
}

/** A `.toFixed(...)` whose receiver names a share count, at any precision. */
const QUANTITY_TO_FIXED = /\b\w*(?:quantity|Quantity|shares|Shares)\w*(?:\s*\))*\s*\.toFixed\(/g;

/** The share-precision fingerprint, whatever the receiver is called. */
const FOUR_DP_TO_FIXED = /\.toFixed\(\s*4\s*\)/g;

/**
 * Reports outside this change that still render an English month name, with
 * what each one is. Delete an entry when its file moves onto `formatDate` (or,
 * for a chart-shaped label, `formatChartDate`); leaving it fails the staleness
 * check below.
 */
const ENGLISH_MONTH_BASELINE: Record<string, string> = {};

describe('the comment stripper', () => {
  it('blanks a comment while preserving line numbers', () => {
    const stripped = blankComments("const a = 1;\n// format(d, 'MMM d, yyyy') and toFixed(4)\nconst b = 2;");
    expect(stripped).not.toContain('MMM');
    expect(stripped).not.toContain('toFixed');
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('leaves code alone, so a real offender is still found', () => {
    const stripped = blankComments("const d = format(parseLocalDate(x), 'MMM d, yyyy');");
    expect(stripped).toContain("'MMM d, yyyy'");
  });
});

describe("a report's date is the reader's arrangement", () => {
  function offenders(): string[] {
    const found: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (path in ENGLISH_MONTH_BASELINE) continue;
      const content = blankComments(raw);
      for (const index of englishMonthFormatCalls(content)) {
        found.push(`${path}:${lineOf(content, index)}`);
      }
    }
    return found;
  }

  it('has no date-fns format with an English month name', () => {
    // Use `useDateFormat().formatDate(value)` for a date in a table, a cell or
    // a PDF; `useChartDateFormat()` with the same token for a chart label.
    expect(offenders()).toEqual([]);
  });

  it('matches the shape it was written for, and not the localizing helper', () => {
    // Positive and negative controls. Without the first, the scan above could
    // pass over a codebase full of offenders; without the second it would fail
    // every chart in the directory and the honest response would be to delete
    // it.
    const cases: [string, boolean][] = [
      // The two shapes this change removed.
      ["const s = format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy');", true],
      ["const s = format(parseISO(summary.projectedPayoffDate), 'MMM yyyy');", true],
      // Nested two deep, and split across lines with a trailing comma: both are
      // ordinary formatting of this call and a regex misses them.
      ["const s = format(startOfMonth(new Date(y, m, 1)), 'MMMM yyyy');", true],
      ["const s = format(\n  parseLocalDate(d),\n  'MMM d, yyyy',\n);", true],
      // The localizing chart helper takes the identical token: not an offender.
      ["const s = formatChartDate(parsed, 'MMM d, yyyy');", false],
      ["const s = useChartDateFormat()(parsed, 'MMM yyyy');", false],
      // An Intl formatter's own method.
      ["const s = monthFormatter.format(date) + 'MMM';", false],
      // ISO patterns are machine values: a query bound, a month key, a CSV cell.
      ["const s = format(parseLocalDate(tx.transactionDate), 'yyyy-MM-dd');", false],
      ["const s = format(month, 'yyyy-MM');", false],
      // A bare `format` beside a chart call must not borrow the chart's token:
      // this is the false positive a bounded wildcard produces.
      [
        "const a = format(d, 'yyyy-MM-dd');\nconst b = formatChartDate(e, 'MMM');",
        false,
      ],
    ];

    for (const [source, expected] of cases) {
      expect(englishMonthFormatCalls(source).length > 0, source).toBe(expected);
    }
  });

  it('keeps every baselined report honest', () => {
    for (const path of Object.keys(ENGLISH_MONTH_BASELINE)) {
      expect(sources[path], `${path} is baselined but does not exist`).toBeTruthy();
      const content = blankComments(sources[path]);
      expect(
        englishMonthFormatCalls(content).length,
        `${path} no longer formats an English month name -- delete its baseline entry`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("a report's share count is the reader's number locale", () => {
  it('renders no quantity through toFixed', () => {
    // A `Set`: the two patterns overlap on the commonest offender
    // (`quantity.toFixed(4)`), and one line reported twice reads as two defects.
    const found = new Set<string>();
    for (const [path, raw] of productionSources()) {
      const content = blankComments(raw);
      for (const pattern of [QUANTITY_TO_FIXED, FOUR_DP_TO_FIXED]) {
        for (const match of content.matchAll(pattern)) {
          found.add(`${path}:${lineOf(content, match.index)}`);
        }
      }
    }

    // Use `useNumberFormat().formatShareQuantity(value)`: eight decimals so a
    // residual position survives, the reader's own decimal mark, and `-0`
    // normalized. `toFixed` writes a `.` in every locale.
    expect([...found]).toEqual([]);
  });

  it('matches both shapes it was written for', () => {
    // The receiver form and the precision form, each of which shipped here.
    QUANTITY_TO_FIXED.lastIndex = 0;
    expect(QUANTITY_TO_FIXED.test('{Math.abs(tx.quantity).toFixed(4)}')).toBe(true);
    QUANTITY_TO_FIXED.lastIndex = 0;
    expect(QUANTITY_TO_FIXED.test('{holding.totalShares.toFixed(8)}')).toBe(true);
    FOUR_DP_TO_FIXED.lastIndex = 0;
    expect(FOUR_DP_TO_FIXED.test('{splitPreview.currentAvg.toFixed(4)}')).toBe(true);

    // And leaves a rate and a money figure to the rules that own them: an FX
    // rate is 6dp by `FX_RATE_DISPLAY_DECIMALS` and a percentage is the `%`
    // scan's subject in `src/test/number-locale.guard.test.ts`.
    QUANTITY_TO_FIXED.lastIndex = 0;
    expect(QUANTITY_TO_FIXED.test('item.rate.toFixed(FX_RATE_DISPLAY_DECIMALS)')).toBe(false);
    FOUR_DP_TO_FIXED.lastIndex = 0;
    expect(FOUR_DP_TO_FIXED.test('point.savingsRate.toFixed(1)')).toBe(false);
  });

  it('offers the formatter to migrate to', () => {
    // Without it the rule has no answer for a holdings column.
    const hook = import.meta.glob('/src/hooks/useNumberFormat.ts', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>;
    expect(hook['/src/hooks/useNumberFormat.ts']).toContain(
      'const formatShareQuantity = useCallback',
    );
  });
});
