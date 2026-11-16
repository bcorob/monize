import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { PerformanceSummaryTable } from './MonteCarloPerformanceSummary';

/**
 * The phone layout of the Monte Carlo performance-summary statistics table.
 *
 * It is ONE tree restyled by CSS (mechanism A): below `sm` each statistic row
 * wraps into a two-track grid card and the (non-sortable) column header row is
 * simply block-hidden, from `sm` up it is the ordinary six-column table. jsdom
 * applies no media queries, so the header row and every phone caption are in the
 * DOM here at all times. This is a pure render helper -- it takes its
 * `NumberFormatters` as a prop and calls no hook, so the formatters are a stub.
 */

const band = (p: number) => ({ p10: p, p25: p, p50: p, p75: p, p90: p });
const summary: never = {
  twrNominal: band(0.05),
  twrReal: band(0.03),
  endBalanceNominal: band(100000),
  endBalanceReal: band(80000),
  meanReturnNominal: band(0.06),
  annualizedVolatility: band(0.15),
  maxDrawdown: band(-0.2),
  maxDrawdownExcludingCashflows: band(-0.18),
  safeWithdrawalRate: band(0.04),
  perpetualWithdrawalRate: band(0.035),
} as never;

const fmt = (v: number) => `$${v.toFixed(0)}`;
const fmts = {
  formatCurrency: fmt,
  formatNumber: (v: number, d = 2) => v.toFixed(d),
  formatPercent: (v: number, d = 2) => `${v.toFixed(d)}%`,
} as never;

function renderTable() {
  return render(<PerformanceSummaryTable summary={summary} formatters={fmts} />);
}

const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${row}`;
};

describe('MonteCarloPerformanceSummary (phone wrapped)', () => {
  it('keeps a table from sm up and a grid below it, with the semantics a restyle strips', () => {
    const { container } = renderTable();

    const table = container.querySelector('table')!;
    expect(table.getAttribute('role')).toBe('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('thead')?.className).toContain('hidden');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    for (const group of container.querySelectorAll('thead, tbody')) {
      expect(group.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of container.querySelectorAll('tbody tr')) {
      expect(row.getAttribute('role')).toBe('row');
      expect(row.className).toContain('grid grid-cols-2');
      expect(row.className).toContain('sm:table-row');
    }
    for (const cell of container.querySelectorAll('td')) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    for (const th of container.querySelectorAll('th')) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('places every cell on the phone grid explicitly, label spanning the top line', () => {
    const { container } = renderTable();
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      const [label, p10, p25, p50, p75, p90] = Array.from(row.querySelectorAll('td'));
      expect(placement(label)).toBe('c1/r1');
      expect(label.className).toContain('col-span-2');
      expect(placement(p10)).toBe('c1/r2');
      expect(placement(p25)).toBe('c2/r2');
      expect(placement(p50)).toBe('c1/r3');
      expect(placement(p75)).toBe('c2/r3');
      expect(placement(p90)).toBe('c1/r4');
      for (const cell of [label, p10, p25, p50, p75, p90]) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
    }
  });

  it('captions each percentile value, and leaves the statistic label self-naming', () => {
    const { container } = renderTable();
    const row = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('$100000'),
    )!;
    expect(row.textContent).toContain('10th Percentile' + '$100000');
    expect(row.textContent).toContain('50th Percentile' + '$100000');
    // The label is the row identity (with its info tooltip, which is icon-only),
    // so it carries no CellLabel caption -- its text is just the statistic name.
    const label = row.querySelector('.col-start-1.row-start-1')!;
    expect(label.textContent?.startsWith('Portfolio End Balance (nominal)')).toBe(true);
    expect(label.querySelector('[class*="text-[10px]"]')).toBeNull();
  });

  it('carries the 50th-percentile highlight into the phone card', () => {
    const { container } = renderTable();
    const row = container.querySelector('tbody tr')!;
    const median = row.querySelector('.col-start-1.row-start-3')!;
    expect(median.className).toContain('bg-blue-50');
    expect(median.className).toContain('font-semibold');
  });

  it('never wraps a value and gives each caption whitespace-normal back', () => {
    const { container } = renderTable();
    for (const row of container.querySelectorAll('tbody tr')) {
      const figures = Array.from(row.querySelectorAll('td')).filter(
        (c) => c.className.includes('whitespace-nowrap') && c.className.includes('text-right'),
      );
      // The five percentile values.
      expect(figures).toHaveLength(5);
      for (const cell of figures) {
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
    }
  });
});
