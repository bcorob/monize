import { describe, it, expect } from 'vitest';

/**
 * Guard for issue #1455: a small helper is written once and imported, never
 * re-declared in the file that wants it.
 *
 * `round2` was defined four times beside an existing `roundToCents`, `roundMoney`
 * three times at two rounding strategies, and `clamp` and a UUID pattern twice
 * each. A local copy looks harmless and drifts quietly: the copies of
 * `roundMoney` disagreed with the backend's on a midpoint, so a preview and the
 * figure the server committed could differ by a unit in the last place.
 *
 * The same applies to a component's own `formatCurrency`. Each one wrapped the
 * hook's, under the hook's name, to add something the name no longer said (an
 * `abs`, a dash for null, a currency code, a `|| 0`), so a reader could not tell
 * the hook's formatter from a local one with different rules.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: a test may declare a stand-in with the same name. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

/**
 * Blank out comment bodies, keeping line breaks so reported line numbers still
 * point at the source. Same technique as `number-locale.guard.test.ts`.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) =>
        before + ' '.repeat(match.length - before.length),
    );
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** A declaration of `name` as a function or a const, at any indentation. */
function declarationOf(name: string): RegExp {
  return new RegExp(
    String.raw`(?:\bfunction\s+${name}\s*[(<]|\bconst\s+${name}\s*[=:])`,
    'g',
  );
}

function declarationsOutside(name: string, home: string): string[] {
  const offenders: string[] = [];
  for (const [path, raw] of productionSources()) {
    if (path === home) continue;
    const content = withoutComments(raw);
    for (const match of content.matchAll(declarationOf(name))) {
      offenders.push(`${path}:${lineOf(content, match.index)}`);
    }
  }
  return offenders;
}

/** Each helper, and the one module it is declared in. */
const HELPERS: Record<string, string> = {
  roundToDecimals: '/src/lib/format.ts',
  roundToCents: '/src/lib/format.ts',
  roundMoney: '/src/lib/format.ts',
  sumMoney: '/src/lib/format.ts',
  withCurrencyCode: '/src/lib/format.ts',
  clamp: '/src/lib/clamp.ts',
  isUuid: '/src/lib/uuid.ts',
  textOrNull: '/src/lib/form-text.ts',
};

/** Names that were only ever a local copy of a helper above. */
const RETIRED = ['round2', 'round4'];

describe('the shared helpers are declared once', () => {
  it.each(Object.entries(HELPERS))(
    '%s is declared only in %s',
    (name, home) => {
      // Import it from its home module. A second declaration is a second
      // rounding strategy, bound or pattern waiting to disagree with the first.
      expect(declarationsOutside(name, home)).toEqual([]);
    },
  );

  it.each(Object.entries(HELPERS))(
    '%s is still exported from %s, so the rule cannot pass by accident',
    (name, home) => {
      expect(sources[home], `${home} not found -- update this guard`).toBeTruthy();
      expect(sources[home]).toMatch(
        new RegExp(String.raw`export function ${name}\s*[(<]`),
      );
    },
  );

  it.each(RETIRED)('%s is not declared anywhere', (name) => {
    // `roundToCents` (2dp) and `roundMoney` (4dp) in `lib/format.ts`.
    expect(declarationsOutside(name, '')).toEqual([]);
  });

  it('matches a declaration but not a call or a longer name', () => {
    const pattern = declarationOf('clamp');
    expect('function clamp(v: number) {}').toMatch(pattern);
    expect('const clamp = (v: number) => v;').toMatch(pattern);
    expect('const x = clamp(1, 0, 2);').not.toMatch(pattern);
    expect('function clampAdjustment(v: unknown) {}').not.toMatch(pattern);
  });
});

describe('a UUID is recognised by isUuid', () => {
  /** The whole-string UUID pattern; an id embedded in a longer pattern is not it. */
  const UUID_LITERAL =
    /\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-[^/\n]*\[0-9a-f\]\{12\}\$\/i?/g;
  const HOME = '/src/lib/uuid.ts';

  it('has no second whole-string UUID pattern', () => {
    const offenders: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (path === HOME) continue;
      const content = withoutComments(raw);
      for (const match of content.matchAll(UUID_LITERAL)) {
        offenders.push(`${path}:${lineOf(content, match.index)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still finds the pattern in its home, so the scan is not vacuous', () => {
    expect(withoutComments(sources[HOME])).toMatch(UUID_LITERAL);
  });
});

describe('a component does not declare its own formatCurrency', () => {
  /** The two modules whose job is to BE the currency formatter. */
  const FORMATTER_MODULES = new Set([
    '/src/hooks/useNumberFormat.ts',
    '/src/lib/format.ts',
  ]);

  it('has no local formatCurrency outside the formatter modules', () => {
    const offenders: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (FORMATTER_MODULES.has(path)) continue;
      const content = withoutComments(raw);
      for (const match of content.matchAll(declarationOf('formatCurrency'))) {
        offenders.push(`${path}:${lineOf(content, match.index)}`);
      }
    }

    // Destructure `formatCurrency` from `useNumberFormat()` and call it. A
    // wrapper that binds a currency or renders null as a dash is named for what
    // it does (`formatValue`, `formatMoney`, `formatInAccountCurrency`), and an
    // ISO code beside a foreign amount is `withCurrencyCode` from `@/lib/format`.
    expect(offenders).toEqual([]);
  });

  it('still finds the hook declaring it, so the exemption is not vacuous', () => {
    expect(
      withoutComments(sources['/src/hooks/useNumberFormat.ts']),
    ).toMatch(declarationOf('formatCurrency'));
  });
});
