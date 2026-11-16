import { describe, it, expect } from 'vitest';

/**
 * Number input is parsed in the user's locale, and that is the ONLY place a
 * number is read from typed text (`lib/number-parse.ts` -> `parseLocaleNumber`).
 *
 * The recurring mistake this scan bans is the dot-only character-class filter --
 * `value.replace(/[^0-9.-]/g, '')` before a `parseFloat` -- which silently drops
 * a comma decimal (turning a Polish "1200,99" into 120099) and, in a dot-group
 * locale, treats the group dot as a digit. `docs/frontend/forms-and-formatting.md` states the rule
 * in prose; per the repo's "prefer the rule the machine can check", this is the
 * scan that keeps it, modelled on `scheduled-effective-amount.guard.test.ts`.
 *
 * The scan covers `src/` because the mistake is mechanical and its next
 * appearance will be in a file nobody thought to test. The fix is always to go
 * through `filterNumberTyping` / `parseLocaleNumber` instead.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Blank comment lines so prose that names the pattern cannot trip the scan. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

/**
 * The dot-only numeric filter fingerprint: `.replace(/[^0-9.-]/ ...` -- a class
 * of digits, dot and minus with NO comma. This is deliberately distinct from
 * `number-parse.ts`'s own correct `[^0-9.,]` cleanup, which keeps the comma so
 * both separators reach `parseLocaleNumber`; that form (comma present) must not
 * match.
 */
const DOT_ONLY_FILTER = /\.replace\(\s*\/\[\^(?:0-9|\\d)\\?[.\-]\\?[.\-]\]/;

/**
 * `lib/format.ts` is the deliberate legacy home of the old en-US helpers
 * (`parseAmount`, `filterCurrencyInput`); they are not the parse path for input
 * fields any more, and the doc points contributors at `parseLocaleNumber`.
 */
const ALLOWED = new Set(['/src/lib/format.ts']);

describe('number-parse guard: no hand-rolled dot-only numeric filter', () => {
  it('matches the banned dot-only filter and not the good comma-keeping one', () => {
    // Both directions, so a scan prose can trip is also one prose can satisfy.
    expect(DOT_ONLY_FILTER.test(`x.replace(/[^0-9.-]/g, '')`)).toBe(true);
    expect(DOT_ONLY_FILTER.test(`x.replace(/[^\\d.-]/g, '')`)).toBe(true);
    expect(DOT_ONLY_FILTER.test(`raw.replace(/[^0-9.,]/g, '')`)).toBe(false);
  });

  it('has no `.replace(/[^0-9.-]/…)` outside the legacy format helpers', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !/\.test\.tsx?$/.test(path) && !ALLOWED.has(path))
      .filter(([, source]) => DOT_ONLY_FILTER.test(stripComments(source)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
