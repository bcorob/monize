import { describe, it, expect } from 'vitest';

/**
 * Every projection surface states which boundary it prices at.
 *
 * `buildLoanProjectionInput` / `resolveCurrentLoanTerms` take an OPTIONAL
 * anchor, and an omitted optional argument is indistinguishable from a
 * deliberate today-anchored projection -- which is exactly how #1247 recurred:
 * one surface was taught to re-resolve and the same decision was left
 * duplicated in the others.
 *
 * So the choice is enumerated. A surface either passes the anchor (its rows
 * are the scheduled bill's, INV-LOAN-006) or is listed below with the reason
 * it projects from today. A new call site is a decision somebody has to make,
 * and this fails until they make it.
 */
/** The repo's file-scan idiom -- Vite resolves this, no fs walk needed. */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * Surfaces that deliberately project from TODAY's balance, one period ahead.
 *
 * They answer "if you keep paying from where you stand today, when does this
 * clear" -- a question about the loan, not about the next bill -- and neither
 * prints a per-installment interest figure: `useLoanProjection` returns payoff
 * date and remaining-interest AGGREGATES, and the Debt Payoff Timeline draws a
 * payoff date per account. A surface that starts printing per-installment
 * interest belongs in BILL_ANCHORED instead, which is where the loan detail
 * page moved once its schedule table was noticed here.
 */
const TODAY_ANCHORED = new Set([
  '/src/hooks/useLoanProjection.ts',
  '/src/components/reports/DebtPayoffTimelineReport.tsx',
]);

/** Surfaces whose rows are the scheduled bill's, so they must pass an anchor. */
const BILL_ANCHORED = new Set([
  '/src/components/reports/LoanAmortizationReport.tsx',
  // Prints per-installment interest in its schedule table, so it prices the
  // same installment the report does. Left today-anchored it showed 1,000.00
  // where the report showed 992.50 for one payment -- the same figure on two
  // screens, which is the defect class this whole invariant exists for.
  '/src/components/accounts/loan-detail/LoanDetailView.tsx',
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function callSites(): string[] {
  return Object.entries(sources)
    .filter(
      ([path]) =>
        !/\.test\.tsx?$/.test(path) && path !== '/src/lib/loan-history.ts',
    )
    .filter(([, content]) =>
      /\b(buildLoanProjectionInput|resolveCurrentLoanTerms)\s*\(/.test(
        stripComments(content),
      ),
    )
    .map(([path]) => path);
}

describe('loan projection anchor', () => {
  it('blanks comments while preserving line numbers', () => {
    const stripped = stripComments('a\n// buildLoanProjectionInput(x)\nb');
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).not.toContain('buildLoanProjectionInput');
  });

  it('finds the call sites it is meant to police', () => {
    // A rename that made the scan match nothing would look like compliance.
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(sites).toEqual(
      expect.arrayContaining([...BILL_ANCHORED, ...TODAY_ANCHORED]),
    );
  });

  it('every call site has declared which boundary it prices at', () => {
    const undeclared = callSites().filter(
      (rel) => !TODAY_ANCHORED.has(rel) && !BILL_ANCHORED.has(rel),
    );
    expect(undeclared).toEqual([]);
  });

  it('a bill-anchored surface actually passes the anchor', () => {
    for (const rel of BILL_ANCHORED) {
      const source = stripComments(sources[rel]);
      // Passing it is the claim -- importing the API is not proof, which is
      // the mistake #1247's guard records. A surface may fetch the anchor
      // itself or receive it as a prop; what it may not do is call the
      // projection without it.
      expect(source).toMatch(
        /buildLoanProjectionInput\([\s\S]{0,200}?projectionAnchor/,
      );
      expect(source).toMatch(
        /resolveCurrentLoanTerms\([\s\S]{0,200}?projectionAnchor/,
      );
    }
  });

  it('the anchor reaches every bill-anchored surface from the server', () => {
    // Either the surface fetches it, or something that renders it does.
    const fetchers = Object.entries(sources).filter(
      ([path, content]) =>
        !/\.test\.tsx?$/.test(path) &&
        stripComments(content).includes('getLoanProjectionAnchor'),
    );
    expect(fetchers.length).toBeGreaterThanOrEqual(2);
  });

  it('a today-anchored surface does not quietly acquire one', () => {
    // If one of these starts passing an anchor its rows become the bill's, and
    // the list above stops describing the code.
    for (const rel of TODAY_ANCHORED) {
      const source = stripComments(sources[rel]);
      expect(source).not.toContain('projectionAnchor');
    }
  });
});
