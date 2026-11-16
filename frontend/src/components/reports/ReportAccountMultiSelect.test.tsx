import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { ReportAccountMultiSelect } from './ReportAccountMultiSelect';
import { Account } from '@/types/account';

// A real linked pair: the two halves point at each other, which is what makes
// them one account rather than two rows that happen to share a base name.
const accounts = [
  { id: 'a1', name: 'TFSA - Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', linkedAccountId: 'a2' },
  { id: 'a2', name: 'TFSA - Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', linkedAccountId: 'a1' },
  { id: 'a3', name: 'RRSP', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', linkedAccountId: null },
] as unknown as Account[];

describe('ReportAccountMultiSelect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the All Accounts placeholder, strips name suffixes, and excludes brokerage by default', () => {
    render(<ReportAccountMultiSelect accounts={accounts} value={[]} onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Filter by account' });
    expect(trigger).toHaveTextContent('All Accounts');

    fireEvent.click(trigger);
    // Cash sub-accounts are offered with the suffix stripped; the brokerage
    // sub-account is excluded by the default filter.
    expect(screen.getByText('TFSA')).toBeInTheDocument();
    expect(screen.getByText('RRSP')).toBeInTheDocument();
    expect(screen.queryByText('TFSA - Brokerage')).not.toBeInTheDocument();
  });

  it('lists favourites first, in their arrangement, then the rest alphabetically, with a rule between', () => {
    const mixed = [
      { id: 'c1', name: 'Zeta Chequing', accountType: 'CHEQUING', isFavourite: false, favouriteSortOrder: 0 },
      { id: 'c2', name: 'Beta Savings', accountType: 'SAVINGS', isFavourite: true, favouriteSortOrder: 2 },
      { id: 'c3', name: 'Alpha Card', accountType: 'CREDIT_CARD', isFavourite: false, favouriteSortOrder: 0 },
      { id: 'c4', name: 'Yankee Chequing', accountType: 'CHEQUING', isFavourite: true, favouriteSortOrder: 1 },
    ] as unknown as Account[];
    render(<ReportAccountMultiSelect accounts={mixed} value={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));

    const rows = screen.getAllByRole('checkbox').map((box) => box.closest('label')!);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Yankee Chequing',
      'Beta Savings',
      'Alpha Card',
      'Zeta Chequing',
    ]);
    // The first non-favourite opens its own group.
    expect(rows[2].className).toContain('border-t');
    expect(rows[1].className).not.toContain('border-t');
  });

  it('draws no rule when nothing is a favourite', () => {
    render(<ReportAccountMultiSelect accounts={accounts} value={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    const rows = screen.getAllByRole('checkbox').map((box) => box.closest('label')!);
    expect(rows.some((row) => row.className.includes('border-t'))).toBe(false);
  });

  it('reflects a toggle immediately but debounces the onChange notification', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<ReportAccountMultiSelect accounts={accounts} value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    fireEvent.click(screen.getByText('RRSP'));

    // The trigger reflects the selection right away, but the host report is not
    // notified until the debounce window elapses.
    expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent('RRSP');
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['a3']);
  });

  it('keeps the dropdown open across rapid toggles and collapses them into one onChange', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<ReportAccountMultiSelect accounts={accounts} value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));

    fireEvent.click(screen.getByText('RRSP'));
    fireEvent.click(screen.getByText('TFSA'));

    // The portal dropdown is still mounted (options remain queryable) between
    // checkbox clicks, so the user can keep selecting without re-opening it.
    expect(screen.getByText('Select All')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['a3', 'a2']);
  });

  it('cancels a pending debounce when the parent pushes an external value change', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(
      <ReportAccountMultiSelect accounts={accounts} value={[]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    fireEvent.click(screen.getByText('RRSP'));

    // Before the 350ms debounce elapses, the parent resets the selection
    // externally. The pending (now stale) onChange must NOT fire afterwards.
    rerender(<ReportAccountMultiSelect accounts={accounts} value={[]} onChange={onChange} />);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('adopts an external value reset', async () => {
    const { rerender } = render(
      <ReportAccountMultiSelect accounts={accounts} value={['a3']} onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent('RRSP');

    rerender(<ReportAccountMultiSelect accounts={accounts} value={[]} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent(
        'All Accounts',
      );
    });
  });

  // The two modes offer the same account under the same name; what differs is
  // only the id they submit. Expressed as opposite filters, as it used to be,
  // two identical-looking pickers quietly reported different accounts.
  it('offers a pair once in either mode, under the name the user gave it', () => {
    const { unmount } = render(
      <ReportAccountMultiSelect accounts={accounts} value={[]} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    expect(screen.getAllByText('TFSA')).toHaveLength(1);
    unmount();

    render(
      <ReportAccountMultiSelect
        accounts={accounts}
        value={[]}
        onChange={() => {}}
        mode="portfolio"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    expect(screen.getAllByText('TFSA')).toHaveLength(1);
  });

  it('submits the cash ledger id for a transaction report', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(
      <ReportAccountMultiSelect accounts={accounts} value={[]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    fireEvent.click(screen.getByText('TFSA'));

    act(() => { vi.advanceTimersByTime(400); });
    expect(onChange).toHaveBeenCalledWith(['a2']);
  });

  it('submits the holdings id for a portfolio report', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(
      <ReportAccountMultiSelect
        accounts={accounts}
        value={[]}
        onChange={onChange}
        mode="portfolio"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    fireEvent.click(screen.getByText('TFSA'));

    act(() => { vi.advanceTimersByTime(400); });
    expect(onChange).toHaveBeenCalledWith(['a1']);
  });

  // An orphan cash half holds no securities, so a portfolio report has no id
  // to submit for it and does not pretend otherwise.
  it('omits an account with no ledger for the mode', () => {
    render(
      <ReportAccountMultiSelect
        accounts={accounts}
        value={[]}
        onChange={() => {}}
        mode="portfolio"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    expect(screen.queryByText('RRSP')).not.toBeInTheDocument();
  });
});
