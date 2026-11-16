import { describe, it, expect } from 'vitest';
import { blankComments } from '@/test/blank-comments';

/**
 * Guards for the calendar's half of design invariants I1 and I6
 * (`docs/specs/calendar-view.md`): every figure a calendar prints is
 * the server's, and every colour it paints comes from an existing mapping.
 *
 * These are scans rather than paragraphs because each mistake they ban is
 * mechanical and locally plausible. Summing a day's chips into a day total is
 * four characters of `.reduce(` and reads as an obvious convenience; it is in
 * fact a currency-blind sum with no honest way to withhold itself when a rate
 * is missing (`docs/frontend/financial-figures.md`). Painting a percentage
 * green with a literal reads identically to calling `gainLossColor` and
 * diverges the moment the palette moves. Neither breaks a behaviour test, so
 * neither would be caught by one.
 *
 * Every block below pairs "the tree has no offender" with a planted fixture,
 * because a scan whose pattern has rotted passes over an empty set and reports
 * the same green as a clean tree (`docs/guard-tests.md`).
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: a test legitimately spells the shapes it asserts on. */
function productionEntries(prefix: string): [string, string][] {
  return Object.entries(sources)
    .filter(([path]) => path.startsWith(prefix) && !/\.test\.tsx?$/.test(path))
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The views: everything that draws a calendar cell, a day panel, a banner or
 * the movement popup. Nothing here may do arithmetic on money at all.
 */
const VIEWS = productionEntries('/src/components/calendar/');

/**
 * The modules that shape a calendar's data before a view reads it. They may
 * count and group; they may not add money up. `useCalendarMonthData` counts
 * rows per day, which is what makes a blanket `+=` ban wrong here and a
 * money-named one right.
 */
const DATA_MODULES: ReadonlyArray<string> = [
  '/src/lib/calendar-rows.ts',
  '/src/lib/calendar-month.ts',
  '/src/lib/day-note-span.ts',
  '/src/lib/month-input.ts',
  '/src/hooks/useCalendarMonthData.ts',
  '/src/hooks/useCalendarDayNotes.ts',
  '/src/hooks/useDailyBalanceTotals.ts',
  '/src/hooks/useDailyMovements.ts',
  '/src/hooks/useInvestmentDailyValues.ts',
];

const CALENDAR_PATH: ReadonlyArray<string> = [...VIEWS.map(([path]) => path), ...DATA_MODULES];

function codeOf(path: string): string {
  const source = sources[path];
  expect(source, `${path} is not in the scan -- renamed or moved?`).toBeDefined();
  return blankComments(source);
}

function linesMatching(source: string, pattern: RegExp): number[] {
  return source
    .split('\n')
    .map((line, index) => (pattern.test(line) ? index + 1 : 0))
    .filter((line) => line > 0);
}

describe('the calendar path finds every module it polices', () => {
  it('sees the views', () => {
    // An empty set passes every scan below, so the count is asserted rather
    // than assumed: a directory rename turns this red before it turns the
    // rules into no-ops.
    expect(VIEWS.length).toBeGreaterThanOrEqual(7);
  });

  it.each(DATA_MODULES)('sees %s', (path) => {
    expect(sources[path], `${path} is not in the scan -- renamed or moved?`).toBeDefined();
  });
});

describe('a calendar adds nothing up (I1)', () => {
  /**
   * A fold is the shape a day total arrives in. Banned outright in a view:
   * there is nothing in a cell worth folding that the server has not already
   * folded, and the one thing a view is tempted to fold -- the day's amounts --
   * is the thing it must not.
   */
  const FOLDS = /\.reduce\s*\(/;

  /** Accumulation, in the spellings people write it. */
  const ACCUMULATES = /(?:\+=|-=)/;

  /**
   * A money-named accumulation, for the modules that may legitimately count.
   * The nouns are the ones design I1 names plus the ones a fold over them
   * would be called.
   */
  const MONEY =
    /\b(?:amount|balance|value|movement|total|subtotal|gain|loss|price|quantity|percent)\w*\b/i;

  it.each(VIEWS.map(([path]) => path))('folds and accumulates nothing in %s', (path) => {
    const code = codeOf(path);
    expect(
      [...linesMatching(code, FOLDS), ...linesMatching(code, ACCUMULATES)].sort((a, b) => a - b),
      `${path} sums something. A calendar prints the figures the endpoints in ` +
        'design section 6 already decided; a day total with no currency and no ' +
        'way to withhold itself is not one of them.',
    ).toEqual([]);
  });

  it.each(DATA_MODULES)('accumulates no money in %s', (path) => {
    const offenders = codeOf(path)
      .split('\n')
      .map((line, index) => (ACCUMULATES.test(line) && MONEY.test(line) ? index + 1 : 0))
      .filter((line) => line > 0);
    expect(
      offenders,
      `${path} accumulates money. Counting rows is fine; adding amounts is the ` +
        "server's job (FxAggregate on the server, never a client-side sum).",
    ).toEqual([]);
  });

  it('catches a planted fold and a planted accumulation, and lets a count pass', () => {
    expect(linesMatching('const total = rows.reduce((a, r) => a + r.amount, 0);', FOLDS)).toEqual([
      1,
    ]);
    expect(linesMatching('dayTotal += Number(row.amount);', ACCUMULATES)).toEqual([1]);

    const counting = 'seen.count += 1;';
    expect(ACCUMULATES.test(counting) && MONEY.test(counting)).toBe(false);
    const summing = 'acc.total += Number(row.amount);';
    expect(ACCUMULATES.test(summing) && MONEY.test(summing)).toBe(true);
  });

  it('reads code and not the prose that has to name the pattern', () => {
    // The cheap way past a raw-text scan is a weaker comment, which is the
    // opposite of the point, so the stripper is checked in both directions.
    expect(linesMatching(blankComments('// never write rows.reduce( here'), FOLDS)).toEqual([]);
    expect(linesMatching(blankComments('/* total += amount is the defect */'), ACCUMULATES)).toEqual(
      [],
    );
    expect(linesMatching(blankComments('const x = rows.reduce(f, 0);'), FOLDS)).toEqual([1]);
  });
});

describe('a calendar walks no recurrence (I1)', () => {
  /**
   * A client can derive an occurrence's dates but never its amount, and the
   * calendar prints amounts. `GET /scheduled-transactions/occurrences` is the
   * one expander (INV-OCCURRENCE-003); `scheduled-effective-amount.guard.test.ts`
   * holds the rule tree-wide, and this block holds the calendar's own entrance
   * to it -- an import is the step before the loop.
   */
  const EXPANDS = /\badvanceByFrequency\s*\(|from\s+'@\/lib\/(?:frequency|scheduled-calendar)'/;

  it.each(CALENDAR_PATH)('expands no recurrence in %s', (path) => {
    expect(
      linesMatching(codeOf(path), EXPANDS),
      `${path} expands a recurrence in the browser. Ask ` +
        '`scheduledTransactionsApi.getOccurrences({ through })` instead: only the ' +
        'server can price an occurrence (INV-OCCURRENCE-003).',
    ).toEqual([]);
  });

  it('catches a planted walk and a planted import', () => {
    expect(linesMatching('  next = advanceByFrequency(next, st.frequency);', EXPANDS)).toEqual([1]);
    expect(linesMatching("import { advanceByFrequency } from '@/lib/frequency';", EXPANDS)).toEqual(
      [1],
    );
    expect(linesMatching("import { occurrenceKind } from '@/lib/scheduled-kind';", EXPANDS)).toEqual(
      [],
    );
  });
});

describe('a calendar paints no colour of its own (I6)', () => {
  /**
   * Red and green are the sign of a figure, and the sign of a figure is
   * `gainLossColor` or `balanceColor` (`lib/format.ts`). A chip's ground is
   * `ACCOUNT_TYPE_META[...].pillClass` or `SCHEDULED_KIND_CHIP_CLASSES[...]`,
   * both of which are `bg-<hue>-100` -- so a `bg-<hue>-100` written in a
   * calendar view is a third type-to-colour mapping being born.
   *
   * The one other thing that is legitimately red is an error, and an error
   * announces itself: a line carrying `role="alert"` may wear the app's error
   * colour. That is an escape a figure cannot take, because a figure with
   * `role="alert"` would be announced as an error.
   */
  const SIGN_COLOUR = /\b(?:text|border)-(?:green|red|emerald|rose)-\d{2,3}\b/;
  const CHIP_GROUND = /\bbg-[a-z]+-100\b/;
  const IS_AN_ERROR = /role=["']alert["']/;

  function offendingColourLines(source: string): number[] {
    return source
      .split('\n')
      .map((line, index) =>
        (SIGN_COLOUR.test(line) || CHIP_GROUND.test(line)) && !IS_AN_ERROR.test(line)
          ? index + 1
          : 0,
      )
      .filter((line) => line > 0);
  }

  it.each(VIEWS.map(([path]) => path))('writes no colour literal in %s', (path) => {
    expect(
      offendingColourLines(codeOf(path)),
      `${path} writes a colour literal. A figure's colour is gainLossColor or ` +
        "balanceColor; a chip's is ACCOUNT_TYPE_META[...].pillClass or " +
        'SCHEDULED_KIND_CHIP_CLASSES[...]. A second mapping disagrees with the ' +
        'rest of the app the first time either moves.',
    ).toEqual([]);
  });

  it('catches a planted figure colour and a planted chip ground', () => {
    expect(offendingColourLines('<span className="text-green-600">{pct}</span>')).toEqual([1]);
    expect(offendingColourLines('<span className="bg-blue-100 text-blue-800">{sym}</span>')).toEqual(
      [1],
    );
  });

  it('lets an announced error wear the error colour, and only an announced one', () => {
    expect(
      offendingColourLines('<p className="text-sm text-red-600" role="alert">{error}</p>'),
    ).toEqual([]);
    expect(offendingColourLines('<p className="text-sm text-red-600">{error}</p>')).toEqual([1]);
  });

  it('still matches the mappings it defers to, so the rule cannot rot', () => {
    // Were the shared maps to stop being `bg-<hue>-100`, the chip half of this
    // scan would be banning a shape nothing uses.
    expect(CHIP_GROUND.test(sources['/src/lib/scheduled-kind.ts'])).toBe(true);
    expect(CHIP_GROUND.test(sources['/src/lib/account-type-meta.tsx'])).toBe(true);
    expect(SIGN_COLOUR.test(sources['/src/lib/format.ts'])).toBe(true);
  });
});

describe('a calendar day is a string, and today is the server\'s (I2)', () => {
  /**
   * `calendar-month.guard.test.ts` holds this for the grid's two layout
   * modules; the same rule covers the whole calendar path, where the temptation
   * is `new Date().toISOString().slice(0, 10)` for "today" rather than the
   * `today` the response carries.
   */
  const BUILDS_A_DATE = /\bnew Date\s*\(|\bDate\s*\.\s*(?:parse|UTC|now)\s*\(|\btoISOString\s*\(/;

  it.each(CALENDAR_PATH)('builds no Date and reads no clock in %s', (path) => {
    expect(
      linesMatching(codeOf(path), BUILDS_A_DATE),
      `${path} builds a Date or reads the browser clock. A calendar date is a ` +
        'string; which day is today is the server\'s answer, carried as `today` ' +
        'in the response (design I2).',
    ).toEqual([]);
  });

  it('catches a planted clock read', () => {
    expect(
      linesMatching("const today = new Date().toISOString().slice(0, 10);", BUILDS_A_DATE),
    ).toEqual([1]);
    expect(linesMatching('const t = Date.now();', BUILDS_A_DATE)).toEqual([1]);
    expect(linesMatching('const today = response.today;', BUILDS_A_DATE)).toEqual([]);
  });
});

describe('a completeness flag is read explicitly, never for truthiness', () => {
  /**
   * `pricesComplete` and `fxComplete` are absent from an older backend's
   * response, and absent is no information rather than a claim of
   * completeness. `if (!point.pricesComplete)` withholds a figure the server
   * did work out; `point.pricesComplete === false` withholds only what it
   * could not. The rule is one sentence in `AGENTS.md`; this is the version
   * the machine checks.
   */
  const FLAG = /\b(?:pricesComplete|fxComplete|valuationComplete|amountComplete)\b(?!\s*\??:)/g;
  const COMPARED = /^\s*(?:===|!==)/;

  function looselyReadFlags(source: string): number[] {
    const offenders: number[] = [];
    source.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(FLAG)) {
        const after = line.slice(match.index + match[0].length);
        if (!COMPARED.test(after)) offenders.push(index + 1);
      }
    });
    return offenders;
  }

  it.each(CALENDAR_PATH)('compares every completeness flag in %s', (path) => {
    expect(
      looselyReadFlags(codeOf(path)),
      `${path} reads a completeness flag for truthiness. Write ` +
        '`=== false` (or `!== false`): a flag an older backend never sent is no ' +
        'information, and treating it as incomplete withholds a figure the ' +
        'server did work out.',
    ).toEqual([]);
  });

  it('catches a planted truthiness read and passes an explicit one', () => {
    expect(looselyReadFlags('if (!point.pricesComplete) return unknown;')).toEqual([1]);
    expect(looselyReadFlags('const ok = point.fxComplete && point.pricesComplete;')).toEqual([1, 1]);
    expect(looselyReadFlags('if (point.pricesComplete === false) return unknown;')).toEqual([]);
    expect(looselyReadFlags('return point.fxComplete !== false;')).toEqual([]);
  });

  it('leaves a declaration of the flag alone', () => {
    // The type that declares the field and an object literal that sets it are
    // not reads, and a scan that fails them would push the fix into the type.
    expect(looselyReadFlags('  pricesComplete?: boolean;')).toEqual([]);
    expect(looselyReadFlags('  const point = { date, value, fxComplete: true };')).toEqual([]);
  });
});
