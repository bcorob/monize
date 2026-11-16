import { describe, it, expect } from 'vitest';

/**
 * Guard: a partial-total marker is drawn by `PartialTotal`, and nowhere else.
 *
 * `components/ui/PartialTotal.tsx` renders three things together -- the amber
 * symbol, an `sr-only` suffix, and a tooltip naming the currencies that were
 * left out. A component that writes the symbol itself gets the first and drops
 * the other two, and the drop is invisible on screen: three reports shipped
 *
 *   <span className="text-amber-600 ..." aria-hidden="true"> *</span>
 *
 * beside figures that DID go through `PartialTotal`, so a sighted reader saw
 * one marker per subtotal while a screen-reader user was told the derived
 * figure -- the utilisation ratio, the portfolio yield -- was complete. An
 * `aria-hidden` marker with no accessible twin is not a weaker signal than the
 * component's; it is no signal at all.
 *
 * Scanning for the shape rather than asserting on three components is
 * deliberate: the mistake is mechanical (a marker is four tokens of JSX, and
 * writing them is quicker than importing the component), so the durable
 * mechanism is one that fails for ANY occurrence, including in a report that
 * does not exist yet. `docs/verification-contract.md` ranks it above a
 * per-component assertion for exactly this reason.
 *
 * What this scan cannot see, stated so the next reader does not over-trust it:
 * a figure printed with NO marker at all when its inputs were partial. That is
 * a question about which values a component derived from which aggregate, which
 * no textual scan can answer -- the per-report assertions in
 * `CreditUtilizationReport.mobileWrapped.test.tsx` and
 * `GeographicAllocationReport.mobileWrapped.test.tsx` cover that half, one
 * surface at a time.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: a test may legitimately spell the pattern it asserts on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

/**
 * Blank out comment bodies, keeping line breaks so reported line numbers still
 * point at the source. The prose above has to show the banned JSX to explain
 * why it is banned, and a scan that reads its own explanation as a violation is
 * worse than no scan -- the cheap way out of it is a weaker comment. Same
 * technique as `lib/loan-history.guard.test.ts`.
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

/** 1-indexed line number of a character offset, for an offender report. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * A JSX element that is hidden from assistive technology and whose whole text
 * is an asterisk: the partial marker, hand-written. The element name is not
 * pinned (a `<sup>` would be the same mistake) and neither is attribute order.
 */
const HAND_ROLLED_MARKER =
  /<(\w+)(?=[^>]*\baria-hidden\b)[^>]*>\s*\{?\s*['"`]?\s*\*\s*['"`]?\s*\}?\s*<\/\1>/g;

/** The one module allowed to draw it. */
const MARKER_OWNER = '/src/components/ui/PartialTotal.tsx';

describe('the comment stripper', () => {
  it('blanks a comment while preserving line numbers', () => {
    const stripped = withoutComments(
      'const a = 1;\n// <span aria-hidden="true"> * </span>\nconst b = 2;',
    );
    expect(stripped).not.toContain('aria-hidden');
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('leaves code alone, so a real offender is still found', () => {
    const stripped = withoutComments('<span aria-hidden="true"> * </span>');
    expect(stripped).toMatch(HAND_ROLLED_MARKER);
  });

  it('does not mistake a URL for a comment', () => {
    expect(withoutComments("const u = 'https://x.test/a';")).toContain('//x.test');
  });
});

describe('the marker pattern', () => {
  it('matches the shape three reports actually shipped', () => {
    expect(
      '<span className="text-amber-600 dark:text-amber-400" aria-hidden="true"> *</span>',
    ).toMatch(HAND_ROLLED_MARKER);
  });

  it('matches it whatever the element and however the asterisk is written', () => {
    for (const shipped of [
      '<sup aria-hidden="true">*</sup>',
      '<span aria-hidden={true} className="x">{\' *\'}</span>',
    ]) {
      expect(shipped).toMatch(HAND_ROLLED_MARKER);
    }
  });

  it('leaves an accessible marker and an unrelated hidden glyph alone', () => {
    for (const innocent of [
      '<span className="sr-only">{t(\'partialTotal.srSuffix\')}</span>',
      '<ChevronDownIcon aria-hidden="true" className="h-4 w-4" />',
      '<span aria-hidden="true">{formatPercent(value, 1)}</span>',
    ]) {
      expect(innocent).not.toMatch(HAND_ROLLED_MARKER);
    }
  });
});

describe('every partial-total marker comes from PartialTotal', () => {
  it('has no component drawing an aria-hidden asterisk of its own', () => {
    const offenders: string[] = [];

    for (const [path, content] of productionSources()) {
      if (path === MARKER_OWNER) continue;
      const code = withoutComments(content);
      for (const match of code.matchAll(HAND_ROLLED_MARKER)) {
        offenders.push(`${path}:${lineOf(code, match.index)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still finds the marker in the module that owns it', () => {
    // Positive proof the scan is looking at real content and would fire: the
    // one sanctioned marker is written exactly this way, so an empty offender
    // list above means the pattern found nothing, not that it matches nothing.
    expect(withoutComments(sources[MARKER_OWNER])).toMatch(HAND_ROLLED_MARKER);
  });
});
