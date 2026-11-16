import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { FavouriteSecurities } from './FavouriteSecurities';
import { FavouriteSecurityQuote } from '@/types/investment';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyPrecise: (n: number) => {
        const abs = Math.abs(n);
        let digits = 2;
        if (n !== 0 && abs < 0.005) {
          const exp = Math.floor(Math.log10(abs));
          digits = Math.min(6, Math.max(2, -exp + 2));
        }
        return `$${n.toFixed(digits)}`;
      },
      formatPercent: (n: number) => `${n.toFixed(2)}%`,
    }),
  };
});
// The caption prints a date through the user's own format; what matters here is
// that it prints the session, not which arrangement of digits it chose.
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDateWithoutYear: (value: string) => `on ${value}`,
  }),
}));
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: any) => selector({ preferences: { defaultCurrency: 'USD' } }),
}));

const quote = (overrides: Partial<FavouriteSecurityQuote> = {}): FavouriteSecurityQuote => ({
  securityId: '1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  currencyCode: 'USD',
  currentPrice: 180,
  previousPrice: 174.5,
  dailyChange: 5.5,
  dailyChangePercent: 3.15,
  priceDate: '2026-02-09',
  ...overrides,
});

describe('FavouriteSecurities', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading skeleton with title', () => {
    render(<FavouriteSecurities securities={[]} isLoading={true} />);
    expect(screen.getByText('Favourite Securities')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state with a link to the Securities page', () => {
    render(<FavouriteSecurities securities={[]} isLoading={false} />);
    expect(screen.getByText(/No favourite securities yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Securities page'));
    expect(mockPush).toHaveBeenCalledWith('/securities');
  });

  it('renders favourites with symbol, name, and price', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('$180.00')).toBeInTheDocument();
  });

  it('expands precision for sub-penny securities instead of showing 0.00', () => {
    render(
      <FavouriteSecurities
        securities={[
          quote({ symbol: 'PENNY', name: 'Sub-penny Co', currencyCode: 'GBP', currentPrice: 0.000318, dailyChange: 0.000033, dailyChangePercent: 11.4 }),
        ]}
        isLoading={false}
      />,
    );
    // Price and change reveal their real figures rather than collapsing to 0.00.
    expect(screen.getByText(/0\.000318/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$0\.000033 \(\+11\.40%\)/)).toBeInTheDocument();
  });

  it('shows positive change in green with a plus sign', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    const changeEl = screen.getByText(/\+\$5\.50/);
    expect(changeEl.className).toContain('text-green');
  });

  it('shows negative change in red', () => {
    render(
      <FavouriteSecurities
        securities={[quote({ dailyChange: -2, dailyChangePercent: -1.1 })]}
        isLoading={false}
      />,
    );
    const changeEl = screen.getByText(/\$-2\.00/);
    expect(changeEl.className).toContain('text-red');
  });

  it('shows a placeholder when the security has no price yet', () => {
    render(
      <FavouriteSecurities
        securities={[quote({ currentPrice: null, previousPrice: null, dailyChange: 0, dailyChangePercent: 0 })]}
        isLoading={false}
      />,
    );
    expect(screen.getByText('No price yet')).toBeInTheDocument();
  });

  it('appends the currency code for foreign securities', () => {
    render(
      <FavouriteSecurities
        securities={[quote({ symbol: 'BMW', currencyCode: 'EUR', currentPrice: 95 })]}
        isLoading={false}
      />,
    );
    expect(screen.getByText('$95.00 EUR')).toBeInTheDocument();
  });

  it('shows a refresh button when onRefresh is provided and calls it on click', () => {
    const onRefresh = vi.fn();
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} onRefresh={onRefresh} />);
    const refreshBtn = screen.getByTitle('Refresh prices');
    expect(refreshBtn).toBeInTheDocument();
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalled();
  });

  it('disables the refresh button while refreshing', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} onRefresh={vi.fn()} isRefreshing={true} />);
    expect(screen.getByTitle('Refresh prices')).toBeDisabled();
  });

  it('does not render a refresh button without onRefresh', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    expect(screen.queryByTitle('Refresh prices')).not.toBeInTheDocument();
  });

  it('reaches securities from the title link', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    expect(screen.getByRole('link', { name: 'Favourite Securities' })).toHaveAttribute(
      'href',
      '/securities',
    );
  });

  it('opens the price history for the clicked row, like Top Movers', () => {
    render(<FavouriteSecurities securities={[quote({ securityId: 'sec-9' })]} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /Price history for AAPL/i }));

    expect(mockPush).toHaveBeenCalledWith('/securities/sec-9?tab=prices');
  });

  it('highlights the row edge on hover, matching the Top Movers widget', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);

    const row = screen.getByRole('button', { name: /Price history for AAPL/i });
    expect(row.className).toContain('hover:border-blue-400');
    expect(row.className).toContain('dark:hover:border-blue-500');
  });

  it('captions the list with the session its changes are for', () => {
    render(
      <FavouriteSecurities
        securities={[quote({ priceDate: '2026-02-06' })]}
        isLoading={false}
      />,
    );

    expect(screen.getByText('Daily change · on 2026-02-06')).toBeInTheDocument();
  });

  it('dates a row whose market closed a session before the others', () => {
    render(
      <FavouriteSecurities
        securities={[
          quote({ priceDate: '2026-02-09' }),
          quote({ securityId: '2', symbol: 'MSFT', priceDate: '2026-02-06' }),
        ]}
        isLoading={false}
      />,
    );

    expect(screen.getByText('Daily change · on 2026-02-09')).toBeInTheDocument();
    expect(screen.getByText('as of on 2026-02-06')).toBeInTheDocument();
    expect(screen.queryByText('as of on 2026-02-09')).not.toBeInTheDocument();
  });

  it('marks the change unknown when the quote is too old to have a day in it', () => {
    // The price is the last one there is and still worth showing. What the day
    // did to it is not known, and the previous session's move printed here as
    // though it were today's is the defect this replaced. A zero would be a
    // second wrong answer: it would say the security held its price.
    render(
      <FavouriteSecurities
        securities={[
          quote({ dailyChange: null, dailyChangePercent: null, priceDate: null }),
        ]}
        isLoading={false}
      />,
    );

    expect(screen.getByText('$180.00')).toBeInTheDocument();
    expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
    expect(screen.queryByText(/0\.00%/)).not.toBeInTheDocument();
    // With no dated change on the list, the caption keeps the plain label.
    expect(screen.getByText('Daily change')).toBeInTheDocument();
  });
});
