import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { IncompleteDataDetails } from './IncompleteDataDetails';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string | Date) => String(d) }),
}));

const causes = {
  prices: [{ key: 'sec-a', start: '2026-06-16', end: '2026-06-20' }],
  rates: [{ key: 'USD->PLN', start: '2026-06-18', end: '2026-06-18' }],
  cash: [{ key: 'acc-1', start: '2026-06-16', end: '2026-06-16' }],
};

const labels = {
  securityLabel: (id: string) => (id === 'sec-a' ? 'AGGG' : 'other'),
  accountLabel: (id: string) => (id === 'acc-1' ? 'IKE account' : 'other'),
};

describe('IncompleteDataDetails', () => {
  it('renders nothing when nothing is missing', () => {
    const { container } = render(
      <IncompleteDataDetails
        causes={{ prices: [], rates: [], cash: [] }}
        {...labels}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('names each cause with its dates, never an id', () => {
    render(<IncompleteDataDetails causes={causes} {...labels} />);

    const panel = screen.getByTestId('incomplete-data-details');
    expect(panel).toHaveTextContent('AGGG');
    expect(panel).toHaveTextContent('2026-06-16 to 2026-06-20');
    expect(panel).toHaveTextContent('USD->PLN');
    expect(panel).toHaveTextContent('IKE account');
    // A single-point run reads as one date, not a range of one.
    expect(panel).not.toHaveTextContent('2026-06-18 to 2026-06-18');
    // The reader is never shown the raw identifiers.
    expect(panel).not.toHaveTextContent('sec-a');
    expect(panel).not.toHaveTextContent('acc-1');
  });

  it('links an unpriced security to its price history', () => {
    render(<IncompleteDataDetails causes={causes} {...labels} />);

    expect(screen.getByRole('link', { name: 'AGGG' })).toHaveAttribute(
      'href',
      '/securities/sec-a?tab=prices',
    );
  });
});
