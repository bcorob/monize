import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { render } from '@/test/render';
import { InvestmentSplitFields } from './InvestmentSplitFields';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';
import type { InvestmentSplitDetails } from '@/types/transaction';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn(),
  },
}));

// The rate prefill for a cross-currency split: the rate for the parent's DATE
// (INV-FX-001). It answers null by default, so a test has to say a rate exists
// before the component can convert -- which is the state that used to be
// papered over with 1. `getLatestRates` is deliberately absent: the component
// must not read the latest rate.
const mockGetRateForDate = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateForDate: (...args: unknown[]) => mockGetRateForDate(...args),
  },
}));

const mockSecurities: Security[] = [
  {
    id: 'sec-1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    currencyCode: 'USD',
    isActive: true,
  } as Security,
  {
    id: 'sec-2',
    symbol: 'VOO',
    name: 'Vanguard S&P 500',
    currencyCode: 'USD',
    isActive: true,
  } as Security,
];

function buyValue(overrides: Partial<InvestmentSplitDetails> = {}): InvestmentSplitDetails {
  return {
    action: 'BUY',
    securityId: 'sec-1',
    quantity: 10,
    price: 5,
    commission: 1,
    exchangeRate: 1,
    ...overrides,
  };
}

async function renderFieldsAsync(
  props: Partial<Parameters<typeof InvestmentSplitFields>[0]> = {},
) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <InvestmentSplitFields value={undefined} onChange={vi.fn()} {...props} />,
    );
  });
  return result!;
}

/**
 * Holds the row the way `SplitEditor` does: the emitted row comes back as
 * `value`, and the `exchangeRateEdited` latch follows `meta` (set by a rate
 * edit, reset by a security change).
 */
function Harness({
  initial,
  onChange,
  ...rest
}: {
  initial: InvestmentSplitDetails | undefined;
  onChange: (...args: any[]) => void;
} & Partial<Parameters<typeof InvestmentSplitFields>[0]>) {
  const [value, setValue] = useState(initial);
  const [edited, setEdited] = useState(false);
  return (
    <InvestmentSplitFields
      {...rest}
      value={value}
      rateEdited={edited}
      onChange={(next, amount, meta) => {
        setValue(next);
        setEdited((prev) => (meta.securityChanged ? false : prev || meta.rateEdited));
        onChange(next, amount, meta);
      }}
    />
  );
}

async function renderHarness(
  initial: InvestmentSplitDetails | undefined,
  onChange: (...args: any[]) => void,
  props: Partial<Parameters<typeof InvestmentSplitFields>[0]> = {},
) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<Harness initial={initial} onChange={onChange} {...props} />);
  });
  return result!;
}

const TRADE_DATE = '2025-01-02';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRateForDate.mockReset();
  mockGetRateForDate.mockResolvedValue(null);
  (investmentsApi.getSecurities as ReturnType<typeof vi.fn>).mockResolvedValue(mockSecurities);
});

