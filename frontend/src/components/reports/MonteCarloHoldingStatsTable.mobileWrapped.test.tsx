import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { HoldingStatsTable } from './MonteCarloHoldingStatsTable';

/**
 * The phone layout of the Monte Carlo per-account holding-stats table.
 *
 * It is ONE tree restyled by CSS (mechanism A): below `sm` each holding row
 * wraps into a two-track grid card and the (non-sortable) column header row is
 * simply block-hidden, from `sm` up it is the ordinary five-column table. jsdom
 * applies no media queries, so the header row, the security name (which today
 * hides below `sm`) and every phone caption are in the DOM here at all times.
 * This is a pure render helper -- it takes its `NumberFormatters` as a prop and
 * calls no hook, so the formatters are a plain stub.
 */

const fmt = (v: number, currencyCode?: string) => `${v.toFixed(0)} ${currencyCode ?? 'DEFAULT'}`;
const fmts = {
  formatCurrency: fmt,
  formatNumber: (v: number, d = 2) => v.toFixed(d),
  formatPercent: (v: number, d = 2) => `${v.toFixed(d)}%`,
} as never;

function renderTable() {
  return render(
    <HoldingStatsTable
      loading={false}
      formatters={fmts}
      data={[
        {
          accountId: 'a',
          accountName: 'Brokerage',
          currencyCode: 'USD',
          holdings: [
            { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD', marketValue: 1000, meanReturn: 0.12, volatility: 0.2 },
            { symbol: 'NULLY', name: 'No Stats', currencyCode: 'USD', marketValue: 500, meanReturn: null, volatility: null },
          ],
        },
      ] as never}
    />,
  );
}

const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${row}`;
};

describe('MonteCarloHoldingStatsTable (phone wrapped)', () => {
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

  it('places every cell on the phone grid explicitly, value beside the symbol', () => {
    const { container } = renderTable();
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const [symbol, name, value, mean, vol] = Array.from(row.querySelectorAll('td'));
      expect(placement(symbol)).toBe('c1/r1');
      expect(placement(name)).toBe('c1/r2');
      expect(placement(value)).toBe('c2/r1');
      expect(placement(mean)).toBe('c1/r3');
      expect(placement(vol)).toBe('c2/r3');
      // The name spans both tracks; it is the descriptor under the symbol.
      expect(name.className).toContain('col-span-2');
      for (const cell of [symbol, name, value, mean, vol]) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
    }
  });

  it('shows the name on a phone (wrapping) and keeps its desktop truncate from sm up', () => {
    const { container } = renderTable();
    const row = container.querySelector('tbody tr')!;
    const name = row.querySelector('.col-start-1.row-start-2')!;
    expect(name.textContent).toBe('Apple Inc.');
    expect(name.className).toContain('break-words');
    expect(name.className).toContain('sm:truncate');
    expect(name.className).toContain('sm:max-w-[200px]');
  });

  it('captions each figure with its column key, and leaves the symbol and name self-naming', () => {
    const { container } = renderTable();
    const row = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('1000 USD'),
    )!;
    expect(row.textContent).toContain('Value' + '1000 USD');
    expect(row.textContent).toContain('Mean' + '12.00%');
    expect(row.textContent).toContain('Volatility' + '20.00%');
    // Symbol is the identity and the name is its descriptor: neither is captioned.
    const symbol = row.querySelector('.col-start-1.row-start-1')!;
    expect(symbol.textContent).toBe('AAPL');
    expect(symbol.querySelector('span')).toBeNull();
    const name = row.querySelector('.col-start-1.row-start-2')!;
    expect(name.querySelector('span')).toBeNull();
  });

  it('never wraps a figure and gives each caption whitespace-normal back', () => {
    const { container } = renderTable();
    for (const row of container.querySelectorAll('tbody tr')) {
      const figures = Array.from(row.querySelectorAll('td')).filter(
        (c) => c.className.includes('whitespace-nowrap') && c.className.includes('text-right'),
      );
      // Value, mean and volatility.
      expect(figures).toHaveLength(3);
      for (const cell of figures) {
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
    }
  });
});
