import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { MatchTraceView } from './MatchTraceView';
import type { ReceiptMatchTrace } from '@/types/email-receipts';

const trace = (over: Partial<ReceiptMatchTrace> = {}): ReceiptMatchTrace => ({
  window: { from: '2026-03-07', to: '2026-03-24' },
  daysBefore: 3,
  daysAfter: 14,
  toleranceUnits: 0,
  referenceIn: ['description'],
  by: ['reference', 'amount_payee'],
  considered: 3,
  attempts: [
    {
      strategy: 'reference',
      count: 1,
      transactions: [{ id: 't1', date: '2026-03-12', amount: -50.4, payeeName: 'Shop' }],
    },
  ],
  decidedBy: 'reference',
  ...over,
});

describe('MatchTraceView', () => {
  it('says the window and how many transactions it held', () => {
    render(<MatchTraceView trace={trace()} />);
    expect(screen.getByText(/3 days before, 14 days after the purchase\): 3 considered/)).toBeInTheDocument();
  });

  it('lists each strategy in the order tried, what it kept and which one decided', () => {
    render(<MatchTraceView trace={trace()} />);
    expect(screen.getByText('1. Reference')).toBeInTheDocument();
    expect(screen.getByText('kept 1 transaction')).toBeInTheDocument();
    expect(screen.getByText('Decided')).toBeInTheDocument();
    expect(screen.getByText(/-\$50\.40, Shop/)).toBeInTheDocument();
  });

  it('says a strategy kept none, and does not mark one as deciding when none did', () => {
    render(
      <MatchTraceView
        trace={trace({
          decidedBy: null,
          attempts: [
            { strategy: 'reference', count: 0, transactions: [] },
            { strategy: 'amount_payee', count: 0, transactions: [] },
          ],
        })}
      />,
    );
    expect(screen.getAllByText('kept none')).toHaveLength(2);
    expect(screen.queryByText('Decided')).not.toBeInTheDocument();
  });

  it('names the tolerance only when there is one', () => {
    const { rerender } = render(<MatchTraceView trace={trace()} />);
    expect(screen.queryByText(/may differ by/)).not.toBeInTheDocument();
    // 5000 units is 0.50: the 1/10000 scale is undone once.
    rerender(<MatchTraceView trace={trace({ toleranceUnits: 5000 })} />);
    expect(screen.getByText(/The amount may differ by \$0\.50/)).toBeInTheDocument();
  });

  it('says a transaction has no payee', () => {
    render(
      <MatchTraceView
        trace={trace({ attempts: [{ strategy: 'amount_date', count: 1, transactions: [{ id: 't', date: '2026-03-12', amount: -1, payeeName: null }] }] })}
      />,
    );
    expect(screen.getByText(/no payee/)).toBeInTheDocument();
  });
});