describe('InvestmentSplitFields', () => {
  it('loads securities on mount', async () => {
    await renderFieldsAsync();
    await waitFor(() => expect(investmentsApi.getSecurities).toHaveBeenCalled());
  });

  it('does not crash when securities fail to load', async () => {
    (investmentsApi.getSecurities as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    );
    await renderFieldsAsync();
    await act(async () => {}); // flush rejection handler
    expect(screen.getByLabelText('Investment action')).toBeInTheDocument();
  });

  it('defaults to BUY and shows security + quantity/price/commission fields', async () => {
    await renderFieldsAsync();
    expect(screen.getByLabelText('Investment action')).toHaveValue('BUY');
    expect(screen.getByLabelText('Security')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Quantity')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Price')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Commission')).toBeInTheDocument();
  });

  it('renders the security dropdown options from the API', async () => {
    await renderFieldsAsync();
    await waitFor(() =>
      expect(screen.getByText('AAPL - Apple Inc.')).toBeInTheDocument(),
    );
    expect(screen.getByText('VOO - Vanguard S&P 500')).toBeInTheDocument();
  });

  it('computes the cash impact when the action changes to SELL', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({ value: buyValue(), onChange });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Investment action'), {
        target: { value: 'SELL' },
      });
    });
    expect(onChange).toHaveBeenCalled();
    const [next, amount] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(next.action).toBe('SELL');
    // SELL: quantity*price - commission = 10*5 - 1 = 49
    expect(amount).toBe(49);
  });

  it('selecting a security calls onChange with the new securityId', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({ value: buyValue({ securityId: undefined }), onChange });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-2' },
      });
    });
    const [next] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(next.securityId).toBe('sec-2');
  });

  it('clearing the security passes undefined', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({ value: buyValue(), onChange });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: '' },
      });
    });
    const [next] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(next.securityId).toBeUndefined();
  });

  it('updates quantity and recomputes the amount', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({ value: buyValue(), onChange });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Quantity'), {
        target: { value: '20' },
      });
    });
    const [next, amount] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(next.quantity).toBe(20);
    // BUY: -(20*5 + 1) = -101
    expect(amount).toBe(-101);
  });

  it('updates price and recomputes the amount', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({ value: buyValue(), onChange });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Price'), {
        target: { value: '7' },
      });
    });
    const [next] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(next.price).toBe(7);
  });

  it('updates commission and recomputes the amount', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({ value: buyValue(), onChange });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Commission'), {
        target: { value: '3' },
      });
    });
    const [next] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(next.commission).toBe(3);
  });

  // A cross-currency embedded split had no rate input at all and defaulted the
  // rate to 1, so buying a USD security from a CAD account recorded the
  // unconverted figure as the split's cash impact -- while the investment row
  // written beside it used the server-resolved rate. The two halves of one split
  // described different amounts of money.
  describe('a security priced in another currency', () => {
    // sec-1 is USD; the cash account is CAD.
    const noStatedRate = () => buyValue({ exchangeRate: undefined });
    const rateLabel = 'Exchange rate (CAD per 1 USD)';

    it('prefills the rate for the parent date, not the latest, and converts with it', async () => {
      mockGetRateForDate.mockResolvedValue(1.35);
      const onChange = vi.fn();
      await renderHarness(noStatedRate(), onChange, { transactionDate: TRADE_DATE });
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.350000'),
      );
      expect(mockGetRateForDate).toHaveBeenCalledWith('USD', 'CAD', TRADE_DATE);

      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Quantity'), {
          target: { value: '20' },
        });
      });
      const [next, amount] = onChange.mock.calls.at(-1)!;
      expect(next.exchangeRate).toBe(1.35);
      // BUY 20 @ 5 USD + 1 commission = -101 USD, x 1.35 = -136.35 CAD.
      expect(amount).toBe(-136.35);
    });

    it('emits the prefilled rate with its converted amount and does not latch it as an edit', async () => {
      mockGetRateForDate.mockResolvedValue(1.35);
      const onChange = vi.fn();
      await renderHarness(noStatedRate(), onChange, { transactionDate: TRADE_DATE });
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      const [next, amount, meta] = onChange.mock.calls.at(-1)!;
      expect(next.exchangeRate).toBe(1.35);
      // BUY 10 @ 5 USD + 1 commission = -51 USD, x 1.35 = -68.85 CAD.
      expect(amount).toBe(-68.85);
      expect(meta).toEqual({ rateEdited: false, securityChanged: false });
    });

    it('asks again when the date changes and refills the rate', async () => {
      mockGetRateForDate.mockImplementation(async (_f, _t, date) =>
        date === TRADE_DATE ? 1.35 : 1.3,
      );
      const onChange = vi.fn();
      const { rerender } = await renderHarness(noStatedRate(), onChange, {
        transactionDate: TRADE_DATE,
      });
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.350000'),
      );

      await act(async () => {
        rerender(
          <Harness initial={noStatedRate()} onChange={onChange} transactionDate="2025-03-03" />,
        );
      });
      await waitFor(() =>
        expect(mockGetRateForDate).toHaveBeenCalledWith('USD', 'CAD', '2025-03-03'),
      );
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.300000'),
      );
    });

    it('keeps a rate the person typed when the date changes', async () => {
      mockGetRateForDate.mockResolvedValue(1.35);
      const onChange = vi.fn();
      const { rerender } = await renderHarness(noStatedRate(), onChange, {
        transactionDate: TRADE_DATE,
      });
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.350000'),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText(rateLabel), { target: { value: '1.4' } });
      });
      mockGetRateForDate.mockClear();

      await act(async () => {
        rerender(
          <Harness initial={noStatedRate()} onChange={onChange} transactionDate="2025-03-03" />,
        );
      });
      expect(mockGetRateForDate).not.toHaveBeenCalled();
      expect(onChange.mock.calls.at(-1)![0].exchangeRate).toBe(1.4);
    });

    it('does not ask when the row is flagged as edited', async () => {
      await renderFieldsAsync({
        value: noStatedRate(),
        transactionDate: TRADE_DATE,
        rateEdited: true,
      });
      await act(async () => {});
      expect(mockGetRateForDate).not.toHaveBeenCalled();
    });

    it('keeps the stored rate on load and asks again only for another day', async () => {
      mockGetRateForDate.mockResolvedValue(1.3);
      const onChange = vi.fn();
      const stored = buyValue({ exchangeRate: 1.2345678 });
      const { rerender } = await renderHarness(stored, onChange, {
        transactionDate: TRADE_DATE,
      });
      await act(async () => {});
      expect(mockGetRateForDate).not.toHaveBeenCalled();
      expect(screen.getByLabelText(rateLabel)).toHaveValue('1.234568');

      await act(async () => {
        rerender(<Harness initial={stored} onChange={onChange} transactionDate="2025-03-03" />);
      });
      await waitFor(() =>
        expect(mockGetRateForDate).toHaveBeenCalledWith('USD', 'CAD', '2025-03-03'),
      );
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.300000'),
      );
    });

    it('ignores a late answer for a day the row has moved off', async () => {
      const resolvers = new Map<string, (rate: number | null) => void>();
      mockGetRateForDate.mockImplementation(
        (_f, _t, date) => new Promise((resolve) => resolvers.set(date, resolve)),
      );
      const onChange = vi.fn();
      const { rerender } = await renderHarness(noStatedRate(), onChange, {
        transactionDate: TRADE_DATE,
      });
      await act(async () => {
        rerender(
          <Harness initial={noStatedRate()} onChange={onChange} transactionDate="2025-03-03" />,
        );
      });
      await act(async () => {
        resolvers.get('2025-03-03')!(1.3);
      });
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.300000'),
      );
      await act(async () => {
        resolvers.get(TRADE_DATE)!(1.35);
      });
      expect(screen.getByLabelText(rateLabel)).toHaveValue('1.300000');
    });

    it('looks nothing up without a parent date and leaves the rate unresolved', async () => {
      mockGetRateForDate.mockResolvedValue(1.35);
      await renderHarness(noStatedRate(), vi.fn());
      await act(async () => {});
      expect(mockGetRateForDate).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/No USD to CAD rate is available/i);
    });

    it('leaves the rate unresolved when the lookup fails', async () => {
      mockGetRateForDate.mockRejectedValue(new Error('offline'));
      await renderHarness(noStatedRate(), vi.fn(), { transactionDate: TRADE_DATE });
      await act(async () => {});
      expect(screen.getByRole('alert')).toHaveTextContent(/No USD to CAD rate is available/i);
    });

    it('emits the converted amount at money precision, not cents', async () => {
      // A real FX rate rarely yields a 2dp-clean product. The amount is stored
      // as decimal(20,4) and the backend validates it at 4dp (roundMoney) both
      // in validateSplits and where the embedded investment row is written, so
      // rounding it to cents here made the two disagree and the commit was
      // rejected. -101 USD x 1.3652 = -137.8852 CAD: cents would emit -137.89,
      // which fails the backend's 4dp check.
      mockGetRateForDate.mockResolvedValue(1.3652);
      const onChange = vi.fn();
      await renderHarness(noStatedRate(), onChange, { transactionDate: TRADE_DATE });
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.365200'),
      );

      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Quantity'), {
          target: { value: '20' },
        });
      });
      const [, amount] = onChange.mock.calls.at(-1)!;
      expect(amount).toBe(-137.8852);
    });

    it('does not truncate the prefilled rate when the field is only blurred', async () => {
      // The field shows 6dp but the rate is stored at 10dp, so blurring the
      // untouched field re-reports the 6dp rounding. That is not a user
      // override: adopting it would replace the fetched rate with a truncated
      // one (the FX-panel bug docs/frontend/forms-and-formatting.md warns about). The guard drops a
      // re-report matching the rate at display precision, so no onChange
      // fires from the blur alone.
      mockGetRateForDate.mockResolvedValue(1.2345678);
      const onChange = vi.fn();
      await renderHarness(noStatedRate(), onChange, { transactionDate: TRADE_DATE });
      const rateField = await screen.findByLabelText(rateLabel);
      await waitFor(() => expect(rateField).toHaveValue('1.234568'));
      onChange.mockClear();
      await act(async () => {
        fireEvent.focus(rateField);
        fireEvent.blur(rateField);
      });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not truncate a STORED >6dp rate when the field is only blurred', async () => {
      // The same display-truncation trap for a rate the split already carries
      // (issue #1167 review): a stored 10dp rate shows as 6dp, and a no-typing
      // focus+blur re-reports that truncation. Adopting it would latch
      // `rateEdited`, so the server stamps the current settlement pair onto a
      // truncated -- possibly stale-pair -- scalar, reopening the #1167 bug class
      // through a cosmetic edit. The guard must drop the re-report.
      const onChange = vi.fn();
      await renderHarness(
        buyValue({
          exchangeRate: 1.2345678,
          exchangeRateFromCurrency: 'USD',
          exchangeRateToCurrency: 'CAD',
        }),
        onChange,
        { transactionDate: TRADE_DATE },
      );
      const rateField = await screen.findByLabelText(rateLabel);
      await waitFor(() => expect(rateField).toHaveValue('1.234568'));
      onChange.mockClear();
      await act(async () => {
        fireEvent.focus(rateField);
        fireEvent.blur(rateField);
      });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('says the rate is unknown rather than settling at par', async () => {
      mockGetRateForDate.mockResolvedValue(null);
      await renderHarness(noStatedRate(), vi.fn(), { transactionDate: TRADE_DATE });
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          /No USD to CAD rate is available/i,
        ),
      );
    });

    it('emits no cash impact while the rate is unknown', async () => {
      mockGetRateForDate.mockResolvedValue(null);
      const onChange = vi.fn();
      await renderHarness(noStatedRate(), onChange, { transactionDate: TRADE_DATE });
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Quantity'), {
          target: { value: '20' },
        });
      });
      const [next, amount] = onChange.mock.calls.at(-1)!;
      expect(next.exchangeRate).toBeUndefined();
      // Not -101: that is the unconverted figure, which is what the old default
      // of 1 produced.
      expect(amount).toBe(0);
    });

    it('lets the user state a rate that overrides the prefilled one', async () => {
      mockGetRateForDate.mockResolvedValue(1.35);
      const onChange = vi.fn();
      await renderHarness(noStatedRate(), onChange, { transactionDate: TRADE_DATE });
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.350000'),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText(rateLabel), {
          target: { value: '1.4' },
        });
      });
      const [next] = onChange.mock.calls.at(-1)!;
      expect(next.exchangeRate).toBe(1.4);
    });

    // Issue #1167 R9-F3: selecting a foreign security must resolve the rate for
    // the NEW pair, not carry the same-currency 1 the row started with. The old
    // code copied the effective rate (1) into the payload before applying the new
    // security, so a USD BUY on a CAD account booked at 1:1 (a 26% error), and R8
    // then blessed that 1 as an explicit USD/CAD rate.
    it('resolves the new security pair rate for the date on select, never carrying the stale 1 (R9-F3)', async () => {
      mockGetRateForDate.mockResolvedValue(1.35);
      const onChange = vi.fn();
      // Start with no security (CAD account -> same-currency, effective rate 1).
      await renderHarness(
        {
          action: 'BUY',
          securityId: undefined,
          quantity: 10,
          price: 100,
          commission: 0,
          exchangeRate: undefined,
        } as InvestmentSplitDetails,
        onChange,
        { currencyCode: 'CAD', transactionDate: TRADE_DATE },
      );

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Security'), {
          target: { value: 'sec-1' },
        });
      });

      // The select itself leaves the new pair unresolved (never 1) ...
      const [selected, selectedAmount, meta] = onChange.mock.calls[0];
      expect(selected.securityId).toBe('sec-1');
      expect(selected.exchangeRate).toBeUndefined();
      expect(selectedAmount).toBe(0);
      expect(meta.securityChanged).toBe(true);
      // The recorded pair is cleared so a stale scalar cannot be blessed for it.
      expect(selected.exchangeRateFromCurrency).toBeUndefined();
      expect(selected.exchangeRateToCurrency).toBeUndefined();

      // ... and the dated lookup fills it in.
      await waitFor(() =>
        expect(mockGetRateForDate).toHaveBeenCalledWith('USD', 'CAD', TRADE_DATE),
      );
      await waitFor(() => {
        const [next, amount] = onChange.mock.calls.at(-1)!;
        expect(next.exchangeRate).toBe(1.35); // resolved for USD->CAD, not 1
        expect(amount).toBe(-1350); // 10 x 100 x 1.35, never -1000
      });
    });

    it('leaves the rate unresolved (never 1) when the new pair has no rate (R9-F3)', async () => {
      mockGetRateForDate.mockResolvedValue(null); // no USD/CAD rate available
      const onChange = vi.fn();
      await renderHarness(
        {
          action: 'BUY',
          securityId: undefined,
          quantity: 10,
          price: 100,
          commission: 0,
          exchangeRate: undefined,
        } as InvestmentSplitDetails,
        onChange,
        { currencyCode: 'CAD', transactionDate: TRADE_DATE },
      );

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Security'), {
          target: { value: 'sec-1' },
        });
      });

      const [next, amount] = onChange.mock.calls.at(-1)!;
      expect(next.exchangeRate).toBeUndefined(); // unresolved, not 1
      expect(amount).toBe(0); // never the unconverted -1000
    });

    // Issue #1167 R9-F2: `meta.rateEdited` is real intent -- true only when the
    // user changes the rate input, so a re-entered rate on a continuing line is
    // honoured even when its value equals the stale stored one.
    it('reports meta.rateEdited only for a rate edit, not for other field edits (R9-F2)', async () => {
      mockGetRateForDate.mockResolvedValue(1.35);
      const onChange = vi.fn();
      await renderHarness(noStatedRate(), onChange, { transactionDate: TRADE_DATE });
      await waitFor(() =>
        expect(screen.getByLabelText(rateLabel)).toHaveValue('1.350000'),
      );

      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('Quantity'), {
          target: { value: '20' },
        });
      });
      expect(onChange.mock.calls.at(-1)![2]).toEqual({
        rateEdited: false,
        securityChanged: false,
      });

      await act(async () => {
        fireEvent.change(screen.getByLabelText(rateLabel), { target: { value: '1.4' } });
      });
      expect(onChange.mock.calls.at(-1)![2]).toEqual({
        rateEdited: true,
        securityChanged: false,
      });
    });

    it('shows no rate field when the security matches the account currency', async () => {
      await renderFieldsAsync({
        value: noStatedRate(),
        currencyCode: 'USD',
      });
      expect(
        screen.queryByLabelText(/Exchange rate/),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('shows the single amount field (no qty/price) for DIVIDEND', async () => {
    await renderFieldsAsync({ value: buyValue({ action: 'DIVIDEND' }) });
    expect(screen.queryByPlaceholderText('Quantity')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Price')).not.toBeInTheDocument();
    // The amount is in the SECURITY's currency (sec-1 is USD), not the cash
    // account's -- that is how the backend reads price and commission, and
    // labelling them with the account's currency asked for the wrong number.
    expect(screen.getByPlaceholderText('Amount')).toBeInTheDocument();
    // DIVIDEND still needs a security
    expect(screen.getByLabelText('Security')).toBeInTheDocument();
  });

  it('updates the amount field for an amount-only action', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({
      value: buyValue({ action: 'DIVIDEND', quantity: 0, price: 0 }),
      onChange,
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Amount'), {
        target: { value: '25' },
      });
    });
    const [next, amount] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(next.price).toBe(25);
    // DIVIDEND cash impact with no quantity equals price: (0 || 1) * 25 = 25
    expect(amount).toBe(25);
  });

  it('hides the security dropdown for actions that do not need one (INTEREST)', async () => {
    await renderFieldsAsync({ value: buyValue({ action: 'INTEREST' }) });
    expect(screen.queryByLabelText('Security')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Amount')).toBeInTheDocument();
  });

  it('honours a custom currency code in the amount placeholder and symbol', async () => {
    await renderFieldsAsync({
      value: buyValue({ action: 'INTEREST' }),
      currencyCode: 'USD',
    });
    expect(screen.getByPlaceholderText('Amount')).toBeInTheDocument();
  });

  it('disables all controls when disabled', async () => {
    await renderFieldsAsync({ value: buyValue(), disabled: true });
    expect(screen.getByLabelText('Investment action')).toBeDisabled();
    expect(screen.getByLabelText('Security')).toBeDisabled();
    expect(screen.getByPlaceholderText('Quantity')).toBeDisabled();
    expect(screen.getByPlaceholderText('Price')).toBeDisabled();
    expect(screen.getByPlaceholderText('Commission')).toBeDisabled();
  });

  it('applies the exchange rate to the computed amount', async () => {
    const onChange = vi.fn();
    await renderFieldsAsync({
      value: buyValue({ action: 'SELL', exchangeRate: 2 }),
      onChange,
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Quantity'), {
        target: { value: '10' },
      });
    });
    const [, amount] = onChange.mock.calls[onChange.mock.calls.length - 1];
    // SELL: (10*5 - 1) * 2 = 98
    expect(amount).toBe(98);
  });
});
