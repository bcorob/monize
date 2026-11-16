import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { ResultsTable } from './MonteCarloResultsTable';

/**
 * The phone layout of the Monte Carlo year-by-year results table.
 *
 * It is ONE tree restyled by CSS (mechanism A): below `sm` each row wraps into a
 * two-track grid card and the (non-sortable) column header row is simply
 * block-hidden, from `sm` up it is the ordinary seven-column table. jsdom
 * applies no media queries, so the header row and every phone caption are in the
 * DOM here at all times -- which is what lets these assertions read the phone
 * markup without emulating a viewport.
 */

const fmt = (v: number) => `$${v.toFixed(0)}`;

function renderTable() {
  return render(
    <ResultsTable
      formatCurrency={fmt}
      rows={[
        { year: '2025', p10: 100, p25: 200, p50: 300, p75: 400, p90: 500, events: [] },
        {
          year: '2030',
          p10: 1000,
          p25: 2000,
          p50: 3000,
          p75: 4000,
          p90: 5000,
          events: [
            { role: 'start', income: true, name: 'Bonus', amount: 1000, flowType: 'ONE_TIME', startYear: 2030, inflationAdjust: false } as never,
          ],
        },
      ]}
    />,
  );
}

const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${row}`;
};

describe('MonteCarloResultsTable (phone wrapped)', () => {
  it('keeps a table from sm up and a grid below it, with the semantics a restyle strips', () => {
    const { container } = renderTable();

    const table = container.querySelector('table')!;
    expect(table.getAttribute('role')).toBe('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
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
    // The wrapper still scrolls horizontally, which is what the table needs from
    // `sm` up on a narrow desktop window.
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('block-hides the single non-sortable header row below sm', () => {
    const { container } = renderTable();
    const headRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headRows).toHaveLength(1);
    expect(container.querySelector('thead')?.className).toContain('hidden');
    // Seven column headers in desktop column order.
    expect(
      Array.from(headRows[0].querySelectorAll('th')).map((th) => th.textContent),
    ).toEqual(['Year', '10th', '25th', 'Median', '75th', '90th', 'Events']);
  });

  it('places every cell on the phone grid explicitly, median beside its year', () => {
    const { container } = renderTable();
    for (const row of container.querySelectorAll('tbody tr')) {
      const [year, p10, p25, median, p75, p90, events] = Array.from(row.querySelectorAll('td'));
      expect(placement(year)).toBe('c1/r1');
      expect(placement(p10)).toBe('c1/r2');
      expect(placement(p25)).toBe('c2/r2');
      expect(placement(median)).toBe('c2/r1');
      expect(placement(p75)).toBe('c1/r3');
      expect(placement(p90)).toBe('c2/r3');
      expect(placement(events)).toBe('c1/r4');
      // Explicit placement, never auto-flow.
      for (const cell of [year, p10, p25, median, p75, p90, events]) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
    }
  });

  it('captions every money figure with its column key, and leaves the year self-naming', () => {
    const { container } = renderTable();
    const row = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('$300'),
    )!;
    expect(row.textContent).toContain('10th' + '$100');
    expect(row.textContent).toContain('25th' + '$200');
    expect(row.textContent).toContain('Median' + '$300');
    expect(row.textContent).toContain('75th' + '$400');
    expect(row.textContent).toContain('90th' + '$500');
    // The year is the row identity, so it carries no caption.
    const year = row.querySelector('.col-start-1.row-start-1')!;
    expect(year.textContent).toBe('2025');
    expect(year.querySelector('span')).toBeNull();
  });

  it('never wraps a money figure and gives each caption whitespace-normal back', () => {
    const { container } = renderTable();
    for (const row of container.querySelectorAll('tbody tr')) {
      const figures = Array.from(row.querySelectorAll('td')).filter(
        (c) => c.className.includes('whitespace-nowrap') && c.className.includes('text-right'),
      );
      // The five percentile figures.
      expect(figures).toHaveLength(5);
      for (const cell of figures) {
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
    }
  });
});
