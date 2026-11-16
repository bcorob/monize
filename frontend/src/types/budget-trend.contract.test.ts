import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');

const backendTypes = readFileSync(
  join(REPO_ROOT, 'backend/src/budgets/budget-reports.service.ts'),
  'utf8',
);
const frontendTypes = readFileSync(join(__dirname, 'budget.ts'), 'utf8');

/**
 * Blank out comment bodies, keeping line breaks.
 *
 * These interfaces are the place the `monthKey` rule has to be explained, and
 * the explanation must be free to name the field it replaced -- a scan that
 * reads its own documentation as a violation pressures the next author into a
 * vaguer comment, which is the opposite of the point. Same technique as
 * `lib/loan-history.guard.test.ts`.
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

function interfaceBody(source: string, name: string): string {
  const match = withoutComments(source).match(
    new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  expect(match, `${name} declaration not found`).toBeTruthy();
  return match![1];
}

/**
 * A month crosses this API as structure, never as a label.
 *
 * A server-rendered `Jan 2026` is English in all 22 locales, and -- being text
 * -- sorts alphabetically at the client: ascending gave Apr, Aug, Dec, Feb,
 * Jan. Both halves of that defect are fixed by the same move, so both halves
 * are checked: the field is `monthKey` on BOTH layers, and `month: string` is
 * gone rather than kept as an alias (two names for one value is how a consumer
 * goes on reading the English one -- recorded as a deliberate maintainer
 * decision, not an oversight).
 */
const MONTH_KEY_SHAPES: ReadonlyArray<{
  what: string;
  backend: string;
  frontend: string;
}> = [
  { what: 'overview trend points', backend: 'BudgetTrendPoint', frontend: 'BudgetTrendPoint' },
  {
    what: 'category trend points',
    backend: 'CategoryTrendPoint',
    frontend: 'CategoryTrendDataPoint',
  },
  { what: 'savings rate points', backend: 'SavingsRatePoint', frontend: 'SavingsRatePoint' },
  {
    what: 'health score history points',
    backend: 'HealthScoreHistoryPoint',
    frontend: 'HealthScoreHistoryPoint',
  },
];

describe('budget month API contract', () => {
  it.each(MONTH_KEY_SHAPES)(
    'uses the same structural YYYY-MM field for $what on both layers',
    ({ backend, frontend }) => {
      for (const body of [
        interfaceBody(backendTypes, backend),
        interfaceBody(frontendTypes, frontend),
      ]) {
        expect(body).toMatch(/monthKey:\s*string;/);
        expect(body).not.toMatch(/\bmonth:\s*string;/);
      }
    },
  );

  it('carries the key through the nested category series too', () => {
    expect(interfaceBody(backendTypes, 'CategoryTrendSeries')).toMatch(
      /data:\s*Array<\{[\s\S]*?monthKey:\s*string;/,
    );
  });

  it('has no month-labelling left in the services that build these shapes', () => {
    // The `MONTH_NAMES` array was the mechanism: an English month table in a
    // service, substringed to three letters and concatenated with the year.
    // Both budget report services that feed the shapes above are now free of
    // it, and `formatMonthKey` is what they call instead.
    for (const service of [
      'backend/src/budgets/budget-trend-reports.service.ts',
      'backend/src/budgets/budget-health-reports.service.ts',
    ]) {
      const code = withoutComments(readFileSync(join(REPO_ROOT, service), 'utf8'));
      expect(code, `${service} still holds an English month table`).not.toMatch(
        /MONTH_NAMES/,
      );
      expect(code, `${service} does not build its month key from the helper`).toMatch(
        /formatMonthKey\(/,
      );
    }
  });
});

describe('the comment stripper', () => {
  it('blanks a comment while preserving line numbers', () => {
    const stripped = withoutComments('const a = 1;\n// month: string;\nconst b = 2;');
    expect(stripped).not.toMatch(/\bmonth:\s*string;/);
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('leaves a declaration alone, so a real alias is still found', () => {
    expect(withoutComments('interface X {\n  month: string;\n}')).toMatch(
      /\bmonth:\s*string;/,
    );
  });

  it('does not mistake a URL for a comment', () => {
    expect(withoutComments("const u = 'https://x.test/a';")).toContain('//x.test');
  });
});
