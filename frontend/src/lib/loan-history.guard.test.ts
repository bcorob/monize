import { describe, it, expect } from 'vitest';

/**
 * Guard for the rule the audit of PR #1258 turned up: in `lib/loan-history.ts`
 * an **empty list is a claim about the ledger**, not a neutral default.
 *
 * `deriveLoanPaymentHistory` reads an empty `interestTransactions` as "no
 * interest was booked against these payments, so their interest is zero" -- a
 * measured zero that reaches Interest Paid, every cumulative total, the CSV and
 * PDF exports and the projection seed. A `catch` in this module that answers
 * with `[]` (or `0`, or a bare default) turns a timeout, a 500 or a proxy error
 * into exactly that claim, and the user has no way to tell the two apart.
 *
 * So this module does not catch: every failure propagates to the caller, which
 * owns an error-and-retry state (`useReportData` in the three loan reports,
 * `failedAccountId` in `useLoanProjection`, the page-level error on the account
 * detail route). The scan is the whole rule -- there is no legitimate `catch`
 * here, so no baseline to keep.
 */
const sources = import.meta.glob('/src/lib/loan-history.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The whole tree, for the truthiness scan below. */
const allSources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** A `catch` clause, with or without a bound error, and `.catch(` on a promise. */
const CATCH = /(^|[^.\w])catch\s*(\([^)]*\))?\s*\{|\.catch\s*\(/;

/**
 * Blank out comments, keeping line numbering, so the scan reads CODE.
 *
 * The rule is about what the module does, and the docblock explaining the rule
 * necessarily quotes the banned pattern (`catch { return [] }`) to name the
 * defect it prevents. Scanning raw text made that documentation fail the guard,
 * which is the wrong pressure entirely: it would have been "fixed" by weakening
 * the comment. A scan that prose can trip is also a scan that prose can satisfy.
 *
 * Deliberately crude -- a `//` inside a string literal would be blanked too.
 * That direction is safe here: it can only hide code from the scan, and the
 * negative control below fails if the scan stops seeing a real `catch`.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

describe('loan-history.ts lets a failed lookup fail', () => {
  it('is the one module this project ships, and it contains no catch', () => {
    // Sanity: the glob resolved to the module (an empty match set would make
    // every assertion below vacuously true).
    expect(Object.keys(sources)).toEqual(['/src/lib/loan-history.ts']);
  });

  it('strips comments but still sees code', () => {
    // The stripper is load-bearing in both directions, so it is tested in both.
    const stripped = withoutComments(
      ['// catch {', '/* catch { */', 'try { x() } catch { return []; }'].join('\n'),
    );
    const lines = stripped.split('\n');
    expect(CATCH.test(lines[0])).toBe(false);
    expect(CATCH.test(lines[1])).toBe(false);
    expect(CATCH.test(lines[2])).toBe(true);
    // Line numbering must survive, or the offender report points at the wrong line.
    expect(lines).toHaveLength(3);
  });

  it('never converts a rejected fetch into an empty ledger', () => {
    const [path, content] = Object.entries(sources)[0];
    const offendingLines = withoutComments(content)
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => CATCH.test(line))
      .map(({ line, number }) => `${path}:${number}: ${line.trim()}`);

    expect(
      offendingLines,
      'A failed interest or transaction lookup must reject, not resolve to an ' +
        'empty list: an empty list is what tells deriveLoanPaymentHistory that ' +
        'these payments booked no interest. Let the rejection reach the caller ' +
        "and render its error-and-retry state instead of the loan's numbers.",
    ).toEqual([]);
  });
});

/**
 * The other half of the same rule, one layer out: a resolved rate is
 * `number | null` so that ABSENT and 0% stay distinguishable, and reading it for
 * truthiness collapses them again -- reporting an interest-free loan's recorded
 * 0% as "Not set". Five sites did it (both loan reports on screen and in their
 * PDF exports, and the summary card's Canadian effective-rate derivation), which
 * is what makes this a scan rather than five fixes.
 *
 * Only the rate. A resolved *payment* of 0 is not a payment, and
 * `resolveCurrentLoanTerms` already maps a non-positive one to null, so
 * truthiness there is correct.
 */
const RESOLVED_RATE = String.raw`(?:currentTerms\.annualRate|currentAnnualRate|terms\.annualRate)`;
/** The rate as the LEFT operand of a ternary or a logical operator. */
const AS_LEFT_OPERAND = new RegExp(
  String.raw`\b${RESOLVED_RATE}\s*(?:\?(?![?.])|&&|\|\|)`,
);
/** The rate as a whole condition, or the right operand of one, or negated. */
const AS_CONDITION = new RegExp(
  String.raw`(?:if\s*\(|&&|\|\||!)\s*${RESOLVED_RATE}\s*(?:[),;}]|$)`,
);
const readsForTruthiness = (line: string) =>
  AS_LEFT_OPERAND.test(line) || AS_CONDITION.test(line);

describe('a resolved 0% rate is a rate', () => {
  it('flags the shapes it is meant to and no others', () => {
    // The pattern is subtle enough to be wrong in both directions, and a scan
    // that quietly matches nothing is worse than no scan.
    const bad = [
      "value: currentTerms.annualRate ? `${currentTerms.annualRate}%` : notSet,",
      '{currentTerms.annualRate ? render() : fallback}',
      '    isCanadianFixed && currentAnnualRate',
      'if (currentAnnualRate) {',
      'const hidden = !currentAnnualRate;',
      'const show = ready && terms.annualRate;',
    ];
    const good = [
      'value: currentTerms.annualRate != null ? render() : notSet,',
      '    isCanadianFixed && currentAnnualRate != null',
      'const rate = currentAnnualRate ?? Number(account.interestRate);',
      'annualRate: round4(currentAnnualRate),',
      'currentAnnualRate={currentTerms.annualRate}',
      'if (currentAnnualRate == null) return null;',
    ];
    expect(bad.filter((line) => !readsForTruthiness(line))).toEqual([]);
    expect(good.filter(readsForTruthiness)).toEqual([]);
  });

  it('is never read for truthiness', () => {
    const offenders = Object.entries(allSources)
      .filter(([path]) => !/\.(test|spec)\.tsx?$/.test(path))
      .flatMap(([path, content]) =>
        content
          .split('\n')
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => readsForTruthiness(line))
          .map(({ line, number }) => `${path}:${number}: ${line.trim()}`),
      );

    expect(
      offenders,
      'A resolved annual rate is `number | null` so that "no rate recorded" and ' +
        '"0%" stay different answers. Compare it with `!= null` (or `??`), never ' +
        'for truthiness -- `0` is a rate, and an interest-free loan reads as ' +
        'unconfigured otherwise.',
    ).toEqual([]);
  });
});
