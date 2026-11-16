import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { DailyMovementDialog } from './DailyMovementDialog';
import calendarNs from '@/i18n/messages/en/calendar.json';
import commonNs from '@/i18n/messages/en/common.json';
import type {
  DailyMovementDetailResponse,
  SecurityDayMove,
} from '@/types/investment';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatPercent: (n: number) => `${n.toFixed(2)}%`,
      formatNumber: (n: number, d = 2) => n.toFixed(d),
      formatShareQuantity: (n: number) => String(n),
      defaultCurrency: 'CAD',
    }),
  };
});

const mockGetDailyMovementDetail = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getDailyMovementDetail: (...args: unknown[]) => mockGetDailyMovementDetail(...args),
  },
}));

function move(overrides: Partial<SecurityDayMove> = {}): SecurityDayMove {
  return {
    securityId: 'sec-abc',
    symbol: 'ABC',
    name: 'ABC Corp',
    currencyCode: 'CAD',
    quantity: 100,
    close: 52,
    previousClose: 50,
    previousCloseDate: '2026-09-10',
    priceChange: 2,
    changePercent: 4,
    change: 200,
    ...overrides,
  };
}

/** Example 3: a deposit and a trade on the same day, and the popup reconciles. */
function detail(
  overrides: Partial<DailyMovementDetailResponse> = {},
): DailyMovementDetailResponse {
  return {
    date: '2026-09-11',
    currencyCode: 'CAD',
    movement: 200,
    movementPercent: 0.2,
    complete: true,
    reasons: [],
    gains: [move()],
    losses: [
      move({
        securityId: 'sec-xyz',
        symbol: 'XYZ',
        name: 'XYZ Inc',
        quantity: 40,
        close: 24.5,
        previousClose: 25,
        priceChange: -0.5,
        changePercent: -2,
        change: -20,
      }),
    ],
    unchangedCount: 1,
    remainder: 20,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDailyMovementDetail.mockResolvedValue(detail());
});

describe('DailyMovementDialog', () => {
  it('asks nothing while it is closed', async () => {
    render(
      <DailyMovementDialog date={null} accountIds={['brokerage-1']} onClose={vi.fn()} />,
    );

    await waitFor(() => expect(mockGetDailyMovementDetail).not.toHaveBeenCalled());
  });

  it('breaks the day down into gains, losses, unchanged and the remainder (example 3)', async () => {
    render(
      <DailyMovementDialog
        date="2026-09-11"
        accountIds={['brokerage-1']}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('movement-headline')).toHaveTextContent('$200.00');
    expect(screen.getByTestId('movement-headline')).toHaveTextContent('0.20%');

    expect(screen.getByText(calendarNs.change.gains)).toBeInTheDocument();
    expect(screen.getByText(calendarNs.change.losses)).toBeInTheDocument();

    expect(screen.getByText('ABC')).toBeInTheDocument();
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    expect(screen.getByText('XYZ')).toBeInTheDocument();
    expect(screen.getByText('$-20.00')).toBeInTheDocument();
    expect(screen.getByText('1 security closed unchanged.')).toBeInTheDocument();
    // 200 - (200 - 20) = 20: the dividend cash the rows do not explain.
    expect(screen.getByText(calendarNs.change.remainder).parentElement).toHaveTextContent(
      '$20.00',
    );
  });

  it('shows a row whose rate is missing as unknown and withholds the remainder (table D)', async () => {
    mockGetDailyMovementDetail.mockResolvedValue(
      detail({
        complete: false,
        movement: null,
        movementPercent: null,
        reasons: ['missingRate'],
        gains: [move({ change: null })],
        losses: [],
        remainder: null,
      }),
    );

    render(
      <DailyMovementDialog
        date="2026-09-11"
        accountIds={['brokerage-1']}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getAllByTestId('unknown-amount').length).toBe(3));
    expect(screen.getByText(calendarNs.change.reasons.missingRate)).toBeInTheDocument();
    expect(screen.queryByTestId('movement-headline')).not.toBeInTheDocument();
    // The headline and the remainder name the rate, not a price: the dialog
    // reads the same mapping the cell's marker does.
    expect(
      screen.getAllByRole('button', { name: commonNs.unknownAmount.displayFx }).length,
    ).toBe(3);
    expect(
      screen.queryByRole('button', { name: commonNs.unknownAmount.noPrice }),
    ).toBeNull();
  });

  it('keeps the order the server sent the rows in', async () => {
    mockGetDailyMovementDetail.mockResolvedValue(
      detail({
        gains: [
          move({ securityId: 'a', symbol: 'AAA', change: 50 }),
          move({ securityId: 'b', symbol: 'BBB', change: 150 }),
        ],
      }),
    );

    render(
      <DailyMovementDialog
        date="2026-09-11"
        accountIds={['brokerage-1']}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText('AAA');
    const symbols = screen.getAllByText(/^(AAA|BBB)$/).map((node) => node.textContent);
    expect(symbols).toEqual(['AAA', 'BBB']);
  });

  it('renders a retryable failure, never an empty breakdown', async () => {
    mockGetDailyMovementDetail.mockRejectedValue(new Error('offline'));

    render(
      <DailyMovementDialog
        date="2026-09-11"
        accountIds={['brokerage-1']}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(calendarNs.errors.movementDetailFailed),
    ).toBeInTheDocument();
  });

  it('does not adopt a response for a day the reader has left', async () => {
    let resolveFirst: ((value: DailyMovementDetailResponse) => void) | undefined;
    mockGetDailyMovementDetail.mockImplementationOnce(
      () =>
        new Promise<DailyMovementDetailResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mockGetDailyMovementDetail.mockResolvedValue(
      detail({ date: '2026-09-14', gains: [move({ symbol: 'LATER' })], losses: [] }),
    );

    const { rerender } = render(
      <DailyMovementDialog
        date="2026-09-11"
        accountIds={['brokerage-1']}
        onClose={vi.fn()}
      />,
    );

    rerender(
      <DailyMovementDialog
        date="2026-09-14"
        accountIds={['brokerage-1']}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('LATER')).toBeInTheDocument();

    resolveFirst?.(detail());
    await waitFor(() => expect(screen.queryByText('ABC')).not.toBeInTheDocument());
  });
});
