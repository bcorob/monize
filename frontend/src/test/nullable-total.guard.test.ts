import { describe, it, expect } from 'vitest';

/**
 * Guard: a headline total the server may send as `null` is never coalesced to
 * zero (INV-DISPLAY-002, `docs/financial-calculation-contract.md` section 1).
 *
 * `totalPortfolioValue`, `netWorth`, `totalAssets`, `totalGainLoss`, a Cash
 * Flow `totals.income` and their siblings are `null` while a component is
 * unknown -- an unpriced holding, a currency with no rate -- or while the
 * request that carries them has not answered. `?? 0` and `|| 0` turn that
 * unknown into a measured zero: Cash Flow printed "Total Inflows 0.00" over
 * 5,000 CAD of income it could not finish converting, and the Geographic
 * Allocation country view a portfolio of 0.00 over a failed request. The mistake
 * is mechanical, so the durable check is a scan that fails for any occurrence,
 * including in a component that does not exist yet.
 *
 * What it cannot see: a total renamed into a local first (`const t =
 * s.netWorth; t ?? 0`), or a subtotal printed with no marker. The component
 * cases per surface hold that half.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: a test may legitimately spell the pattern it asserts on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/** Blank comment bodies, keeping line breaks, so prose naming the pattern passes. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) => before + ' '.repeat(match.length - before.length),
    );
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * A headline total, read as a property (`summary.netWorth`, `s?.totalAssets`,
 * `response.cashFlowResponse.totals.income`), followed by `?? 0` or `|| 0`.
 */
const COALESCED_TOTAL =
  /\.\s*(totalPortfolioValue|netWorth|totalAssets|totalLiabilities|totalGainLoss|totalGainLossPercent|currentNetWorth|previousNetWorth|netWorthChange|netWorthChangePercent|totals\??\.(?:income|expenses|net))\s*(?:\?\?|\|\|)\s*0(?![.\d])/g;

/**
 * Shrink-only: each entry is a known offender owned by a later task. Remove an
 * entry when its site is fixed; never add one.
 */
const BASELINE: ReadonlyArray<string> = [];

function offenders(): string[] {
  const found: string[] = [];
  for (const [path, raw] of productionSources()) {
    const source = withoutComments(raw);
    for (const match of source.matchAll(COALESCED_TOTAL)) {
      found.push(`${path}:${lineOf(source, match.index ?? 0)}: ${match[1]}`);
    }
  }
  return found.sort();
}

describe('the pattern', () => {
  it('matches a coalesced headline total', () => {
    const hits = [
      'const v = summary?.totalPortfolioValue ?? 0;',
      'const n = latest.netWorth || 0;',
      'income: response?.cashFlowResponse.totals.income ?? 0,',
      'x = r.totals?.net ?? 0',
    ].map((line) => [...line.matchAll(COALESCED_TOTAL)].length);
    expect(hits).toEqual([1, 1, 1, 1]);
  });

  it('leaves a known subtotal, a null fallback and a decimal alone', () => {
    const hits = [
      'const v = summary?.totalPortfolioValue ?? null;',
      'const k = totals.knownIncome ?? 0;',
      'const r = s.netWorth ?? 0.5;',
      '// summary.netWorth ?? 0 is the mistake',
    ].map((line) => [...withoutComments(line).matchAll(COALESCED_TOTAL)].length);
    expect(hits).toEqual([0, 0, 0, 0]);
  });
});

describe('a nullable headline total', () => {
  it('is never coalesced to zero outside the shrink-only baseline', () => {
    const unexplained = [...offenders()];
    for (const allowed of BASELINE) {
      const [file, name] = allowed.split(': ');
      const at = unexplained.findIndex(
        (entry) => entry.startsWith(`${file}:`) && entry.endsWith(`: ${name}`),
      );
      if (at !== -1) unexplained.splice(at, 1);
    }
    expect(unexplained).toEqual([]);
  });

  it('keeps no baseline entry that no longer matches (the baseline only shrinks)', () => {
    const found = offenders();
    const stale = BASELINE.filter((allowed) => {
      const [file, name] = allowed.split(': ');
      const count = BASELINE.filter((b) => b === allowed).length;
      const live = found.filter(
        (entry) => entry.startsWith(`${file}:`) && entry.endsWith(`: ${name}`),
      ).length;
      return live < count;
    });
    expect(stale).toEqual([]);
  });
});
