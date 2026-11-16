import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { TradeReadingView } from './TradeReadingView';
import { PARSED_DIVIDEND, PARSED_TRADE } from './email-receipts-fixtures';
import { readParsedTrade } from '@/types/email-receipts';

const trade = (over: Record<string, unknown> = {}) => {
  const read = readParsedTrade({ ...PARSED_TRADE, ...over });
  if (read === null) throw new Error('fixture is not a trade');
  return read;
};

describe('TradeReadingView', () => {
  it('says what the profile read, the total divided by 10000', () => {
    render(<TradeReadingView trade={trade()} fallbackDate="2026-10-16T00:00:00.000Z" />);
    expect(screen.getByText(/Buy 75\.9878 shares of XCNS for 2,000\.00, dated /)).toBeInTheDocument();
    expect(screen.getByText('Account named in the email: RRSP')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('reads a sell', () => {
    render(<TradeReadingView trade={trade({ action: 'SELL' })} fallbackDate={null} />);
    expect(screen.getByText(/^Sell 75\.9878 shares of XCNS/)).toBeInTheDocument();
  });

  describe('a dividend', () => {
    const dividend = (over: Record<string, unknown> = {}) => trade({ ...PARSED_DIVIDEND, ...over });

    it('reads a cash dividend with no share count as complete, with the amount paid', () => {
      render(<TradeReadingView trade={dividend()} fallbackDate={null} />);
      expect(screen.getByText(/^Dividend from XCNS of 12\.34, dated /)).toBeInTheDocument();
      expect(screen.queryByText('The profile could not read a complete trade from this email.')).not.toBeInTheDocument();
      expect(screen.queryByText(/shares/)).not.toBeInTheDocument();
      expect(screen.queryByText(/a share/)).not.toBeInTheDocument();
      // Nothing to cross-check is not a mismatch.
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('names the shares and the amount per share of a dividend that states them', () => {
      render(<TradeReadingView trade={dividend({ quantity: 100, price: 1234 })} fallbackDate={null} />);
      expect(screen.getByText(/^Dividend from XCNS of 12\.34/)).toBeInTheDocument();
      expect(screen.getByText('Paid on 100 shares')).toBeInTheDocument();
      expect(screen.getByText('Amount per share in the email: 0.1234')).toBeInTheDocument();
      expect(screen.queryByText(/Average price/)).not.toBeInTheDocument();
    });

    it('warns that an amount per share that does not fit will not be applied automatically', () => {
      render(<TradeReadingView trade={dividend({ quantity: 100, price: 9999, consistent: false })} fallbackDate={null} />);
      expect(screen.getByRole('note')).toHaveTextContent('The amount per share does not match the shares and the total');
    });

    it('reads a reinvested dividend with its shares', () => {
      render(<TradeReadingView trade={trade({ action: 'REINVEST' })} fallbackDate={null} />);
      expect(screen.getByText(/^Reinvest a dividend in 75\.9878 shares of XCNS for 2,000\.00, dated /)).toBeInTheDocument();
      expect(screen.getByText('Average price in the email: 26.3200 a share')).toBeInTheDocument();
    });

    it('still calls a buy, a sell or a reinvestment without shares incomplete', () => {
      for (const action of ['BUY', 'SELL', 'REINVEST']) {
        const { unmount } = render(
          <TradeReadingView trade={trade({ action, quantity: null, consistent: null })} fallbackDate={null} />,
        );
        expect(screen.getByText('The profile could not read a complete trade from this email.')).toBeInTheDocument();
        unmount();
      }
    });
  });

  it('dates the trade by the email when it states no date, and says so when even that is unknown', () => {
    const { rerender } = render(<TradeReadingView trade={trade({ date: null })} fallbackDate="2026-10-14T12:00:00.000Z" />);
    expect(screen.getByText(/dated .*2026|dated .*14/)).toBeInTheDocument();
    rerender(<TradeReadingView trade={trade({ date: null })} fallbackDate={null} />);
    expect(screen.getByText(/dated the day the email arrived\./)).toBeInTheDocument();
  });

  it('says the total is implied by the price when the email states none', () => {
    render(<TradeReadingView trade={trade({ total: null, consistent: null })} fallbackDate={null} />);
    expect(screen.getByText(/for the total implied by the price/)).toBeInTheDocument();
  });

  it('warns that a price that does not fit will not be applied automatically', () => {
    render(<TradeReadingView trade={trade({ consistent: false })} fallbackDate={null} />);
    expect(screen.getByRole('note')).toHaveTextContent('will not be applied automatically');
  });

  it('shows no account line when the email names none', () => {
    render(<TradeReadingView trade={trade({ accountText: null })} fallbackDate={null} />);
    expect(screen.queryByText(/Account named in the email/)).not.toBeInTheDocument();
  });

  it('shows the price the email states, and money in the currency the email names', () => {
    const { rerender } = render(<TradeReadingView trade={trade()} fallbackDate={null} />);
    expect(screen.getByText('Average price in the email: 26.3200 a share')).toBeInTheDocument();
    rerender(<TradeReadingView trade={trade({ currency: 'USD' })} fallbackDate={null} />);
    expect(screen.getByText(/for \$2,000\.00, dated/)).toBeInTheDocument();
  });

  it('names the reason of an incomplete reading only where it is asked to', () => {
    const incomplete = trade({ complete: false, accountId: null, reason: 'trade_no_account' });
    const { rerender } = render(<TradeReadingView trade={incomplete} fallbackDate={null} />);
    expect(screen.queryByText(/account/i)).not.toBeInTheDocument();
    rerender(<TradeReadingView trade={incomplete} fallbackDate={null} showReason />);
    expect(screen.getByText('The profile could not tell which account this trade is for.')).toBeInTheDocument();
    // What the account rules were tried against.
    expect(screen.getByText('Account named in the email: RRSP')).toBeInTheDocument();
  });

  it('says a rule needed the currency and nothing named it', () => {
    const incomplete = trade({ complete: false, accountId: null, reason: 'trade_no_currency' });
    render(<TradeReadingView trade={incomplete} fallbackDate={null} showReason />);
    expect(screen.getByText(/could not tell which currency/)).toBeInTheDocument();
  });

  it('says the currency and where it came from', () => {
    const { rerender } = render(
      <TradeReadingView trade={trade({ currency: 'USD', currencySource: 'amount' })} fallbackDate={null} />,
    );
    expect(screen.getByText('Currency: USD, named by the amount')).toBeInTheDocument();
    rerender(<TradeReadingView trade={trade({ currency: 'USD', currencySource: 'marker' })} fallbackDate={null} />);
    expect(screen.getByText('Currency: USD, from a currency marker of the profile')).toBeInTheDocument();
    rerender(<TradeReadingView trade={trade({ currency: 'CAD', currencySource: 'security' })} fallbackDate={null} />);
    expect(screen.getByText('Currency: CAD, from your security for the ticker')).toBeInTheDocument();
    // A server that predates the source says no line.
    rerender(<TradeReadingView trade={trade({ currency: 'USD' })} fallbackDate={null} />);
    expect(screen.queryByText(/^Currency:/)).not.toBeInTheDocument();
  });

  describe('the account the profile chose', () => {
    const accounts = [
      { value: 'acc-rrsp', label: 'RRSP USD', currencyCode: 'USD', tradable: true },
      { value: 'acc-chq', label: 'Chequing', currencyCode: 'CAD', tradable: false },
    ];

    it('is named', () => {
      render(<TradeReadingView trade={trade()} fallbackDate={null} accounts={accounts} />);
      expect(screen.getByText('Books to: RRSP USD (USD)')).toBeInTheDocument();
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('is flagged when it is not an open brokerage account, or not one of yours', () => {
      const { rerender } = render(
        <TradeReadingView trade={trade({ accountId: 'acc-chq' })} fallbackDate={null} accounts={accounts} />,
      );
      expect(screen.getByRole('note')).toHaveTextContent('Chequing, which is not an open brokerage account');
      rerender(<TradeReadingView trade={trade({ accountId: 'acc-gone' })} fallbackDate={null} accounts={accounts} />);
      expect(screen.getByRole('note')).toHaveTextContent('an account that is not in your list');
    });

    it('is not shown without the account list', () => {
      render(<TradeReadingView trade={trade()} fallbackDate={null} />);
      expect(screen.queryByText(/Books to/)).not.toBeInTheDocument();
    });
  });

  it('says nothing was read rather than inventing a sentence from an incomplete reading', () => {
    render(
      <TradeReadingView trade={trade({ complete: false, symbol: null, reason: 'trade_no_symbol' })} fallbackDate={null} />,
    );
    expect(screen.getByText('The profile could not read a complete trade from this email.')).toBeInTheDocument();
  });
});

describe('readParsedTrade', () => {
  it('reads what the API stores', () => {
    expect(readParsedTrade(PARSED_TRADE)).toEqual({ ...PARSED_TRADE, currencySource: null });
  });

  it('reads where the currency came from, and an unknown source as none', () => {
    expect(readParsedTrade({ ...PARSED_TRADE, currency: 'USD', currencySource: 'marker' })?.currencySource).toBe('marker');
    expect(readParsedTrade({ ...PARSED_TRADE, currency: 'USD', currencySource: 'guess' })?.currencySource).toBeNull();
  });

  it('reads every action a trade email reports, and a dividend with no share count', () => {
    for (const action of ['BUY', 'SELL', 'DIVIDEND', 'REINVEST', null]) {
      expect(readParsedTrade({ ...PARSED_TRADE, action })?.action).toBe(action);
    }
    expect(readParsedTrade(PARSED_DIVIDEND)).toEqual({ ...PARSED_DIVIDEND, currencySource: null });
  });

  it.each([
    ['nothing', null],
    ['an unknown direction', { ...PARSED_TRADE, action: 'HOLD' }],
    ['a string quantity', { ...PARSED_TRADE, quantity: '75' }],
    ['a missing complete flag', { ...PARSED_TRADE, complete: undefined }],
    ['a non-boolean consistent', { ...PARSED_TRADE, consistent: 'yes' }],
  ])('refuses %s', (_why, value) => {
    expect(readParsedTrade(value as Record<string, unknown> | null)).toBeNull();
  });
});
