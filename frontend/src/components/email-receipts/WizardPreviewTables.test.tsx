import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { WizardPreviewTables } from './WizardPreviewTables';
import type { ParserPreviewItem, ParserPreviewResult } from '@/types/email-receipts';

const item = (over: Partial<ParserPreviewItem> = {}): ParserPreviewItem => ({
  receiptId: 'r-1',
  subject: 'Your order has been filled',
  receivedAt: '2026-10-15T16:10:19.000Z',
  effectiveDate: '2026-10-15T16:10:19.000Z',
  outcome: 'trade',
  statusReason: null,
  trade: { action: 'BUY', symbol: 'XCNS', quantity: 75.9878, consistent: true },
  parsed: { date: '2026-10-15', total: 2000, currency: null, lineCount: 0 },
  match: null,
  expected: null,
  agrees: null,
  ...over,
});

const result = (over: Partial<ParserPreviewResult> = {}): ParserPreviewResult => ({
  selected: [],
  others: [],
  othersTotal: 0,
  ...over,
});

describe('WizardPreviewTables of a trade profile', () => {
  it('shows the trade each email reports, with the total as a plain number, and no line count', () => {
    render(<WizardPreviewTables kind="trade" result={result({ selected: [item()] })} />);
    const row = screen.getByRole('row', { name: /Your order has been filled/ });
    expect(within(row).getByText('Buys 75.9878 shares of XCNS')).toBeInTheDocument();
    expect(within(row).getByText('Total: 2,000.00')).toBeInTheDocument();
    expect(within(row).queryByText(/lines?$/)).not.toBeInTheDocument();
  });

  it('says how each trade sample would end instead of an expectation it cannot have, so an unreadable one is not a success', () => {
    render(
      <WizardPreviewTables kind="trade"
        result={result({
          selected: [
            item(),
            item({
              receiptId: 'r-9',
              subject: 'No account named',
              outcome: 'parse_failed',
              statusReason: 'trade_no_account',
            }),
            item({ receiptId: 'r-8', subject: 'Booked already', outcome: 'trade_exists' }),
          ],
        })}
      />,
    );
    expect(screen.queryByRole('columnheader', { name: 'Expected' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Outcome' })).toBeInTheDocument();
    const failed = screen.getByRole('row', { name: /No account named/ });
    expect(within(failed).getByText('Could not be read')).toBeInTheDocument();
    expect(within(failed).getByText('The profile could not tell which account this trade is for.')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Booked already/ })).getByText('Already in your ledger')).toBeInTheDocument();
  });

  it('says a trade whose price does not fit the total will not auto-apply', () => {
    render(
      <WizardPreviewTables kind="trade"
        result={result({ selected: [item({ trade: { action: 'SELL', symbol: 'XCNS', quantity: 10, consistent: false } })] })}
      />,
    );
    expect(screen.getByText('Sells 10 shares of XCNS')).toBeInTheDocument();
    expect(screen.getByText('The price does not match the total, so it will not be applied automatically')).toBeInTheDocument();
  });

  it('shows a cash dividend that states no share count, and a reinvested dividend with its shares', () => {
    render(
      <WizardPreviewTables kind="trade"
        result={result({
          selected: [
            item({
              receiptId: 'r-4',
              subject: 'Dividend paid',
              trade: { action: 'DIVIDEND', symbol: 'XCNS', quantity: null, consistent: null },
              parsed: { date: '2026-10-15', total: 12.34, currency: null, lineCount: 0 },
            }),
            item({
              receiptId: 'r-5',
              subject: 'Dividend reinvested',
              trade: { action: 'REINVEST', symbol: 'XCNS', quantity: 0.4688, consistent: true },
              parsed: { date: '2026-10-15', total: 12.34, currency: null, lineCount: 0 },
            }),
          ],
        })}
      />,
    );
    const dividend = screen.getByRole('row', { name: /Dividend paid/ });
    expect(within(dividend).getByText('Pays a dividend from XCNS')).toBeInTheDocument();
    expect(within(dividend).getByText('Total: 12.34')).toBeInTheDocument();
    expect(within(dividend).queryByText('Nothing could be read')).not.toBeInTheDocument();
    const reinvest = screen.getByRole('row', { name: /Dividend reinvested/ });
    expect(within(reinvest).getByText('Reinvests a dividend in 0.4688 shares of XCNS')).toBeInTheDocument();
  });

  it('says nothing was read of a buy that states no share count', () => {
    render(
      <WizardPreviewTables kind="trade"
        result={result({ selected: [item({ trade: { action: 'BUY', symbol: 'XCNS', quantity: null, consistent: null } })] })}
      />,
    );
    expect(screen.getByText('Nothing could be read')).toBeInTheDocument();
    expect(screen.queryByText(/XCNS/)).not.toBeInTheDocument();
  });

  it('labels the outcome and names why an incomplete trade could not be read', () => {
    render(
      <WizardPreviewTables kind="trade"
        result={result({
          others: [
            item({ receiptId: 'r-2', subject: 'Filled A' }),
            item({
              receiptId: 'r-3',
              subject: 'Filled B',
              outcome: 'parse_failed',
              statusReason: 'trade_no_symbol',
              trade: { action: 'BUY', symbol: null, quantity: 5, consistent: null },
              parsed: { date: '2026-10-15', total: null, currency: null, lineCount: 0 },
            }),
          ],
          othersTotal: 2,
        })}
      />,
    );
    expect(within(screen.getByRole('row', { name: /Filled A/ })).getByText('Proposes a trade')).toBeInTheDocument();
    const failed = screen.getByRole('row', { name: /Filled B/ });
    expect(within(failed).getByText('Could not be read')).toBeInTheDocument();
    expect(within(failed).getByText('The profile found no ticker symbol in this email.')).toBeInTheDocument();
    expect(within(failed).getByText('Nothing could be read')).toBeInTheDocument();
  });

  it('keeps the trade columns for a sample a guard stopped before any reading (no trade sent)', () => {
    render(
      <WizardPreviewTables
        kind="trade"
        result={result({
          selected: [
            item(),
            item({ receiptId: 'r-5', subject: 'Too large', outcome: 'not_applicable', statusReason: null, trade: null, parsed: null }),
          ],
        })}
      />,
    );
    expect(screen.queryByRole('columnheader', { name: 'Expected transaction' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Agrees' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Outcome' })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Too large/ })).getByText('Nothing could be read')).toBeInTheDocument();
  });

  it('names the account each sample books to with its currency, and the trade\'s currency', () => {
    const accounts = new Map([
      ['acc-cad', { name: 'RRSP', currencyCode: 'CAD' }],
      ['acc-usd', { name: 'RRSP', currencyCode: 'USD' }],
    ]);
    render(
      <WizardPreviewTables
        kind="trade"
        accounts={accounts}
        result={result({
          selected: [
            item({ trade: { action: 'BUY', symbol: 'XCNS', quantity: 75.9878, consistent: true, accountId: 'acc-cad', currency: 'CAD' } }),
            item({
              receiptId: 'r-2',
              subject: 'US fill',
              trade: { action: 'BUY', symbol: 'VTI', quantity: 3, consistent: true, accountId: 'acc-usd', currency: 'USD' },
              parsed: { date: '2026-10-15', total: 900, currency: 'USD', lineCount: 0 },
            }),
            item({
              receiptId: 'r-3',
              subject: 'No account',
              outcome: 'parse_failed',
              statusReason: 'trade_no_account',
              trade: { action: 'BUY', symbol: 'XCNS', quantity: 1, consistent: null, accountId: null, currency: null },
            }),
          ],
        })}
      />,
    );
    const cad = screen.getByRole('row', { name: /Your order has been filled/ });
    expect(within(cad).getByText('Account: RRSP (CAD)')).toBeInTheDocument();
    expect(within(cad).getByText('Currency: CAD')).toBeInTheDocument();
    const usd = screen.getByRole('row', { name: /US fill/ });
    expect(within(usd).getByText('Account: RRSP (USD)')).toBeInTheDocument();
    expect(within(usd).getByText('Currency: USD')).toBeInTheDocument();
    const none = screen.getByRole('row', { name: /No account/ });
    expect(within(none).getByText('No account found for this trade')).toBeInTheDocument();
    expect(within(none).getByText('Currency: not stated')).toBeInTheDocument();
  });

  it('says the account is unknown, never blank, while the accounts are not known', () => {
    render(
      <WizardPreviewTables
        kind="trade"
        result={result({
          selected: [item({ trade: { action: 'BUY', symbol: 'XCNS', quantity: 1, consistent: true, accountId: 'acc-cad', currency: 'CAD' } })],
        })}
      />,
    );
    expect(screen.getByText('Account: unknown')).toBeInTheDocument();
  });
});

describe('WizardPreviewTables of a component profile', () => {
  it('labels a purchase email as waiting for its repayment, and names a missing link key', () => {
    render(
      <WizardPreviewTables
        kind="receipt"
        result={result({
          others: [
            item({ subject: 'Order A', outcome: 'component', trade: null }),
            item({ receiptId: 'r-2', subject: 'Order B', outcome: 'parse_failed', statusReason: 'no_link_key', trade: null }),
          ],
        })}
      />,
    );
    expect(within(screen.getByRole('row', { name: /Order A/ })).getByText('Purchase email (waits for repayment)')).toBeInTheDocument();
    const failed = screen.getByRole('row', { name: /Order B/ });
    expect(within(failed).getByText('Could not be read')).toBeInTheDocument();
    expect(within(failed).getByText(/holds no link key/)).toBeInTheDocument();
  });
});
