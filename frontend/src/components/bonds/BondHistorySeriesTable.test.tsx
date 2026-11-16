import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { BondHistorySeriesTable } from './BondHistorySeriesTable';
import type { HistorySeries } from '@/types/bond';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'PLN' }) };
});

function series(code: string, from: string | null, over: Partial<HistorySeries> = {}): HistorySeries {
  return {
    seriesCode: code,
    saleWindow: from === null ? null : { from, to: from },
    firstPeriodRate: '0.0440',
    annualRate: null,
    addend: '0.0100',
    fee: '3.00',
    proceedsFloor: 'ALL_PERIODS',
    termsVersion: 2,
    termsSource: { provider: 'MF', document: 'Terms', url: 'https://example.test/terms.pdf' },
    ...over,
  };
}

const ROWS = [
  series('TOS0125', '2025-01-01'),
  series('TOS1026', '2026-10-01'),
  series('TOS0926', '2026-09-01'),
  series('TOS0000', null, { addend: null, fee: null, proceedsFloor: null }),
];

function mount(held: string[] = []) {
  return render(<BondHistorySeriesTable series={ROWS} currency="PLN" heldSeries={held} />);
}

describe('BondHistorySeriesTable', () => {
  it('groups the series by sale year with counts, newest year first', () => {
    mount();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      '20262 series',
      '20251 series',
      'Sale date unknown1 series',
    ]);
  });

  it('opens only the newest year, newest series first', () => {
    mount();
    expect(screen.getByRole('button', { name: /2026/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /2025/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('TOS0125')).not.toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      'TOS1026',
      'TOS0926',
    ]);
  });

  it('toggles a year open and closed', () => {
    mount();
    const year = screen.getByRole('button', { name: /2025/ });
    fireEvent.click(year);
    expect(year).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('TOS0125')).toBeInTheDocument();
    fireEvent.click(year);
    expect(year).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('TOS0125')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /2026/ }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows every column, hiding the minor ones on small screens', () => {
    mount();
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      'Series',
      'On sale',
      'First-period or annual rate',
      'Margin or spread',
      'Early redemption fee',
      'Proceeds floor',
      'Terms version',
      'Source',
    ]);
    expect(headers[3]).toHaveClass('hidden', 'sm:table-cell');
    expect(headers[5]).toHaveClass('hidden', 'md:table-cell');
    expect(headers[6]).toHaveClass('hidden', 'lg:table-cell');
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('TOS1026');
    expect(cells[2]).toHaveTextContent('4.4');
    expect(cells[3]).toHaveTextContent('1');
    expect(cells[4]).toHaveTextContent('3.00');
    expect(cells[6]).toHaveTextContent('2');
    const link = within(cells[7]).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.test/terms.pdf');
  });

  it('highlights a held series and badges it', () => {
    mount(['TOS0926']);
    const row = screen.getByText('TOS0926').closest('tr') as HTMLElement;
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(within(row).getByText('Held')).toBeInTheDocument();
  });
});
